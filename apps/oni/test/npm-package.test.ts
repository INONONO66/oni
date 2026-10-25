import { afterEach, describe, expect, test } from "bun:test";
import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Bus } from "./helpers/bus";
import { PROCESS_SESSION_NO_REQUEST_EXIT } from "../src/process-entry";
import { startOni } from "../src/index";
import { testMachinesPlane } from "./helpers/self-machine";

const appDir = join(import.meta.dir, "..");
const repoRoot = resolve(appDir, "..", "..");

const directories: string[] = [];
let stopApp: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stopApp?.();
  stopApp = undefined;
  Bus.reset();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

describe("health endpoint", () => {
  test("GET /health answers ok on the ws port", async () => {
    const directory = tempDir("oni-health-");
    const app = await startOni({
      config: {
        catalogPath: join(directory, "catalog.sqlite"),
        sessionsDir: join(directory, "sessions"),
        machineGenerationsPath: join(directory, "machines", "generations.json"),
        host: "127.0.0.1",
        wsPort: 0,
        kek: { kind: "locked", reason: "no vault key in this fixture" },
        machines: testMachinesPlane(),
        model: { provider: "fake", id: "health-test", apiKey: "test-key" },
      },
    });
    stopApp = () => app.stop();
    const response = await fetch(`http://127.0.0.1:${app.port}/health`);
    expect(response.status).toBe(200);
    // Liveness only: any extra field on this unauthenticated surface is disclosure.
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("npm package staging", () => {
  test("build stages a portable package whose bundle boots against a fresh ledger", async () => {
    const staging = tempDir("oni-pack-staging-");
    const home = tempDir("oni-pack-home-");
    const env = {
      HOME: home,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      ONI_CATALOG_PATH: join(home, "catalog.sqlite"),
      ONI_SESSIONS_DIR: join(home, "sessions"),
      ONI_MEMORY_PATH: join(home, "memory.json"),
      ONI_AUTH_FILE: join(home, "auth.json"),
      ONI_MODELS_PATH: join(home, "models.json"),
      ONI_DISABLE_MODELS_FETCH: "1",
      ONI_MACHINES_SOCKET: join(home, "machines.sock"),
      ONI_MACHINES_GENERATIONS: join(home, "machines", "generations.json"),
      // #1271: a boot without a machine plane refuses; the packaged smoke
      // boot carries a minimal self export.
      ONI_MACHINES_SELF: JSON.stringify({
        capabilities: ["fs.read"],
        exports: [{ name: "home", path: home }],
      }),
      ONI_WS_HOST: "127.0.0.1",
      ONI_WS_PORT: "0",
      ONI_MODEL_PROVIDER: "fake",
      ONI_MODEL_ID: "pack-smoke",
      ONI_MODEL_API_KEY: "test-key",
    };
    const argv = process.argv;
    try {
      process.argv = [argv[0] ?? "", argv[1] ?? "", staging];
      await import("../script/build-npm-package");
    } finally {
      process.argv = argv;
    }

    // Manifest contract: no workspace dep may leak into the registry artifact;
    // the only dependencies are native addons, pinned exactly.
    const manifest = JSON.parse(readFileSync(join(staging, "package.json"), "utf-8")) as {
      name: string;
      bin: Record<string, string>;
      dependencies: Record<string, string>;
      optionalDependencies: Record<string, string>;
    };
    expect(manifest.name).toBe("oni");
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "@discordjs/voice", "@snazzah/davey", "classic-level", "koffi", "opusscript", "prebuilt-tdlib", "prism-media",
    ]);
    expect(manifest.dependencies.koffi).toBe("2.15.2");
    expect(manifest.dependencies["prebuilt-tdlib"]).toBe("0.1008062.2");
    expect(Object.keys(manifest.optionalDependencies)).toEqual(["@discordjs/opus"]);
    for (const version of Object.values({ ...manifest.dependencies, ...manifest.optionalDependencies }))
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(existsSync(join(staging, manifest.bin.oni ?? ""))).toBe(true);
    // W5.2: no migration plane ships; the schema is embedded in the bundle.
    expect(existsSync(join(staging, "migration"))).toBe(false);
    expect(existsSync(join(staging, "dist", "app", "process-entry.js"))).toBe(true);
    const host = join(staging, "dist", "app", "huddle-host.js");
    const huddle = fork(host, [], {
      cwd: staging, execPath: process.execPath, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const left = Promise.withResolvers<object>();
    const exited = Promise.withResolvers<number | null>();
    huddle.once("message", left.resolve);
    huddle.once("exit", exited.resolve);
    huddle.once("error", left.reject);
    huddle.send({ type: "leave" });
    try {
      expect(await bounded(left.promise, 5_000)).toEqual({ type: "left" });
      expect(await bounded(exited.promise, 5_000)).toBe(0);
    } finally {
      if (huddle.exitCode === null) huddle.kill();
    }
    // A bundle that inlines a native addon freezes the build host's absolute
    // path as that module's __dirname and refuses to load anywhere else.
    for (const bundle of ["main.js", "process-entry.js", "huddle-host.js"]) {
      expect(readFileSync(join(staging, "dist", "app", bundle), "utf-8")).not.toContain(repoRoot);
    }
    // `npm install` places the pinned addons beside the bundle; the smoke boot
    // links the workspace's resolution of each one there instead.
    const sdkDir = dirname(Bun.resolveSync("agent-messenger/package.json", join(repoRoot, "packages", "channels")));
    mkdirSync(join(staging, "node_modules"));
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      const resolved = Bun.resolveSync(`${name}/package.json`, sdkDir);
      expect((JSON.parse(readFileSync(resolved, "utf-8")) as { version: string }).version).toBe(version);
      if (name.startsWith("@")) mkdirSync(join(staging, "node_modules", name.split("/")[0] ?? ""), { recursive: true });
      symlinkSync(dirname(resolved), join(staging, "node_modules", name));
    }

    // Boot the bundle exactly as the daemon would: `bun dist/app/main.js start`.
    const proc = Bun.spawn([process.execPath, join(staging, "dist", "app", "main.js"), "start"], {
      cwd: staging,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const ready = Promise.withResolvers<number>();
    const stdout = drainListeningPort(proc.stdout, ready.resolve);
    const stderr = new Response(proc.stderr).text();
    const output = Promise.all([stdout, stderr]);
    try {
      const port = await bounded(
        Promise.race([
          ready.promise,
          proc.exited.then(async (code) => {
            const [out, err] = await output;
            throw new Error(`bundle exited early (${code}): ${out}\n${err}`);
          }),
          output.then(([out, err]) => {
            throw new Error(`bundle output closed before readiness: ${out}\n${err}`);
          }),
        ]),
        10_000,
      );
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      expect(response.status).toBe(200);
    } finally {
      try {
        await terminate(proc);
      } finally {
        await bounded(output, 2_000);
      }
    }

    // The bundled child must be executable, not merely present: with stdin
    // closed it must reach its own request-line guard and exit with the
    // dedicated sentinel code — load errors and top-level exceptions exit 1
    // and cannot fake this.
    const child = Bun.spawnSync(
      [process.execPath, join(staging, "dist", "app", "process-entry.js")],
      {
        cwd: staging,
        env,
        timeout: 5_000,
        killSignal: "SIGKILL",
        stdin: new Uint8Array(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(child.exitCode).toBe(PROCESS_SESSION_NO_REQUEST_EXIT);
    expect(child.stdout.toString()).toBe("");
  }, 30_000);
});

async function drainListeningPort(
  stdout: ReadableStream<Uint8Array>,
  ready: (port: number) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    const match = buffer.match(/listening at ws:\/\/127\.0\.0\.1:(\d+)\/ws/);
    if (match?.[1] !== undefined) ready(Number(match[1]));
  }
  return buffer;
}

class ChildTimeoutError extends Error {}

function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ChildTimeoutError(`child exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.finally(() => clearTimeout(timer)).then(resolve, reject);
  });
}

async function terminate(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
  // Signal termination leaves exitCode null: signalCode is also terminal evidence.
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  // bounded() rejects with ChildTimeoutError or the child's own exit Error.
  await bounded(child.exited, 1_000).catch(async (error: Error) => {
    if (!(error instanceof ChildTimeoutError)) throw error;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await bounded(child.exited, 1_000);
  });
}
