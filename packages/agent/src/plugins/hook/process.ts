import { Deferred, Effect, Schema, type Scope } from "effect";
import { readPlainJson, thrownAsError } from "../../core/api";
import { z } from "zod";
import { PlainValueSchema, type PlainValue } from "@oni/protocol";

/**
 * One hook PID per composed generation over JSON lines; it rides the
 * generation's Scope, whose finalizers await the last in-flight call before
 * killing it. Process state is never journaled; every failure maps to `hook_timeout`.
 */

/** The composed `how.ref` target the hook capability registers. */
export const HOOK_PROCESS_REF = "hook/process";

/**
 * A response line or unterminated buffer beyond this is a framing violation: the PID is poisoned,
 * every in-flight call settles `failure("framing")` and the child is killed — stdout never grows
 * unbounded on a misbehaving hook.
 */
const HOOK_MAX_LINE_BYTES = 64 * 1024;

export const HookGateVerdict = z.enum(["allow", "deny", "require_approval"]);
export type HookGateVerdict = z.infer<typeof HookGateVerdict>;

const HookResult = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("gate"),
    verdict: HookGateVerdict,
    reason: z.string().min(1).optional(),
  }),
  /** Restricted by the consuming row's declared rewritable fields. */
  z.strictObject({ type: z.literal("rewrite"), fields: z.record(z.string(), PlainValueSchema) }),
  z.strictObject({ type: z.literal("observe"), payload: PlainValueSchema }),
]);

const HookResponseLine = z.strictObject({ id: z.string().min(1), result: HookResult });

export interface HookCallInput {
  readonly id: string;
  readonly point: string;
  readonly event: string;
  readonly decisionInput: PlainValue;
  /** Bounds THIS call via the Effect clock; carried per request, never process-pool identity. */
  readonly timeoutMs: number;
  /**
   * A well-formed line answering THIS call beyond it fails only this call; the reader's absolute
   * `maxLineBytes` cap still poisons the PID.
   */
  readonly maxLineBytes?: number;
}

/**
 * Timeout, malformed framing (an out-of-vocabulary verdict included) and process death all map to
 * the one `hook_timeout`-coded failure a gate row journals as `deny{bundle_failure}`.
 */
export type HookOutcome =
  | { readonly kind: "gate"; readonly verdict: HookGateVerdict; readonly reason?: string }
  | { readonly kind: "rewrite"; readonly fields: Readonly<Record<string, PlainValue>> }
  | { readonly kind: "observe"; readonly payload: PlainValue }
  | {
      readonly kind: "failure";
      readonly code: "hook_timeout";
      readonly cause: "timeout" | "framing" | "exit";
    };

const failure = (cause: "timeout" | "framing" | "exit"): HookOutcome =>
  Object.freeze({ kind: "failure" as const, code: "hook_timeout" as const, cause });

/** The generation is refused, never partially activated. */
export class HookSpawnError extends Schema.TaggedError<HookSpawnError>(
  "@oni/agent/plugins/hook/HookSpawnError",
)("HookSpawnError", {
  command: Schema.Array(Schema.String),
  cause: Schema.ErrorInstance(),
}) {}

/** A late line is always a DECODED result; failures settle calls and are never late. */
export type HookLateOutcome = Exclude<HookOutcome, { readonly kind: "failure" }>;

/** A well-formed response line that arrived AFTER its call settled. */
export interface HookLateResult {
  readonly id: string;
  readonly outcome: HookLateOutcome;
}

export interface HookProcessConfig {
  /** The command IS the process identity: one PID per command per generation; bounds per call. */
  readonly command: readonly string[];
  /** The reader's ABSOLUTE line/buffer byte cap; default `HOOK_MAX_LINE_BYTES`. */
  readonly maxLineBytes?: number;
  /**
   * A well-formed line whose id no longer matches an in-flight call (it timed out) is handed here
   * instead of dropped; the consultant routes it back as an `action` row. Fire-and-forget.
   */
  readonly onLate?: (late: HookLateResult) => void;
}

/**
 * Exactly what `Bun.spawn` returns, narrowed to the used members so a test can inject a child whose
 * pipe fails — the ONE port for the write-failure path.
 */
export interface HookChildProcess {
  readonly pid: number;
  readonly stdout: AsyncIterable<Uint8Array>;
  /** `void` admits Bun's number-returning FileSink. */
  readonly stdin: { write(data: string): void; flush(): void };
  kill(): void;
  readonly exited: Promise<number>;
}

export interface HookProcess {
  readonly pid: number;
  /** The Scope finalizer drains this to zero before the kill. */
  readonly inFlight: () => number;
  call(input: HookCallInput): Effect.Effect<HookOutcome>;
  readonly exited: Effect.Effect<number>;
}

interface Pending {
  readonly waiter: Deferred.Deferred<HookOutcome>;
  readonly maxLineBytes: number;
}

function decodeLine(line: string): z.infer<typeof HookResponseLine> | undefined {
  const decoded = readPlainJson(line);
  if (decoded === undefined) return undefined;
  const parsed = HookResponseLine.safeParse(decoded);
  return parsed.success ? parsed.data : undefined;
}

