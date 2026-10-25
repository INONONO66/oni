import { CliError } from "./errors";
import { Clock, Effect, Fiber, Layer, ManagedRuntime, Scope } from "effect";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Core } from "@oni/agent";
import { createChannelInstanceStore, createPersonStore, createSecretStore, openChannelStore, OwnerLogins } from "@oni/channels";
import { Channel, listenForAbort, type Machine, parseJson, PlainValueSchema, Provisioning } from "@oni/protocol";
import { loadConfig } from "../config";
import { installShutdownHandlers, startOni } from "..";
import { type CliDeps, runCli } from "./commands";
import { attachConfiguredMachine } from "./machine";
import { platformEntropy } from "../composition/platform";
import type { DaemonIo, DaemonTarget, ExecResult } from "./daemon";
import { daemonActive, unitPath } from "./daemon";
import { applyEnvFile, mergeEnvFile, writeEnvFile } from "./env-file";
import type { DoctorPorts } from "./doctor";
import type { MessagingFacts } from "./messaging";
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

/** The hosts a login may declare over: the credential and the ws token cross the socket in clear. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
/** How long the daemon has to answer a declaration (it mounts the instance before answering). */
const DECLARE_DEADLINE_MS = 60_000;

type DeclareAnswer =
  | { readonly kind: "response"; readonly response: Provisioning.ChannelDeclareResponse }
  | { readonly kind: "refused"; readonly error: CliError }
  | { readonly kind: "other" };

function readFrame(data: string): { readonly requestId?: string; readonly type?: string; readonly reason?: string } | undefined {
  try {
    const parsed: { requestId?: string; type?: string; reason?: string } = JSON.parse(data);
    return parsed;
  } catch {
    return undefined;
  }
}

/** What one frame from the daemon means to the declaration waiting for it; the gateway's id-less `error` frame is its refusal. */
function declareAnswer(data: string, requestId: string): DeclareAnswer {
  const frame = readFrame(data);
  if (frame === undefined)
    return { kind: "refused", error: new CliError("the daemon answered with a frame this CLI cannot read") };
  if (frame.requestId === undefined && frame.type === "error")
    return { kind: "refused", error: new CliError(`the daemon refused the frame: ${frame.reason ?? "unknown"}`) };
  if (frame.requestId !== requestId) return { kind: "other" };
  const response = Provisioning.ChannelDeclareResponse.safeParse(frame);
  return response.success
    ? { kind: "response", response: response.data }
    : { kind: "refused", error: new CliError("the daemon answered with a frame this CLI does not know") };
}

/**
 * One frame out, the matching frame back. Every other end of the socket —
 * refused upgrade, closed before the answer, silent past the deadline — is
 * a typed error, never a hang with the Owner's session in memory.
 */
function declareOver(
  socket: WebSocket,
  url: string,
  request: Provisioning.ChannelDeclareRequest,
): Promise<Provisioning.ChannelDeclareResponse> {
  return new Promise((resolve, reject) => {
    let pending = true;
    const timer = setTimeout(
      () => fail(new CliError(`the daemon at ${url} did not answer within ${DECLARE_DEADLINE_MS / 1000}s`)),
      DECLARE_DEADLINE_MS,
    );
    function settle(outcome: () => void): void {
      if (!pending) return;
      pending = false;
      clearTimeout(timer);
      socket.close();
      outcome();
    }
    function fail(error: Error): void {
      settle(() => reject(error));
    }
    socket.addEventListener("error", (event) => {
      const detail = event instanceof ErrorEvent ? event.message : "";
      fail(
        new CliError(
          `could not connect to ${url}${detail === "" ? "" : ` (${detail})`}: no daemon there, or ONI_WS_TOKEN refused`,
        ),
      );
    });
    socket.addEventListener("close", (event) =>
      fail(new CliError(`the daemon closed the socket before answering (code ${event.code})`)),
    );
    socket.addEventListener("open", () => socket.send(JSON.stringify(request)));
    socket.addEventListener("message", (event) => {
      const answer = declareAnswer(String(event.data), request.requestId);
      if (answer.kind === "other") return;
      settle(() => (answer.kind === "response" ? resolve(answer.response) : reject(answer.error)));
    });
  });
}

export interface CliRuntimeOptions {
  /** Cancels a long-running follow child, with hard-kill escalation. */
  readonly followSignal?: AbortSignal;
  readonly clock?: Clock.Clock;
  /** Captures follow output when a caller needs a lossless readiness signal. */
  readonly followOutput?: (chunk: string) => void;
}

