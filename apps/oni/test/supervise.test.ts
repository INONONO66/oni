import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core } from "@oni/agent";
import { Machine } from "@oni/protocol";
import { z } from "zod";
import { deployClient, hostClient, hostEndpoint, releaseVersion, requestSupervisor, startSupervisor, supervise, type Supervisor } from "../src/cli/supervise";
import type { SuperviseAnswer } from "../src/cli/supervise-wire";

/**
 * The supervisor end to end (#1699): real host processes spawned from release
 * directories, a real unix socket, and real SQLite catalog and session files
 * that each host commits a row into under the catalog owner lock. Every wait
 * is an event the fake host reports to the probe server; nothing sleeps.
 */
const OWNER_LOCK = join(import.meta.dir, "../../../packages/agent/src/core/session/owner-lock.ts");
const TOKEN = "supervise-test-token";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const ProbeBody = z.object({ version: z.string(), pid: z.number().int() });
type Probe = z.infer<typeof ProbeBody> & { readonly name: string };

/**
 * The test's side of the fake hosts: every host event lands here, and the
 * scenario's `answer` decides the reply (the version a `--version` probe
 * prints, or when a held drain returns).
 */
function probeServer(answer: (probe: Probe) => Promise<string> | string) {
  const events: Probe[] = [];
  const waiters: { readonly match: (probe: Probe) => boolean; readonly resolve: (probe: Probe) => void }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const name = new URL(request.url).pathname.slice(1);
      const probe = { name, ...ProbeBody.parse(await request.json()) };
      events.push(probe);
      for (const waiter of waiters.filter((entry) => entry.match(probe))) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(probe);
      }
      return new Response(await answer(probe));
    },
  });
  cleanups.push(() => server.stop(true));
  const where = (match: (probe: Probe) => boolean): Promise<Probe> => {
    const seen = events.find(match);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve) => waiters.push({ match, resolve }));
  };
  const next = (name: string, version: string) => where((probe) => probe.name === name && probe.version === version);
  return { url: `http://127.0.0.1:${server.port}`, events, next, where };
}

function writeRelease(dir: string, version: string, mode: "serve" | "fail", settings: object): string {
  mkdirSync(join(dir, "dist", "app"), { recursive: true });
  writeFileSync(join(dir, "dist", "app", "main.js"), `
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireOwnerLock } from ${JSON.stringify(OWNER_LOCK)};
const VERSION = ${JSON.stringify(version)};
const env = ${JSON.stringify(settings)};
const probe = (name) => fetch(env.probe + "/" + name, { method: "POST", body: JSON.stringify({ version: VERSION, pid: process.pid }) }).then((r) => r.text());
if (process.argv[2] === "--version") {
  console.log(await probe("version"));
  process.exit(0);
}
acquireOwnerLock(env.catalogPath, "oni:" + process.pid);
const commit = (path) => {
  const db = new Database(path);
  db.run("create table if not exists turns (version text not null)");
  db.run("insert into turns values (?)", [VERSION]);
  db.close();
};
commit(env.catalogPath);
mkdirSync(env.sessionsDir, { recursive: true });
commit(join(env.sessionsDir, "s1.sqlite"));
if (${JSON.stringify(mode)} === "fail") process.exit(3);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGUSR1", () => probe("exiting").then(() => process.exit(7)));
const instanceId = ("01" + VERSION.replaceAll(".", "") + "X".repeat(26)).slice(0, 26);
let state = "open";
Bun.serve({
  hostname: "127.0.0.1",
  port: env.port,
  async fetch(request) {
    if (request.headers.get("authorization") !== "Bearer " + env.token) return new Response("", { status: 401 });
    const path = new URL(request.url).pathname;
    if (path === "/status") return Response.json({ version: VERSION, instanceId, contractVersion: env.contractVersion, capabilities: { drainRestart: true }, state });
    state = "draining";
    await probe("drain");
    setImmediate(() => process.exit(0));
    return Response.json({ drained: true, inFlight: 0, projectionsIdle: true });
  },
});
await probe("started");
`);
  return dir;
}