function outcomeOf(result: z.infer<typeof HookResult>): HookLateOutcome {
  switch (result.type) {
    case "gate":
      return {
        kind: "gate",
        verdict: result.verdict,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      };
    case "rewrite":
      return { kind: "rewrite", fields: result.fields };
    case "observe":
      return { kind: "observe", payload: result.payload };
  }
}

/**
 * The ONLY process-spawning site of the hook path. Finalizer order on Scope close: await the last
 * in-flight call, stop the stdout reader, then kill the PID and await its exit.
 */
export function acquireHookProcess(
  config: HookProcessConfig,
  spawn: (command: readonly string[]) => HookChildProcess = (command) =>
    Bun.spawn({ cmd: [...command], stdin: "pipe", stdout: "pipe", stderr: "ignore" }),
): Effect.Effect<HookProcess, HookSpawnError, Scope.Scope> {
  return Effect.gen(function* () {
    const child = yield* Effect.try({
      try: () => spawn(config.command),
      catch: (cause) => new HookSpawnError({ command: config.command, cause: thrownAsError(cause) }),
    });

    const pending = new Map<string, Pending>();
    let closing = false;
    let dead = false;
    const drained = yield* Deferred.make<void>();

    const settleDrained = (): void => {
      if (closing && pending.size === 0) Deferred.doneUnsafe(drained, Effect.void);
    };

    const settleAll = (outcome: HookOutcome): void => {
      const waiters = [...pending.values()];
      pending.clear();
      for (const entry of waiters) Deferred.doneUnsafe(entry.waiter, Effect.succeed(outcome));
      settleDrained();
    };

    // ANY framing violation poisons the PID fail-closed: garbage cannot be
    // attributed to a request, so no later call may trust this process either.
    const maxLineBytes = config.maxLineBytes ?? HOOK_MAX_LINE_BYTES;
    const poisonFraming = (): void => {
      dead = true;
      settleAll(failure("framing"));
      child.kill();
    };

    const settleLine = (line: string): void => {
      const decoded = decodeLine(line);
      if (decoded === undefined) {
        // A malformed line poisons the PID, not just the in-flight calls.
        poisonFraming();
        return;
      }
      const entry = pending.get(decoded.id);
      if (entry === undefined) {
        // A response whose call already settled is a LATE result — surrendered
        // to the port, never dropped.
        config.onLate?.({ id: decoded.id, outcome: outcomeOf(decoded.result) });
        return;
      }
      pending.delete(decoded.id);
      // The per-call framing bound fails ONLY this call; the PID stays healthy.
      const outcome =
        Buffer.byteLength(line, "utf8") > entry.maxLineBytes
          ? failure("framing")
          : outcomeOf(decoded.result);
      Deferred.doneUnsafe(entry.waiter, Effect.succeed(outcome));
      settleDrained();
    };

    // Finalizer (runs LAST): kill the PID and await its exit.
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        child.kill();
        await child.exited;
      }),
    );

    yield* Effect.forkScoped(
      Effect.promise(async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of child.stdout) {
          buffer += decoder.decode(chunk, { stream: true });
          for (let cut = buffer.indexOf("\n"); cut >= 0; cut = buffer.indexOf("\n")) {
            const line = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 1);
            if (Buffer.byteLength(line, "utf8") > maxLineBytes) return poisonFraming();
            if (line.length > 0) settleLine(line);
          }
          // An unterminated line may never see its newline: bound the buffer too.
          if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) return poisonFraming();
        }
        // Stream end = the process died mid-conversation.
        dead = true;
        settleAll(failure("exit"));
      }),
    );

    // Finalizer (runs FIRST): the old PID survives until its last in-flight call.
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        closing = true;
        return pending.size === 0 ? Effect.void : Deferred.await(drained);
      }),
    );

    const call = (input: HookCallInput): Effect.Effect<HookOutcome> =>
      Effect.gen(function* () {
        if (dead || closing) return failure("exit");
        const waiter = yield* Deferred.make<HookOutcome>();
        pending.set(input.id, {
          waiter,
          maxLineBytes: input.maxLineBytes ?? Number.POSITIVE_INFINITY,
        });
        const wrote = yield* Effect.try(() => {
          child.stdin.write(
            `${JSON.stringify({ id: input.id, point: input.point, event: input.event, decisionInput: input.decisionInput })}\n`,
          );
          child.stdin.flush();
        }).pipe(Effect.isSuccess);
        if (!wrote) {
          pending.delete(input.id);
          settleDrained();
          return failure("exit");
        }
        // Interruption is the third way a call ends; without this finalizer the
        // pending entry leaks and the drain waits forever on a silent child.
        const settled = yield* Deferred.await(waiter).pipe(
          Effect.timeoutOption(input.timeoutMs),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              pending.delete(input.id);
              settleDrained();
            }),
          ),
        );
        if (settled._tag === "Some") return settled.value;
        pending.delete(input.id);
        settleDrained();
        return failure("timeout");
      });

    return {
      pid: child.pid,
      inFlight: () => pending.size,
      call,
      exited: Effect.promise(() => child.exited),
    };
  });
}
