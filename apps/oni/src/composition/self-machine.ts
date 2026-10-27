import {
  MachineRefusalError,
  type MachineError,
  type MachineHost,
} from "@oni/machines";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Machine, NamedError, type ObservationSink } from "@oni/protocol";
import { Effect, type Scope } from "effect";
import { z } from "zod";
import type { MachinePlane } from "../config";
import { spawnMclient, writeMclientSettings } from "./mclient";

// Promise band (#1423): the host's native observation callback signals admission.
// The single Effect.promise entry resumes scoped startup; the callback writes no ledger.

/**
 * The one typed startup refusal for the self-machine chain (#1271): listener
 * creation, mclient startup, loopback attach, and the pre-publish
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
  readonly pid: number;
  /**
   * Liveness probe run immediately before tool ports publish: one fs round
   * trip over the loopback attachment. ANY daemon reply — including a typed
   * capability or export refusal — proves the attachment serves requests;
   * only a dead or detached connection fails boot.
   */
  readonly ready: Effect.Effect<void, SelfAttachError>;
}

interface SelfAttachOptions {
  readonly host: MachineHost;
  readonly plane: MachinePlane;
  /** The unix loopback endpoint of the host listener the daemon dials. */
  readonly socketPath: string;
  readonly stateDir: string;
  readonly binary: string;
  readonly attachTimeoutMs: number;
  readonly events: Required<Pick<ObservationSink, "subscribe">>;
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
 * Boot step (c)+(d) of #1271: start mclient with the Owner's self exports,
 * dial the host's unix listener, and observe a newly admitted generation.
 * Enrollment bounds the capabilities the Rust drivers report as available.
 * A refused attachment is a boot failure, never a
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
    // The persisted generation belongs to this identity, not the self role.
    const identity = createHash("sha256").update(plane.self.id).digest("hex");
    const path = join(options.stateDir, "self", identity, "client.json");
    yield* Effect.try({
      try: () => writeMclientSettings(path, {
        machineId: plane.self.id, name: "self", host: "localhost",
        unix: options.socketPath, exports: plane.self.exports, tags: [],
        memoryBudgetMb: 96,
      }),
      catch: (cause) => selfAttachFailure(`self settings failed: ${String(cause)}`),
    });
    const previous = options.host.list().find((entry) => entry.machineId === plane.self.id)?.generation ?? 0;
    // Subscribe before spawning: a fast child cannot outrun the attachment signal.
    const admitted = Promise.withResolvers<void>();
    let generation = previous;
    const stopAttach = options.events.subscribe(Machine.Events.Attached, ({ machineId }) => {
      const attachment = options.host.list().find((entry) => entry.machineId === machineId);
      if (machineId === plane.self.id && attachment !== undefined && attachment.generation > previous)
        generation = attachment.generation;
    });
    // The host publishes Attached before replying. The first report proves the
    // client received that grant and can serve the liveness probe without a race.
    const stopReport = options.events.subscribe(Machine.Events.Reported, ({ machineId }) => {
      if (machineId === plane.self.id && generation > previous) admitted.resolve();
    });
    const unsubscribe = () => { stopAttach(); stopReport(); };
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    const child = yield* spawnMclient(path, options.binary).pipe(
      Effect.mapError((error) => selfAttachFailure(String(error))),
    );
    yield* Effect.promise(() => admitted.promise).pipe(
      Effect.raceFirst(child.closed.pipe(
        Effect.mapError((error) => selfAttachFailure(String(error))),
        Effect.flatMap((code) => Effect.fail(selfAttachFailure(`mclient exited before attachment: ${code}`))),
      )),
      Effect.timeoutOrElse({
        duration: options.attachTimeoutMs,
        orElse: () => Effect.fail(selfAttachFailure(`self attachment deadline exceeded: ${options.socketPath}`)),
      }),
      Effect.ensuring(Effect.sync(unsubscribe)),
    );
    // The watcher fiber dies first on a graceful scope close (finalizers run
    // in reverse order), so onClose fires only for an UNEXPECTED daemon close.
    yield* Effect.forkScoped(
      child.closed.pipe(
        Effect.exit,
        Effect.andThen(
          Effect.sync(() => options.onClose(selfAttachFailure("self machine mclient closed"))),
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
    return { machineId: plane.self.id, pid: child.pid, ready };
  });
}
