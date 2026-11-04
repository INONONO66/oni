import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Machine } from "@oni/protocol";
import { CliError } from "../src/cli/errors";
import { BootstrapRefusal, type BootstrapRefusalKind, bootstrapCommand, parseBootstrapArgs, runBootstrap } from "../src/cli/bootstrap";
import type { DaemonIo } from "../src/cli/daemon";
import { HOST_ORIGIN, joinHost, MACHINE_INSTALL_SCRIPT, releasePlatform } from "../src/composition/machine-install";
import { Bus } from "./helpers/bus";
import { startOni } from "../src/index";
import { testMachinesPlane } from "./helpers/self-machine";

const directories: string[] = [];
const servers: Array<{ stop: (force?: boolean) => void | Promise<void> }> = [];
let stopApp: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stopApp?.();
  stopApp = undefined;
  Bus.reset();
  for (const server of servers.splice(0)) await server.stop(true);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** A stand-in `mclient` run from the bootstrap stage: it records its argv and its own path beside the stage, under `~/.oni/machine-client`. */
const FAKE_MCLIENT = '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$(dirname "$0")/../join-argv"\nprintf \'%s\\n\' "$0" > "$(dirname "$0")/../join-exe"\nprintf \'%s\\n\' "$ONI_MCLIENT_JOIN_TOKEN" > "$(dirname "$0")/../join-token"\n';
const FAILING_MCLIENT = `${FAKE_MCLIENT}exit 5\n`;

function clientFile(home: string, name: string): string {
  return join(home, ".oni", "machine-client", name);
}

function joinArgv(home: string): string {
  return readFileSync(clientFile(home, "join-argv"), "utf-8");
}

function joinToken(home: string): string {
  return readFileSync(clientFile(home, "join-token"), "utf-8").trimEnd();
}

function refusal(kind: BootstrapRefusalKind, detail: string): BootstrapRefusal {
  const expected = new BootstrapRefusal(kind, detail);
  expect(expected.kind).toBe(kind);
  expect(expected.name).toBe("BootstrapRefusal");
  return expected;
}

function stagedJoin(home: string): { readonly staged: boolean; readonly removed: boolean } {
  const executable = readFileSync(clientFile(home, "join-exe"), "utf-8").trimEnd();
  const stage = join(executable, "..");
  return { staged: stage.startsWith(clientFile(home, "bootstrap")), removed: !existsSync(stage) };
}

function pinClient(home: string, pinnedVersion: string, binary = "installed-binary\n"): void {
  mkdirSync(join(home, ".oni", "bin"), { recursive: true });
  mkdirSync(clientFile(home, ""), { recursive: true });
  writeFileSync(join(home, ".oni", "bin", "mclient"), binary, { mode: 0o755 });
  writeFileSync(clientFile(home, "pin.json"), JSON.stringify({ pinnedVersion, pinned: true }));
}

function packArchive(directory: string, script = FAKE_MCLIENT): Uint8Array<ArrayBuffer> {
  const staging = join(directory, "staging");
  mkdirSync(staging);
  writeFileSync(join(staging, "mclient"), script, { mode: 0o755 });
  const archive = join(directory, "mclient.tar.gz");
  const tar = spawnSync("tar", ["-czf", archive, "-C", staging, "mclient"], { stdio: ["ignore", "pipe", "pipe"] });
  expect(tar.status).toBe(0);
  return new Uint8Array(readFileSync(archive));
}

/**
 * A fake host: `/machine/release` names one archive per platform (every
 * platform shares the same bytes) and `/mclient.tar.gz` serves them; a
 * `tamper` server advertises the right URL under a wrong digest.
 */
