import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Bus } from "./helpers/bus";
import { PROCESS_SESSION_NO_REQUEST_EXIT } from "../src/process-entry";
import { startOpenOmni } from "../src/index";
import { testMachinesPlane } from "./helpers/self-machine";

const appDir = join(import.meta.dir, "..");

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
    const directory = tempDir("openomni-health-");
    const app = await startOpenOmni({
      config: {
        catalogPath: join(directory, "catalog.sqlite"),
        sessionsDir: join(directory, "sessions"),
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
  /** What npm installs beside the package on the target: the workspace's copy of each native addon, linked for the smoke boot. */
  function linkNativeDependencies(staging: string, dependencies: Readonly<Record<string, string>>): void {
    const sdkDir = dirname(Bun.resolveSync("agent-messenger/package.json", join(appDir, "..", "..", "packages", "channels")));
    mkdirSync(join(staging, "node_modules"), { recursive: true });
    for (const name of Object.keys(dependencies)) {
      symlinkSync(dirname(Bun.resolveSync(`${name}/package.json`, sdkDir)), join(staging, "node_modules", name), "dir");
    }
  }

  test("build stages a package with no workspace dependency — only the native addon npm installs per platform — whose bundle boots against a fresh ledger", async () => {
    const staging = tempDir("openomni-pack-staging-");
    const home = tempDir("openomni-pack-home-");
    const env = {
      HOME: home,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      OPENOMNI_CATALOG_PATH: join(home, "catalog.sqlite"),
      OPENOMNI_SESSIONS_DIR: join(home, "sessions"),
      OPENOMNI_MEMORY_PATH: join(home, "memory.json"),
      OPENOMNI_AUTH_FILE: join(home, "auth.json"),
      OPENOMNI_MODELS_PATH: join(home, "models.json"),
      OPENOMNI_DISABLE_MODELS_FETCH: "1",
      OPENOMNI_MACHINES_SOCKET: join(home, "machines.sock"),
      // #1271: a boot without a machine plane refuses; the packaged smoke
      // boot carries a minimal self export.
      OPENOMNI_MACHINES_SELF: JSON.stringify({
        capabilities: ["fs.read"],
        exports: [{ name: "home", path: home }],
      }),
      OPENOMNI_WS_HOST: "127.0.0.1",
      OPENOMNI_WS_PORT: "0",
      OPENOMNI_MODEL_PROVIDER: "fake",
      OPENOMNI_MODEL_ID: "pack-smoke",
      OPENOMNI_MODEL_API_KEY: "test-key",
    };
    const build = Bun.spawnSync([process.execPath, "run", "script/build-npm-package.ts", staging], {
      cwd: appDir,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    expect(build.exitCode, build.stderr.toString()).toBe(0);

    // Manifest contract: no workspace dep may leak into the registry artifact; the
    // one native addon the channels SDK loads stays external (its prebuilt
    // binary is found beside its own package on the target, never in a bundle).
    const manifest = JSON.parse(readFileSync(join(staging, "package.json"), "utf-8")) as {
      name: string;
      bin: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    expect(manifest.name).toBe("openomni");
    expect(manifest.dependencies).toEqual({ "classic-level": "^3.0.0" });
    linkNativeDependencies(staging, manifest.dependencies ?? {});
    expect(existsSync(join(staging, manifest.bin.openomni ?? ""))).toBe(true);
    // W5.2: no migration plane ships; the schema is embedded in the bundle.
    expect(existsSync(join(staging, "migration"))).toBe(false);
    expect(existsSync(join(staging, "dist", "app", "process-entry.js"))).toBe(true);

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