export function createCliDeps(home: string = homedir(), options: CliRuntimeOptions = {}): CliDeps {
  const envPath = join(home, ".oni", "env");
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
    mkdirSync(join(home, ".oni"), { recursive: true });
    const config = loadConfig(home);
    // #1255/#1308: boot owns config -> manifest -> compose -> runtime; the CLI
    // hands over config only, so there is exactly ONE composition root.
    const app = await startOni({ config });
    installShutdownHandlers({
      stop: app.stop,
      exit: (code) => process.exit(code),
      on: (signal, handler) => process.once(signal, handler),
    });
    console.log(`Oni Resident listening at ws://${config.host}:${app.port}/ws`);
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

  /**
   * The Owner's socket to the running daemon (#1569 lane 5b): the env file's
   * host, port and token, the `auth` subprotocol the gateway reads, one
   * frame out and the matching frame back. The credential and the ws token
   * cross this socket in clear, so only the loopback daemon is reachable
   * this way.
   */
  async function declareChannel(
    request: Provisioning.ChannelDeclareRequest,
  ): Promise<Provisioning.ChannelDeclareResponse> {
    const env = mergeEnvFile(existsSync(envPath) ? await Bun.file(envPath).text() : "");
    const host = env.get("ONI_WS_HOST") ?? "127.0.0.1";
    const port = env.get("ONI_WS_PORT") ?? "3000";
    const token = env.get("ONI_WS_TOKEN");
    const url = `ws://${host}:${port}/ws`;
    if (!LOOPBACK_HOSTS.has(host))
      throw new CliError(`login declares over the loopback socket only; ONI_WS_HOST names ${host}`);
    return declareOver(new WebSocket(url, token === undefined ? [] : ["auth", token]), url, request);
  }

  async function readChannelHistory(request: Channel.HistoryRequest): Promise<Channel.HistoryResponse> {
    const env = mergeEnvFile(existsSync(envPath) ? await Bun.file(envPath).text() : "");
    const host = env.get("ONI_WS_HOST") ?? "127.0.0.1";
    if (!LOOPBACK_HOSTS.has(host)) throw new CliError("channel history requires the local daemon");
    const token = env.get("ONI_WS_TOKEN");
    if (token === undefined || token.length === 0)
      throw new CliError("channel history requires ONI_WS_TOKEN");
    const url = `ws://${host}:${env.get("ONI_WS_PORT") ?? "3000"}/ws`;
    const socket = new WebSocket(url, ["auth", token]);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(() => reject(new CliError("channel history timed out"))), DECLARE_DEADLINE_MS);
      let pending = true;
      function finish(done: () => void): void {
        if (!pending) return;
        pending = false;
        clearTimeout(timeout);
        socket.close();
        done();
      }
      socket.addEventListener("open", () => socket.send(JSON.stringify(request)));
      socket.addEventListener("error", () => finish(() => reject(new CliError("channel history socket failed"))));
      socket.addEventListener("close", () => finish(() => reject(new CliError("channel history socket closed"))));
      socket.addEventListener("message", (event) => {
        const frame = parseJson(PlainValueSchema, String(event.data));
        if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
          finish(() => reject(new CliError("invalid channel history response")));
          return;
        }
        if (frame.requestId !== request.requestId) return;
        const parsed = Channel.HistoryResponse.safeParse(frame);
        finish(() => parsed.success
          ? resolve(parsed.data)
          : reject(new CliError("invalid channel history response")));
      });
    });
  }

  /**
   * The readiness report's facts (#1600 lane R4): the catalog the daemon
   * writes, opened read-only (`query_only`, which the channel schema honors
   * by running no DDL) on its own channel tables and closed at once; the env
   * file names the catalog path as the daemon reads it.
   */
  async function messagingFacts(): Promise<MessagingFacts> {
    const env = mergeEnvFile(existsSync(envPath) ? await Bun.file(envPath).text() : "");
    const catalogPath = env.get("ONI_CATALOG_PATH")?.trim() || join(home, ".oni", "catalog.sqlite");
    if (!existsSync(catalogPath))
      throw new CliError(`no catalog at ${catalogPath}: nothing is declared yet (run the daemon once, then login or channel add)`);
    return Core.readCatalog(catalogPath, (database) => {
      const channel = openChannelStore(database, () => Date.now());
      const instances = createChannelInstanceStore(channel).list();
      const secrets = createSecretStore(channel);
      return {
        instances,
        persons: createPersonStore(channel).list(),
        sealed: new Set(instances.flatMap((instance) => (instance.credentialRef !== undefined && secrets.get(instance.credentialRef) !== undefined ? [instance.credentialRef] : []))),
      };
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
    login: {
      logins: OwnerLogins,
      declare: declareChannel,
      id: () => platformEntropy().id(),
      telegram: {
        apiId: mergeEnvFile(existsSync(envPath) ? readFileSync(envPath, "utf-8") : "").get("ONI_TELEGRAM_API_ID"),
        apiHash: mergeEnvFile(existsSync(envPath) ? readFileSync(envPath, "utf-8") : "").get("ONI_TELEGRAM_API_HASH"),
        dataDir: join(home, ".oni", "telegram", "owner"),
        isTTY: process.stdin.isTTY === true,
      },
    },
    channelHistory: { id: () => platformEntropy().id(), read: readChannelHistory },
    messagingFacts,
  };
}

export function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  return runCli(argv, createCliDeps());
}

if (import.meta.main) {
  const code = await main();
  if (code !== 0) process.exit(code);
}
