import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Machine } from "@oni/protocol";
import { bootstrapCommand, parseBootstrapArgs, runBootstrap } from "../src/cli/bootstrap";
import { CliError } from "../src/cli/errors";
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

const FAKE_MCLIENT = '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$(dirname "$0")/join-argv"\n';

function joinArgv(home: string): string {
  return readFileSync(join(home, ".oni", "bin", "join-argv"), "utf-8");
}

function packArchive(directory: string): Uint8Array<ArrayBuffer> {
  const staging = join(directory, "staging");
  mkdirSync(staging);
  writeFileSync(join(staging, "mclient"), FAKE_MCLIENT, { mode: 0o755 });
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
function fakeHost(archive: Uint8Array<ArrayBuffer>, options: { readonly tamper?: boolean; readonly release?: boolean } = {}): { readonly origin: string } {
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
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/machine/release") {
        return options.release === false ? Response.json({ reason: "release_unavailable" }, { status: 404 }) : Response.json(release);
      }
      if (pathname === "/mclient.tar.gz") return new Response(archive, { headers: { "content-type": "application/gzip" } });
      return new Response("Not found", { status: 404 });
    },
  });
  servers.push(server);
  return { origin: `http://127.0.0.1:${server.port}` };
}

function realIo(): DaemonIo {
  return {
    exec: (argv) => {
      const [command, ...rest] = argv;
      const result = spawnSync(command ?? "", rest, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    writeFile: (path, content) => writeFileSync(path, content),
    makeDir: (path) => mkdirSync(path, { recursive: true }),
    removeFile: (path) => rmSync(path, { force: true }),
    fileExists: existsSync,
  };
}

function bootstrapDeps(home: string, platform: { readonly os: string; readonly arch: string } = { os: "linux", arch: "x64" }) {
  return { home, os: platform.os, arch: platform.arch, io: realIo(), fetch: (url: string) => fetch(url) };
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
    expect(parseBootstrapArgs(["http://oni-host:3000"])).toEqual({ host: "http://oni-host:3000" });
    expect(parseBootstrapArgs(["http://oni-host:3000", "--token", "jt"])).toEqual({ host: "http://oni-host:3000", token: "jt" });
    for (const args of [[], ["oni-host"], ["http://oni-host", "--token"], ["http://oni-host", "--name", "x"], ["http://oni-host", "--token", "jt", "extra"]]) {
      expect(() => parseBootstrapArgs(args)).toThrow(new CliError("usage: oni machine bootstrap <http(s)://host[:port]> [--token <join token>]"));
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
    expect(out).toEqual([]);
    expect(existsSync(join(home, ".oni"))).toBe(false);
    expect(existsSync(join(home, ".oni", "bin", "join-argv"))).toBe(false);
  });

  test("the verified archive installs ~/.oni/bin/mclient 0755 and joins the host with the token passed through", async () => {
    const home = tempDir("oni-bootstrap-home-");
    const { origin } = fakeHost(packArchive(tempDir("oni-bootstrap-archive-")));
    const out: string[] = [];
    const err: string[] = [];
    expect(await bootstrapCommand([origin, "--token", "join-token"], bootstrapDeps(home, { os: "darwin", arch: "arm64" }), { stdout: (line) => out.push(line), stderr: (line) => err.push(line) })).toBe(0);
    const binary = join(home, ".oni", "bin", "mclient");
    expect(out).toEqual([`installed ${binary} (mclient-v0.1.0, darwin-universal)`]);
    expect(err).toEqual([]);
    expect(statSync(binary).mode & 0o777).toBe(0o755);
    expect(readFileSync(binary, "utf-8")).toBe(FAKE_MCLIENT);
    expect(joinArgv(home)).toBe("join\n127.0.0.1\n--token\njoin-token\n");
    expect(existsSync(join(home, ".oni", "bin", "mclient.staged"))).toBe(false);
  });

  test("without a token the join carries only the host; the join exit code and output are the command's", async () => {
    const home = tempDir("oni-bootstrap-home-");
    const { origin } = fakeHost(packArchive(tempDir("oni-bootstrap-archive-")));
    const receipt = await runBootstrap({ host: origin }, bootstrapDeps(home));
    expect(receipt.joinArgv).toEqual([join(home, ".oni", "bin", "mclient"), "join", "127.0.0.1"]);
    expect(receipt.join.code).toBe(0);
    expect(joinArgv(home)).toBe("join\n127.0.0.1\n");
    const out: string[] = [];
    const err: string[] = [];
    const io = realIo();
    const loud = { ...bootstrapDeps(home), io: { ...io, exec: (argv: readonly string[]) => (argv[1] === "join" ? { code: 3, stdout: "enrolled\n", stderr: "pin recorded\n" } : io.exec(argv)) } };
    expect(await bootstrapCommand([origin], loud, { stdout: (line) => out.push(line), stderr: (line) => err.push(line) })).toBe(3);
    expect(out).toEqual([`installed ${join(home, ".oni", "bin", "mclient")} (mclient-v0.1.0, linux-x86_64)`, "enrolled"]);
    expect(err).toEqual(["pin recorded"]);
  });

  test("an unsupported platform, a missing release, a bad record and a broken archive are each one typed refusal", async () => {
    const home = tempDir("oni-bootstrap-home-");
    const archive = packArchive(tempDir("oni-bootstrap-archive-"));
    const { origin } = fakeHost(archive);
    await expect(runBootstrap({ host: origin }, bootstrapDeps(home, { os: "win32", arch: "x64" }))).rejects.toThrow(new CliError("unsupported platform: win32-x64"));
    const absent = fakeHost(archive, { release: false });
    await expect(runBootstrap({ host: absent.origin }, bootstrapDeps(home))).rejects.toThrow(new CliError(`release unavailable at ${absent.origin}/machine/release`));
    const invalid = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ version: "1" }) });
    servers.push(invalid);
    await expect(runBootstrap({ host: `http://127.0.0.1:${invalid.port}` }, bootstrapDeps(home))).rejects.toThrow(new CliError(`invalid release record at http://127.0.0.1:${invalid.port}/machine/release`));
    const gone = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => (new URL(request.url).pathname === "/machine/release"
        ? Response.json({ version: "0.1.0", contractVersion: Machine.contractVersion, artifacts: { "linux-arm64": { name: "a.tar.gz", bytes: 1, sha256: "0".repeat(64), url: "/a.tar.gz" } } })
        : new Response("Not found", { status: 404 })),
    });
    servers.push(gone);
    await expect(runBootstrap({ host: `http://127.0.0.1:${gone.port}` }, bootstrapDeps(home))).rejects.toThrow(new CliError("no linux-x86_64 artifact in the host's release"));
    await expect(runBootstrap({ host: `http://127.0.0.1:${gone.port}` }, bootstrapDeps(home, { os: "linux", arch: "arm64" }))).rejects.toThrow(new CliError(`download failed: http://127.0.0.1:${gone.port}/a.tar.gz`));
    const broken = new TextEncoder().encode("not an archive");
    const { origin: brokenOrigin } = fakeHost(broken);
    await expect(runBootstrap({ host: brokenOrigin }, bootstrapDeps(home))).rejects.toThrow(/^tar .*mclient\.tar\.gz failed: /);
    expect(existsSync(join(home, ".oni"))).toBe(false);
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
    const binary = join(home, ".oni", "bin", "mclient");
    expect(installed).toEqual({ code: 0, stdout: `installed ${binary} (mclient-v0.1.0, ${releasePlatform(process.platform, process.arch)})\n`, stderr: "" });
    expect(statSync(binary).mode & 0o777).toBe(0o755);
    expect(readFileSync(binary, "utf-8")).toBe(FAKE_MCLIENT);
    expect(joinArgv(home)).toBe("join\n127.0.0.1\n--token\njoin-token\n");
    const plainHome = tempDir("oni-install-home-");
    expect((await installScript(plainHome, [origin])).code).toBe(0);
    expect(joinArgv(plainHome)).toBe("join\n127.0.0.1\n");
  });

  test("the script's argument and host refusals exit before any download", async () => {
    const home = tempDir("oni-install-home-");
    const usage = "usage: sh -s -- <http(s)://host[:port]> [--token <join token>]\n";
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