function fakeHost(archive: Uint8Array<ArrayBuffer>, options: { readonly tamper?: boolean; readonly release?: boolean; readonly hostname?: string } = {}): { readonly origin: string; readonly downloads: () => number } {
  let downloads = 0;
  const digest = createHash("sha256").update(archive).digest("hex");
  const sha256 = options.tamper === true ? digest.replace(/^./, digest.startsWith("0") ? "1" : "0") : digest;
  const artifact = (name: string) => ({ name, bytes: archive.length, sha256, url: "/mclient.tar.gz" });
  const release: Machine.Release = {
    version: "0.1.0",
    contractVersion: Machine.contractVersion,
    tag: "mclient-v0.1.0",
    artifacts: {
      "darwin-universal": artifact("mclient-darwin-universal.tar.gz"),
      "linux-x86_64": artifact("mclient-linux-x86_64.tar.gz"),
      "linux-arm64": artifact("mclient-linux-arm64.tar.gz"),
    },
  };
  const hostname = options.hostname ?? "127.0.0.1";
  const server = Bun.serve({
    hostname,
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/machine/release") {
        return options.release === false ? Response.json({ reason: "release_unavailable" }, { status: 404 }) : Response.json(release);
      }
      if (pathname === "/mclient.tar.gz") {
        downloads += 1;
        return new Response(archive, { headers: { "content-type": "application/gzip" } });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  servers.push(server);
  return { origin: `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${server.port}`, downloads: () => downloads };
}

function realIo(): DaemonIo {
  return {
    exec: (argv, env) => {
      const [command, ...rest] = argv;
      const result = spawnSync(command ?? "", rest, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
      return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    writeFile: (path, content) => writeFileSync(path, content),
    makeDir: (path) => mkdirSync(path, { recursive: true }),
    removeFile: (path) => rmSync(path, { force: true }),
    fileExists: existsSync,
  };
}

function bootstrapDeps(home: string, platform: { readonly os: string; readonly arch: string } = { os: "linux", arch: "x64" }) {
  return {
    home,
    os: platform.os,
    arch: platform.arch,
    io: realIo(),
    fetch: (url: string, init: { readonly signal: AbortSignal }) => {
      expect(init.signal.aborted).toBe(false);
      return fetch(url, init);
    },
  };
}

async function installScript(home: string, args: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn(["sh", "-s", "--", ...args], {
    stdin: new Blob([MACHINE_INSTALL_SCRIPT]),
    stdout: "pipe",
    stderr: "pipe",
    env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

describe("release platform and host forms", () => {
  test("the platform table is the client's: macOS universal, Linux by architecture, nothing else", () => {
    expect(releasePlatform("darwin", "arm64")).toBe("darwin-universal");
    expect(releasePlatform("darwin", "x64")).toBe("darwin-universal");
    expect(releasePlatform("linux", "x64")).toBe("linux-x86_64");
    expect(releasePlatform("linux", "arm64")).toBe("linux-arm64");
    expect(releasePlatform("win32", "x64")).toBeUndefined();
    expect(releasePlatform("linux", "ia32")).toBeUndefined();
  });

  test("the host is an HTTP origin; join takes its name without the HTTP port", () => {
    expect(HOST_ORIGIN.test("http://oni-host:3000")).toBe(true);
    expect(HOST_ORIGIN.test("https://oni.example.com")).toBe(true);
    expect(HOST_ORIGIN.test("oni-host:3000")).toBe(false);
    expect(HOST_ORIGIN.test("http://oni-host:3000/machine")).toBe(false);
    expect(joinHost("http://oni-host:3000")).toBe("oni-host");
    expect(joinHost("https://oni.example.com")).toBe("oni.example.com");
    expect(joinHost("http://[::1]:3000")).toBe("[::1]");
    expect(parseBootstrapArgs(["http://oni-host:3000"])).toEqual({ host: "http://oni-host:3000" });
    expect(parseBootstrapArgs(["http://oni-host:3000/"])).toEqual({ host: "http://oni-host:3000" });
    expect(parseBootstrapArgs(["http://oni-host:3000", "--token", "jt"])).toEqual({ host: "http://oni-host:3000", token: "jt" });
    expect(parseBootstrapArgs(["http://oni-host:3000", "--force"])).toEqual({ host: "http://oni-host:3000", force: true });
    expect(parseBootstrapArgs(["http://oni-host:3000", "--force", "--token", "jt"])).toEqual({ host: "http://oni-host:3000", token: "jt", force: true });
    for (const args of [[], ["oni-host"], ["http://oni-host", "--token"], ["http://oni-host", "--name", "x"], ["http://oni-host", "--token", "jt", "extra"]]) {
      expect(() => parseBootstrapArgs(args)).toThrow(new CliError("usage: oni machine bootstrap <http(s)://host[:port]> [--token <join token>] [--force]"));
    }
  });
});

describe("oni machine bootstrap", () => {
  test("a tampered sha256 is refused with checksum_mismatch before anything is installed", async () => {
    const home = tempDir("oni-bootstrap-home-");
    const { origin } = fakeHost(packArchive(tempDir("oni-bootstrap-archive-")), { tamper: true });
    const err: string[] = [];
    const out: string[] = [];
    expect(await bootstrapCommand([origin], bootstrapDeps(home), { stdout: (line) => out.push(line), stderr: (line) => err.push(line) })).toBe(1);
    expect(err).toEqual([`checksum_mismatch: ${origin}/mclient.tar.gz`]);
    await expect(runBootstrap({ host: origin }, bootstrapDeps(home))).rejects.toThrow(refusal("checksum_mismatch", `${origin}/mclient.tar.gz`));
    const usage: string[] = [];
    expect(await bootstrapCommand(["oni-host"], bootstrapDeps(home), { stdout: () => undefined, stderr: (line) => usage.push(line) })).toBe(1);
    expect(usage).toEqual(["usage: oni machine bootstrap <http(s)://host[:port]> [--token <join token>] [--force]"]);
    const broken = { ...bootstrapDeps(home), fetch: () => Promise.reject(new TypeError("socket hang up")) };
    await expect(bootstrapCommand([origin], broken, { stdout: () => undefined, stderr: () => undefined })).rejects.toThrow(new TypeError("socket hang up"));
    expect(out).toEqual([]);
    expect(existsSync(join(home, ".oni"))).toBe(false);
  });

  test("a fresh machine stages the verified binary 0755 and joins from the stage; bin/mclient is join's to write", async () => {
    const home = tempDir("oni-bootstrap-home-");
    const { origin } = fakeHost(packArchive(tempDir("oni-bootstrap-archive-")));
    const out: string[] = [];
    const err: string[] = [];
    const io = realIo();
    let stagedMode = 0;
    const deps = { ...bootstrapDeps(home, { os: "darwin", arch: "arm64" }), io: { ...io, exec: (argv: readonly string[], env?: Readonly<Record<string, string>>) => {
      if (argv[1] === "join") stagedMode = statSync(argv[0] ?? "").mode & 0o777;
      return io.exec(argv, env);
    } } };
    expect(await bootstrapCommand([origin, "--token", "join-token"], deps, { stdout: (line) => out.push(line), stderr: (line) => err.push(line) })).toBe(0);
    expect(out).toEqual(["verified mclient-v0.1.0 (darwin-universal): mclient join 127.0.0.1"]);
    expect(err).toEqual([]);
    expect(stagedMode).toBe(0o755);
    expect(joinArgv(home)).toBe("join\n127.0.0.1\n");
    expect(joinToken(home)).toBe("join-token");
    expect(stagedJoin(home)).toEqual({ staged: true, removed: true });
    expect(existsSync(join(home, ".oni", "bin"))).toBe(false);
  });

  test("without a token the join carries only the host; the join exit code and output are the command's", async () => {
    const home = tempDir("oni-bootstrap-home-");
    const { origin } = fakeHost(packArchive(tempDir("oni-bootstrap-archive-")));
    const receipt = await runBootstrap({ host: origin }, bootstrapDeps(home));
    expect(receipt.joinArgv.slice(1)).toEqual(["join", "127.0.0.1"]);
    expect(receipt.joinArgv[0]?.startsWith(clientFile(home, "bootstrap-"))).toBe(true);
    expect(receipt.join.code).toBe(0);
    expect(receipt.tokenPresented).toBe(false);
    expect(joinArgv(home)).toBe("join\n127.0.0.1\n");
    expect(joinToken(home)).toBe("");
    const out: string[] = [];
    const err: string[] = [];
    const io = realIo();
    const loud = { ...bootstrapDeps(home), io: { ...io, exec: (argv: readonly string[]) => (argv[1] === "join" ? { code: 3, stdout: "enrolled\n", stderr: "pin recorded\n" } : io.exec(argv)) } };
    expect(await bootstrapCommand([origin], loud, { stdout: (line) => out.push(line), stderr: (line) => err.push(line) })).toBe(3);
    expect(out).toEqual(["verified mclient-v0.1.0 (linux-x86_64): mclient join 127.0.0.1", "enrolled"]);
    expect(err).toEqual(["pin recorded"]);
  });

  test("a rerun on a joined machine never touches the pinned binary, and a failed join leaves it intact", async () => {
    const home = tempDir("oni-bootstrap-home-");
    const { origin } = fakeHost(packArchive(tempDir("oni-bootstrap-archive-")));
    pinClient(home, "0.1.0");
    const binary = join(home, ".oni", "bin", "mclient");
    const receipt = await runBootstrap({ host: origin }, bootstrapDeps(home));
    expect(receipt.join.code).toBe(0);
    expect(readFileSync(binary, "utf-8")).toBe("installed-binary\n");
    expect(JSON.parse(readFileSync(clientFile(home, "pin.json"), "utf-8"))).toEqual({ pinnedVersion: "0.1.0", pinned: true });
    expect(stagedJoin(home)).toEqual({ staged: true, removed: true });
    const failing = fakeHost(packArchive(tempDir("oni-bootstrap-archive-"), FAILING_MCLIENT));
    const failed = await runBootstrap({ host: failing.origin }, bootstrapDeps(home));
    expect(failed.join.code).toBe(5);
    expect(readFileSync(binary, "utf-8")).toBe("installed-binary\n");
    expect(stagedJoin(home)).toEqual({ staged: true, removed: true });
  });

  test("a host release older than the pin is downgrade_refused before any download unless --force", async () => {
    const home = tempDir("oni-bootstrap-home-");
    const { origin, downloads } = fakeHost(packArchive(tempDir("oni-bootstrap-archive-")));
    pinClient(home, "0.2.0");
    await expect(runBootstrap({ host: origin }, bootstrapDeps(home))).rejects.toThrow(refusal("downgrade_refused", "the host's 0.1.0 is older than the pinned 0.2.0 (pass --force)"));
    expect(downloads()).toBe(0);
    expect(existsSync(clientFile(home, "join-argv"))).toBe(false);
    expect((await runBootstrap({ host: origin, force: true }, bootstrapDeps(home))).join.code).toBe(0);
    expect(joinArgv(home)).toBe("join\n127.0.0.1\n");
    pinClient(home, "0.0.9");
    expect((await runBootstrap({ host: origin }, bootstrapDeps(home))).join.code).toBe(0);
    expect(downloads()).toBe(2);
    writeFileSync(clientFile(home, "pin.json"), "{}");
    await expect(runBootstrap({ host: origin }, bootstrapDeps(home))).rejects.toThrow(refusal("unreadable_pin", clientFile(home, "pin.json")));
  });

  test("an unsupported platform, a missing release, a bad record and a broken archive are each one typed refusal", async () => {
    const home = tempDir("oni-bootstrap-home-");
    const archive = packArchive(tempDir("oni-bootstrap-archive-"));
    const { origin } = fakeHost(archive);
    await expect(runBootstrap({ host: origin }, bootstrapDeps(home, { os: "win32", arch: "x64" }))).rejects.toThrow(refusal("unsupported_platform", "win32-x64"));
    const absent = fakeHost(archive, { release: false });
    await expect(runBootstrap({ host: absent.origin }, bootstrapDeps(home))).rejects.toThrow(refusal("release_unavailable", `${absent.origin}/machine/release answered 404`));
    const invalid = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ version: "1" }) });
    servers.push(invalid);
    await expect(runBootstrap({ host: `http://127.0.0.1:${invalid.port}` }, bootstrapDeps(home))).rejects.toThrow(refusal("release_unavailable", `http://127.0.0.1:${invalid.port}/machine/release is not a release record`));
    const gone = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => (new URL(request.url).pathname === "/machine/release"
        ? Response.json({ version: "0.1.0", contractVersion: Machine.contractVersion, artifacts: { "linux-arm64": { name: "a.tar.gz", bytes: 1, sha256: "0".repeat(64), url: "/a.tar.gz" } } })
        : new Response("Not found", { status: 404 })),
    });
    servers.push(gone);
    await expect(runBootstrap({ host: `http://127.0.0.1:${gone.port}` }, bootstrapDeps(home))).rejects.toThrow(refusal("release_unavailable", "no linux-x86_64 artifact in the host's release"));
    await expect(runBootstrap({ host: `http://127.0.0.1:${gone.port}` }, bootstrapDeps(home, { os: "linux", arch: "arm64" }))).rejects.toThrow(refusal("download_failed", `http://127.0.0.1:${gone.port}/a.tar.gz answered 404`));
    const broken = new TextEncoder().encode("not an archive");
    const { origin: brokenOrigin } = fakeHost(broken);
    await expect(runBootstrap({ host: brokenOrigin }, bootstrapDeps(home))).rejects.toThrow(/^extract_failed: tar .*mclient\.tar\.gz: /);
    expect(existsSync(join(home, ".oni", "bin"))).toBe(false);
    expect(readdirSync(clientFile(home, ""))).toEqual([]);
  });
});

describe("GET /machine/install", () => {
  test("the host serves the install script as plain text", async () => {
    const directory = tempDir("oni-install-route-");
    const app = await startOni({
      config: {
        catalogPath: join(directory, "catalog.sqlite"),
        sessionsDir: join(directory, "sessions"),
        machineGenerationsPath: join(directory, "machines", "generations.json"),
        host: "127.0.0.1",
        wsPort: 0,
        kek: { kind: "locked", reason: "no vault key in this fixture" },
        machines: testMachinesPlane(),
        model: { provider: "fake", id: "install-test", apiKey: "test-key" },
      },
    });
    stopApp = () => app.stop();
    const response = await fetch(`http://127.0.0.1:${app.port}/machine/install`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe(MACHINE_INSTALL_SCRIPT);
    expect((await fetch(`http://127.0.0.1:${app.port}/machine/install`, { method: "POST" })).status).toBe(404);
  });

  test("the script refuses a tampered sha256 with the same message and installs the verified archive to $HOME", async () => {
    const archive = packArchive(tempDir("oni-install-archive-"));
    const tampered = fakeHost(archive, { tamper: true });
    const home = tempDir("oni-install-home-");
    const refused = await installScript(home, [tampered.origin]);
    expect(refused).toEqual({ code: 1, stdout: "", stderr: `checksum_mismatch: ${tampered.origin}/mclient.tar.gz\n` });
    expect(existsSync(join(home, ".oni"))).toBe(false);
    const { origin } = fakeHost(archive);
    const installed = await installScript(home, [origin, "--token", "join-token"]);
    expect(installed).toEqual({ code: 0, stdout: `verified mclient-v0.1.0 (${releasePlatform(process.platform, process.arch)}): mclient join 127.0.0.1\n`, stderr: "" });
    expect(joinArgv(home)).toBe("join\n127.0.0.1\n");
    expect(joinToken(home)).toBe("join-token");
    expect(stagedJoin(home)).toEqual({ staged: true, removed: true });
    expect(existsSync(join(home, ".oni", "bin"))).toBe(false);
    const plainHome = tempDir("oni-install-home-");
    expect((await installScript(plainHome, [origin])).code).toBe(0);
    expect(joinArgv(plainHome)).toBe("join\n127.0.0.1\n");
    expect(joinToken(plainHome)).toBe("");
    const slashHome = tempDir("oni-install-home-");
    expect((await installScript(slashHome, [`${origin}/`])).code).toBe(0);
    expect(joinArgv(slashHome)).toBe("join\n127.0.0.1\n");
    const six = fakeHost(packArchive(tempDir("oni-install-archive-")), { hostname: "::1" });
    const sixHome = tempDir("oni-install-home-");
    expect((await installScript(sixHome, [six.origin])).code).toBe(0);
    expect(joinArgv(sixHome)).toBe("join\n[::1]\n");
    const sixCli = tempDir("oni-install-home-");
    expect((await runBootstrap({ host: six.origin }, bootstrapDeps(sixCli))).joinArgv.slice(1)).toEqual(["join", "[::1]"]);
  });

  test("the script keeps a joined machine's pinned binary, refuses a downgrade unless --force, and cleans its stage after a failed join", async () => {
    const { origin } = fakeHost(packArchive(tempDir("oni-install-archive-")));
    const home = tempDir("oni-install-home-");
    pinClient(home, "0.1.0");
    const binary = join(home, ".oni", "bin", "mclient");
    expect((await installScript(home, [origin])).code).toBe(0);
    expect(readFileSync(binary, "utf-8")).toBe("installed-binary\n");
    expect(stagedJoin(home)).toEqual({ staged: true, removed: true });
    pinClient(home, "0.2.0");
    expect(await installScript(home, [origin])).toEqual({ code: 1, stdout: "", stderr: "downgrade_refused: the host's 0.1.0 is older than the pinned 0.2.0 (pass --force)\n" });
    expect((await installScript(home, [origin, "--force"])).code).toBe(0);
    pinClient(home, "0.0.9");
    expect((await installScript(home, [origin])).code).toBe(0);
    const failing = fakeHost(packArchive(tempDir("oni-install-archive-"), FAILING_MCLIENT));
    expect((await installScript(home, [failing.origin])).code).toBe(5);
    expect(readFileSync(binary, "utf-8")).toBe("installed-binary\n");
    expect(stagedJoin(home)).toEqual({ staged: true, removed: true });
  });

  test("the script's argument and host refusals exit before any download", async () => {
    const home = tempDir("oni-install-home-");
    const usage = "usage: sh -s -- <http(s)://host[:port]> [--token <join token>] [--force]\n";
    expect(await installScript(home, ["oni-host:3000"])).toEqual({ code: 2, stdout: "", stderr: usage });
    expect(await installScript(home, ["http://oni-host:3000", "--token"])).toEqual({ code: 2, stdout: "", stderr: usage });
    expect(await installScript(home, ["http://oni-host:3000", "--name", "x"])).toEqual({ code: 2, stdout: "", stderr: usage });
    expect(await installScript(home, [])).toEqual({ code: 2, stdout: "", stderr: usage });
    const unreachable = await installScript(home, ["http://127.0.0.1:1"]);
    expect(unreachable.code).toBe(1);
    expect(unreachable.stderr.trimEnd().split("\n").at(-1)).toBe("release unavailable at http://127.0.0.1:1/machine/release");
    expect(existsSync(join(home, ".oni"))).toBe(false);
  });
});
