import {
  attachMachineDaemon,
  MachineRefusalError,
  type CodeRunner,
  type MachineError,
  type MachineHost,
} from "@oni/machines";
import { mkdirSync } from "node:fs";
import { Machine, NamedError } from "@oni/protocol";
import { Effect, type Scope } from "effect";
import { z } from "zod";
import type { MachinePlane } from "../config";

/**
 * The one typed startup refusal for the self-machine chain (#1271): listener
 * creation, in-process daemon startup, loopback attach, and the pre-publish
 * liveness probe all surface through this error. There is no local execution
 * fallback behind any of these failures.
 */
export const SelfAttachError = NamedError.create(
  "OniSelfAttachError",
  z.object({
    code: z.literal("self_attach_failed"),
    cause: z.string(),
  }),
);
export type SelfAttachError = InstanceType<typeof SelfAttachError>;

export function selfAttachFailure(cause: string): SelfAttachError {
  return new SelfAttachError({ code: "self_attach_failed", cause });
}

/**
 * The self daemon attaches over the unix loopback listener, which presents no
 * TLS key, so the host's pin check never applies to it; the enrollment still
 * needs the field, and all zeros can never match a real sha256 fingerprint.
 */
const SELF_PUBLIC_KEY = "0".repeat(64);

/** The Owner-bounded admission record the host consults for the self machine. */
export function selfEnrollment(plane: MachinePlane, enrolledAt: number): Machine.Enrollment {
  return Machine.Enrollment.parse({
    machineId: plane.self.id,
    name: "self",
    allowedCapabilities: [...plane.self.capabilities],
    allowedExports: plane.self.exports.map((entry) => entry.name),
    publicKey: SELF_PUBLIC_KEY,
    enrolledAt,
  });
}

export interface SelfMachine {
  readonly machineId: string;
  /**
   * Liveness probe run immediately before tool ports publish: one fs round
   * trip over the loopback attachment. ANY daemon reply — including a typed
   * capability or export refusal — proves the attachment serves requests;
   * only a dead or detached connection fails boot.
   */
  readonly ready: Effect.Effect<void, SelfAttachError>;
  readonly bindRunner: (runner: CodeRunner) => void;
}

interface SelfAttachOptions {
  readonly host: MachineHost;
  readonly plane: MachinePlane;
  /** The unix loopback endpoint of the host listener the daemon dials. */
  readonly socketPath: string;
  readonly id: () => string;
  readonly now: () => number;
  /** Where an unexpected post-boot close surfaces for lifecycle handling. */
  readonly onClose: (error: SelfAttachError) => void;
}

/** A reply that never arrived: the attachment is gone, not merely refusing. */
function isDetached(error: MachineError): boolean {
  if (error instanceof MachineRefusalError)
    return error.reason === "disconnected" || error.reason === "machine_not_attached";
  return true;
}

/**
 * Boot step (c)+(d) of #1271: start the in-process daemon with the Owner's
 * self exports and capabilities, dial the host's own unix listener, and
 * complete `machine.attach`. A refused attachment is a boot failure, never a
 * local fallback; an unexpected close after boot lands on `onClose`.
 */
export function attachSelfMachine(
  options: SelfAttachOptions,
): Effect.Effect<SelfMachine, SelfAttachError, Scope.Scope> {
  return Effect.gen(function* () {
    const { plane } = options;
    const inbox = plane.inbox;
    if (inbox !== undefined && plane.defaultMachine === plane.self.id)
      yield* Effect.try({ try: () => mkdirSync(inbox, { recursive: true, mode: 0o700 }), catch: String }).pipe(
        Effect.mapError((detail) => selfAttachFailure(`self inbox creation failed: ${detail}`)),
      );
    let runner: CodeRunner | undefined;
    const selfRunner: CodeRunner = {
      runCode: (request, call, signal) => runner === undefined
        ? Effect.fail(new MachineRefusalError({ reason: "machine_not_attached", message: "self machine runner is not bound" }))
        : runner.runCode(request, call, signal),
      peekCode: (cellId) => runner?.peekCode(cellId) ?? { stdout: "", stderr: "" },
      close: () => Effect.void,
    };
    const daemon = yield* attachMachineDaemon({
      socketPath: options.socketPath,
      id: options.id,
      // #1312: injected IPC callback bound for the self machine daemon.
      dispatcherBound: 256,
      offer: {
        machineId: plane.self.id,
        daemonVersion: "in-process",
        platform: `${process.platform}-${process.arch}`,
        offeredAt: options.now(),
        offeredCapabilities: [...plane.self.capabilities],
        exports: plane.self.exports.map((entry) => ({ ...entry })),
      },
      fsExports: new Map(plane.self.exports.map((entry) => [entry.name, entry.path])),
      ...(plane.self.capabilities.includes(Machine.WellKnownCapability.pythonKernel) ? { runner: selfRunner } : {}),
    }).pipe(Effect.mapError((error) => selfAttachFailure(String(error))));
    if (daemon.attachment.status !== "attached")
      return yield* Effect.fail(selfAttachFailure(`machine.attach refused: ${daemon.attachment.reason}`));
    // The watcher fiber dies first on a graceful scope close (finalizers run
    // in reverse order), so onClose fires only for an UNEXPECTED daemon close.
    yield* Effect.forkScoped(
      daemon.closed.pipe(
        Effect.exit,
        Effect.andThen(
          Effect.sync(() => options.onClose(selfAttachFailure("self machine daemon closed"))),
        ),
      ),
    );
    const firstExport = plane.self.exports[0];
    if (firstExport === undefined)
      return yield* Effect.fail(selfAttachFailure("self exports are empty"));
    const ready = options.host
      .get(plane.self.id)
      .fs.stat(firstExport.path)
      .pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          isDetached(error)
            ? Effect.fail(selfAttachFailure(`self machine disconnected during boot: ${String(error)}`))
            : Effect.void,
        ),
      );
    return { machineId: plane.self.id, ready, bindRunner: (next) => { runner = next; } };
  });
}
