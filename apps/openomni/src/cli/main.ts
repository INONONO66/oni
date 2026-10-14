import { CliError } from "./errors";
import { Clock, Effect, Fiber, Layer, ManagedRuntime, Scope } from "effect";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { listenForAbort, type Machine } from "@openomni/protocol";
import { loadConfig } from "../config";
import { installShutdownHandlers, startOpenOmni } from "..";
import { type CliDeps, runCli } from "./commands";
import { attachConfiguredMachine } from "./machine";
import { platformEntropy } from "../composition/platform";
import type { DaemonIo, DaemonTarget, ExecResult } from "./daemon";
import { daemonActive, unitPath } from "./daemon";
import { applyEnvFile, mergeEnvFile, writeEnvFile } from "./env-file";
import type { DoctorPorts } from "./doctor";
import type { AskOptions } from "./onboard";

/**
 * Real-IO entry point. All behavior lives in `commands.ts` and friends;
 * this file only binds the process environment and executes.
 */
function resolvePlatform(): "darwin" | "linux" {
  if (process.platform === "darwin" || process.platform === "linux") return process.platform;
  throw new CliError(`unsupported platform: ${process.platform} (darwin and linux only)`);
}

async function ask(question: string, options?: AskOptions): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new CliError("onboarding requires an interactive terminal");
  }
  if (options?.secret) {
    // Secrets must not echo: readline writes to a sink while the prompt
    // itself goes straight to the real terminal.
    const muted = new Writable({
      write: (_chunk: string | Uint8Array, _encoding, callback) => callback(),
    });
    const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
    try {
      process.stdout.write(`${question}: `);
      const answer = await rl.question("");
      process.stdout.write("\n");
      return answer;
    } finally {
      rl.close();
    }
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = options?.fallback === undefined ? "" : ` [${options.fallback}]`;
    return await rl.question(`${question}${suffix}: `);
  } finally {
    rl.close();
  }
}

export interface CliRuntimeOptions {
  /** Cancels a long-running follow child, with hard-kill escalation. */
  readonly followSignal?: AbortSignal;
  readonly clock?: Clock.Clock;
  /** Captures follow output when a caller needs a lossless readiness signal. */
  readonly followOutput?: (chunk: string) => void;
}

export function createCliDeps(home: string = homedir(), options: CliRuntimeOptions = {}): CliDeps {
  const envPath = join(home, ".openomni", "env");
  const target: DaemonTarget = {
    platform: resolvePlatform(),
    home,
    uid: process.getuid?.() ?? 0,
    bunPath: process.execPath,
    entryPath: fileURLToPath(import.meta.url),
  };
  const io: DaemonIo = {
    exec: (argv: readonly string[]): ExecResult => {
      const [command, ...rest] = argv;
      if (command === undefined) throw new CliError("exec requires a command");
      const result = spawnSync(command, rest, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    writeFile: (path: string, content: string): void => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    },
    removeFile: (path: string): void => rmSync(path, { force: true }),
    makeDir: (path: string): void => {
      mkdirSync(path, { recursive: true });
    },
    fileExists: existsSync,
  };

  async function startApp(): Promise<void> {
    applyEnvFile(envPath);
    mkdirSync(join(home, ".openomni"), { recursive: true });
    const config = loadConfig(home);
    // #1255/#1308: boot owns config -> manifest -> compose -> runtime; the CLI
    // hands over config only, so there is exactly ONE composition root.
    const app = await startOpenOmni({ config });
    installShutdownHandlers({
      stop: app.stop,
      exit: (code) => process.exit(code),
      on: (signal, handler) => process.once(signal, handler),
    });
    console.log(`OpenOmni Resident listening at ws://${config.host}:${app.port}/ws`);
  }

  async function doctorPorts(): Promise<DoctorPorts> {
    const envFilePresent = existsSync(envPath);
    const effectiveEnv = mergeEnvFile(envFilePresent ? await Bun.file(envPath).text() : "");
    const lingerEnabled = ((): boolean | undefined => {
      if (target.platform !== "linux") return undefined;
      const result = io.exec(["loginctl", "show-user", String(target.uid), "--property=Linger"]);
      // An unverifiable linger state gets the warning, not the benefit of the doubt.
      return result.code === 0 && result.stdout.includes("Linger=yes");
    })();
    return {
      bunVersion: Bun.version,
      envFilePresent,
      effectiveEnv,
      unitInstalled: existsSync(unitPath(target)),
      daemonActive: daemonActive(target, io),
      lingerEnabled,
      probeHealth: async (port: number): Promise<boolean> => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(3_000),
          });
          return response.ok;
        } catch {
          return false;
        }
      },
    };
  }

  function follow(argv: readonly string[]): Promise<number> {
    return new Promise((resolve) => {
      const [command, ...rest] = argv;
      if (command === undefined) {
        resolve(1);
        return;
      }
      const child = spawn(command, rest, {
        stdio: ["ignore", options.followOutput === undefined ? "inherit" : "pipe", "inherit"],
      });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => options.followOutput?.(chunk));
      let killFiber: Fiber.Fiber<void> | undefined;
      const abort = (): void => {
        child.kill("SIGTERM");
        const kill = Effect.sleep(2_000).pipe(Effect.tap(() => Effect.sync(() => {
          child.kill("SIGKILL");
        })));
        killFiber = Effect.runFork(options.clock === undefined
          ? kill
          : Effect.provideService(kill, Clock.Clock, options.clock));
      };
      const settle = (code: number): void => {
        if (killFiber !== undefined) void Effect.runPromise(Fiber.interrupt(killFiber));
        detach?.();
        resolve(code);
      };
      child.once("exit", (code) => settle(code ?? 1));
      child.once("error", () => settle(1));
      const detach =
        options.followSignal === undefined ? undefined : listenForAbort(options.followSignal, abort);
    });
  }

  return {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    target,
    io,
    envPath,
    startApp,
    async attachMachine(configPath) {
      const runtime = ManagedRuntime.make(Layer.effect(Scope.Scope, Effect.scope));
      try {
      const daemon = await runtime.runPromise(attachConfiguredMachine(configPath, platformEntropy().id));
      // Snapshot the initial attachment: narrowing the SNAPSHOT keeps the live
      // `daemon.attachment` getter unnarrowed for the re-read after `closed`.
      const initialAttachment: Machine.AttachResult = daemon.attachment;
      console.log(JSON.stringify(initialAttachment));
      if (initialAttachment.status === "refused") {
        return 1;
      }
      installShutdownHandlers({
        stop: runtime.dispose,
        exit: (code) => process.exit(code),
        on: (signal, handler) => process.once(signal, handler),
      });
      // v4: dispose() interrupts every fiber the runtime runs, which would turn
      // the SIGTERM path into a rejection here. daemon.closed needs no context,
      // so await it outside the runtime; a MachineError still rejects as in v3.
      await Effect.runPromise(daemon.closed);
      // A daemon that closed because a reattach was REFUSED exits nonzero so
      // supervisors see the revocation instead of a clean shutdown.
      return daemon.attachment.status === "refused" ? 1 : 0;
      } finally {
        await runtime.dispose();
      }
    },
    ask,
    writeEnv: (entries) => writeEnvFile(envPath, entries),
    doctorPorts,
    follow,
  };
}

export function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  return runCli(argv, createCliDeps());
}

if (import.meta.main) {
  const code = await main();
  if (code !== 0) process.exit(code);
}