const instanceOf = (version: string) => `01${version.replaceAll(".", "")}${"X".repeat(26)}`.slice(0, 26);

function freePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("no free port");
  return port;
}

const rows = (path: string): string[] => {
  const db = new Database(path, { readonly: true });
  try {
    return db.query<{ version: string }, []>("select version from turns").all().map((row) => row.version);
  } finally {
    db.close();
  }
};

const gone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

function installation(answer: (probe: Probe) => Promise<string> | string, candidate: "serve" | "fail" = "serve") {
  const home = mkdtempSync(join(tmpdir(), "oni-sup-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, ".oni");
  const probes = probeServer(answer);
  const port = freePort();
  const storage = { catalogPath: join(root, "catalog.sqlite"), sessionsDir: join(root, "sessions") };
  const settings = { ...storage, port, token: TOKEN, probe: probes.url, contractVersion: Machine.contractVersion };
  const previous = writeRelease(join(root, "releases", "oni-0.1.0"), "0.1.0", "serve", settings);
  const next = writeRelease(join(root, "releases", "oni-0.2.0"), "0.2.0", candidate, settings);
  symlinkSync(previous, join(root, "current"));
  const supervisor: Supervisor = startSupervisor({
    home,
    bunPath: process.execPath,
    selfEntry: join(previous, "dist", "app", "main.js"),
    config: { host: "0.0.0.0", wsPort: port, wsToken: TOKEN, ...storage, entityIdleMs: undefined },
  });
  cleanups.push(supervisor.stop);
  const deploy = (): Promise<SuperviseAnswer> =>
    requestSupervisor(join(root, "supervise.sock"), {
      op: "deploy",
      artifact: next,
      targetVersion: "0.2.0",
      graceMs: 5_000,
      token: readFileSync(join(root, "supervise.token"), "utf8"),
    });
  return { root, previous, next, probes, storage, supervisor, deploy };
}

const versionAnswer = (probe: Probe): string => probe.version;

test("a deploy through the socket replaces the host and keeps every committed row", async () => {
  const { root, next, probes, storage, supervisor, deploy } = installation(versionAnswer);
  const old = await probes.next("started", "0.1.0");
  expect(await deploy()).toEqual({ ok: true, instanceId: instanceOf("0.2.0") });
  const candidate = await probes.next("started", "0.2.0");
  expect(gone(old.pid)).toBe(true);
  expect(readlinkSync(join(root, "current"))).toBe(next);
  expect(rows(storage.catalogPath)).toEqual(["0.1.0", "0.2.0"]);
  expect(rows(join(storage.sessionsDir, "s1.sqlite"))).toEqual(["0.1.0", "0.2.0"]);
  expect(rows(join(root, "deploy-snapshot", "catalog.sqlite"))).toEqual(["0.1.0"]);
  expect(Core.ownersSince(storage.catalogPath, 0)).toEqual([`oni:${old.pid}`, `oni-deploy:${process.pid}`, `oni:${candidate.pid}`]);
  supervisor.stop();
  expect(await supervisor.done).toBe(0);
  expect(gone(candidate.pid)).toBe(true);
  expect(existsSync(join(root, "supervise.sock"))).toBe(false);
});

test("a candidate that dies is stopped, its rows rolled back and the previous release restarted", async () => {
  const { root, previous, probes, storage, supervisor, deploy } = installation(versionAnswer, "fail");
  const old = await probes.next("started", "0.1.0");
  expect(await deploy()).toEqual({ ok: false, class: "candidate_failed", step: "start" });
  expect(readlinkSync(join(root, "current"))).toBe(previous);
  const restarted = await probes.where((probe) => probe.name === "started" && probe.version === "0.1.0" && probe.pid !== old.pid);
  expect(restarted.version).toBe("0.1.0");
  expect(rows(storage.catalogPath)).toEqual(["0.1.0", "0.1.0"]);
  expect(rows(join(storage.sessionsDir, "s1.sqlite"))).toEqual(["0.1.0", "0.1.0"]);
  supervisor.stop();
  expect(await supervisor.done).toBe(0);
  expect(gone(restarted.pid)).toBe(true);
});

test("reload chooses the newest staged release and replaces the running host", async () => {
  const { root, previous, next, probes, supervisor } = installation(versionAnswer);
  utimesSync(previous, 100, 100);
  utimesSync(next, 200, 200);
  await probes.next("started", "0.1.0");
  expect(await requestSupervisor(join(root, "supervise.sock"), { op: "reload" })).toEqual({ ok: true, instanceId: instanceOf("0.2.0") });
  expect(readlinkSync(join(root, "current"))).toBe(next);
  supervisor.stop();
  expect(await supervisor.done).toBe(0);
});

test("a failed candidate restores a missing previous release link", async () => {
  const { root, probes, supervisor, deploy } = installation(versionAnswer, "fail");
  await probes.next("started", "0.1.0");
  rmSync(join(root, "current"));
  expect(await deploy()).toEqual({ ok: false, class: "candidate_failed", step: "start" });
  expect(existsSync(join(root, "current"))).toBe(false);
  supervisor.stop();
  expect(await supervisor.done).toBe(0);
});

test("the supervise entrypoint stops its host on SIGTERM", async () => {
  const home = mkdtempSync(join(tmpdir(), "oni-supervise-entry-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, ".oni");
  const probes = probeServer(versionAnswer);
  const port = freePort();
  const storage = { catalogPath: join(root, "catalog.sqlite"), sessionsDir: join(root, "sessions") };
  const entry = writeRelease(join(root, "releases", "oni-0.1.0"), "0.1.0", "serve", {
    ...storage, port, token: TOKEN, probe: probes.url, contractVersion: Machine.contractVersion,
  });
  const originalTerm = process.listeners("SIGTERM");
  const originalInt = process.listeners("SIGINT");
  const done = supervise({
    home, bunPath: process.execPath, selfEntry: join(entry, "dist", "app", "main.js"),
    config: { host: "127.0.0.1", wsPort: port, wsToken: TOKEN, ...storage, entityIdleMs: undefined },
  });
  try {
    await probes.next("started", "0.1.0");
    process.emit("SIGTERM");
    expect(await done).toBe(0);
  } finally {
    for (const listener of process.listeners("SIGTERM")) if (!originalTerm.includes(listener)) process.removeListener("SIGTERM", listener);
    for (const listener of process.listeners("SIGINT")) if (!originalInt.includes(listener)) process.removeListener("SIGINT", listener);
  }
});

test("staging a dependency-free archive unpacks, installs offline and probes its version", async () => {
  const home = mkdtempSync(join(tmpdir(), "oni-supervise-stage-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const packageDir = join(home, "package");
  mkdirSync(join(packageDir, "dist", "app"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "oni-stage-fixture", version: "0.4.0", private: true }));
  writeFileSync(join(packageDir, "dist", "app", "main.js"), 'console.log("0.4.0");\n');
  const tgz = join(home, "fixture.tgz");
  expect(await Bun.spawn(["tar", "-czf", tgz, "-C", home, "package"], { stdout: "ignore", stderr: "inherit" }).exited).toBe(0);
  const client = deployClient(home, process.execPath, { stdout: () => undefined, stderr: () => undefined });
  const staged = await client.stage(tgz);
  expect(staged.version).toBe("0.4.0");
  expect(readFileSync(join(staged.artifact, "package.json"), "utf8")).toContain('"oni-stage-fixture"');
});

test("shutdown during the drain cancels the replacement before any snapshot or candidate", async () => {
  const held = Promise.withResolvers<string>();
  cleanups.push(() => held.resolve(""));
  const { root, previous, probes, storage, supervisor, deploy } = installation((probe) =>
    probe.name === "drain" ? held.promise : probe.version,
  );
  const old = await probes.next("started", "0.1.0");
  const answer = deploy();
  await probes.next("drain", "0.1.0");
  supervisor.stop();
  expect(await supervisor.done).toBe(0);
  expect(await answer).toEqual({ ok: false, class: "cancelled", step: "drain" });
  expect(gone(old.pid)).toBe(true);
  expect(probes.events.filter((probe) => probe.version === "0.2.0").map((probe) => probe.name)).toEqual(["version"]);
  expect(existsSync(join(root, "deploy-snapshot"))).toBe(false);
  expect(readlinkSync(join(root, "current"))).toBe(previous);
  expect(rows(storage.catalogPath)).toEqual(["0.1.0"]);
});

test("a host exit during the version check reaches the service manager once the check refuses", async () => {
  const exiting = Promise.withResolvers<void>();
  const { probes, supervisor, deploy } = installation(async (probe) => {
    if (probe.name === "exiting") exiting.resolve();
    if (probe.name !== "version") return probe.version;
    await exiting.promise;
    return "9.9.9";
  });
  const old = await probes.next("started", "0.1.0");
  const answer = deploy();
  await probes.next("version", "0.2.0");
  process.kill(old.pid, "SIGUSR1");
  expect(await answer).toEqual({ ok: false, class: "version_mismatch", step: "version" });
  expect(await supervisor.done).toBe(7);
});

test("an aborted version probe kills the release child and answers no version", async () => {
  const controller = new AbortController();
  const probes = probeServer(() => new Promise<string>(() => undefined));
  const dir = mkdtempSync(join(tmpdir(), "oni-rel-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const version = releaseVersion(process.execPath, writeRelease(dir, "0.3.0", "serve", { probe: probes.url }), controller.signal);
  const probe = await probes.next("version", "0.3.0");
  controller.abort();
  expect(await version).toBeUndefined();
  expect(gone(probe.pid)).toBe(true);
});

test("the host client reaches IPv4 and IPv6 binds and a stalled status body ends at its signal", async () => {
  expect(hostEndpoint("0.0.0.0", 1)).toBe("http://127.0.0.1:1");
  expect(hostEndpoint("", 1)).toBe("http://127.0.0.1:1");
  expect(hostEndpoint("::", 1)).toBe("http://[::1]:1");
  expect(hostEndpoint("::1", 1)).toBe("http://[::1]:1");
  expect(hostEndpoint("10.1.2.3", 1)).toBe("http://10.1.2.3:1");
  const status = { version: "0.1.0", instanceId: instanceOf("0.1.0"), contractVersion: Machine.contractVersion, capabilities: { drainRestart: true }, state: "open" } as const;
  const entered = Promise.withResolvers<void>();
  for (const [bind, wildcard] of [["127.0.0.1", "0.0.0.0"], ["::1", "::"]] as const) {
    const server = Bun.serve({ hostname: bind, port: 0, fetch: () => Response.json(status) });
    cleanups.push(() => server.stop(true));
    const port = server.port ?? 0;
    expect(await hostClient(hostEndpoint(wildcard, port), TOKEN).status(new AbortController().signal)).toEqual(status);
    expect(await hostClient(hostEndpoint(bind, port), TOKEN).status(new AbortController().signal)).toEqual(status);
  }
  const stalled = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      entered.resolve();
      return new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode("{")) }));
    },
  });
  cleanups.push(() => stalled.stop(true));
  const controller = new AbortController();
  const read = hostClient(hostEndpoint("127.0.0.1", stalled.port ?? 0), TOKEN).status(controller.signal);
  await entered.promise;
  controller.abort();
  expect(await read).toBeUndefined();
});
