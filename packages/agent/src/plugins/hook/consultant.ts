import { canonicalDigest, type PlainValue } from "@oni/protocol";
import { Clock, Effect, type Scope } from "effect";
import { z } from "zod";
import type {
  ConsultantSeed,
  ConsultInput,
  GateHandlerResult,
  NamedConsultant,
} from "../../core/api";
import {
  acquireHookProcess,
  HOOK_PROCESS_REF,
  type HookLateOutcome,
  type HookLateResult,
  type HookOutcome,
  type HookProcess,
  type HookSpawnError,
} from "./process";

/**
 * Every distinct command on the generation's hook rows spawns its ONE PID
 * eagerly inside the generation Scope, so a hook that cannot spawn refuses
 * the whole generation; every call failure folds to deny with
 * `reason: "bundle_failure"`, never a widened verdict vocabulary.
 */

const HookRowParams = z.looseObject({
  event: z.string().min(1),
  command: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive(),
  maxLineBytes: z.number().int().positive().optional(),
});

/** Pool identity is the COMMAND (argv): timeout and framing bounds are per-call, never pool key. */
function processKey(params: z.infer<typeof HookRowParams>): string {
  return canonicalDigest({ command: params.command });
}

function denyResult(cause: string): GateHandlerResult {
  return {
    verdict: "deny",
    payload: {
      ref: HOOK_PROCESS_REF,
      verdict: "deny",
      reason: "bundle_failure",
      code: "hook_timeout",
      cause,
    },
  };
}

function resultOf(outcome: HookOutcome): GateHandlerResult {
  switch (outcome.kind) {
    case "gate":
      return {
        verdict: outcome.verdict,
        payload: {
          ref: HOOK_PROCESS_REF,
          verdict: outcome.verdict,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        },
      };
    case "rewrite":
      return {
        value: outcome.fields,
        payload: { ref: HOOK_PROCESS_REF, output: canonicalDigest(outcome.fields) },
      };
    case "observe":
      return { payload: outcome.payload };
    case "failure":
      return denyResult(outcome.cause);
  }
}

/** Late results re-enter through `seed.late` as action rows; a seed without the port drops them. */
/** Older entries evict first. */
const LATE_WINDOW = 256;

/** Failures are never late: they WERE the fold. */
function latePayloadOf(outcome: HookLateOutcome): PlainValue {
  switch (outcome.kind) {
    case "gate":
      return {
        type: "gate",
        verdict: outcome.verdict,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      };
    case "rewrite":
      return { type: "rewrite", fields: outcome.fields };
    case "observe":
      return { type: "observe", payload: outcome.payload };
  }
}

export function hookProcessConsultant(
  seed: ConsultantSeed,
): Effect.Effect<NamedConsultant["consult"], HookSpawnError, Scope.Scope> {
  return Effect.gen(function* () {
    // Timed-out calls keyed by wire id with the journal cursor captured at
    // CALL time: a late line re-enters as an `action` row carrying that `after`.
    const timedOut = new Map<string, number | null>();
    const lateWindow = seed.lateWindow ?? LATE_WINDOW;
    const rememberTimeout = (id: string, after: number | null): void => {
      timedOut.set(id, after);
      for (const key of timedOut.keys()) {
        if (timedOut.size <= lateWindow) break;
        timedOut.delete(key);
      }
    };
    const routeLate = (late: HookLateResult): void => {
      if (!timedOut.has(late.id)) return;
      const after = timedOut.get(late.id);
      timedOut.delete(late.id);
      seed.late?.({
        hook: HOOK_PROCESS_REF,
        id: late.id,
        result: latePayloadOf(late.outcome),
        ...(after === null ? {} : { after }),
      });
    };
    // Spawned EAGERLY in the generation's Scope: a missing executable refuses
    // the generation.
    const pool = new Map<string, HookProcess>();
    for (const row of seed.rows) {
      const params = HookRowParams.safeParse(row.how.params);
      if (!params.success) continue; // the row denies at consult time
      const key = processKey(params.data);
      if (pool.has(key)) continue;
      pool.set(
        key,
        yield* acquireHookProcess({ command: params.data.command, onLate: routeLate }),
      );
    }
    let calls = 0;
    return (input: ConsultInput): Effect.Effect<GateHandlerResult> =>
      Effect.suspend(() => {
        const params = HookRowParams.safeParse(input.params);
        if (!params.success) return Effect.succeed(denyResult("invalid_params"));
        const hook = pool.get(processKey(params.data));
        if (hook === undefined) return Effect.succeed(denyResult("process_unavailable"));
        calls += 1;
        const id = `${input.rowId}#${calls}`;
        const after = seed.cursor?.() ?? null;
        const call = hook
          .call({
            id,
            point: input.point,
            event: params.data.event,
            decisionInput: input.value,
            timeoutMs: params.data.timeoutMs,
            ...(params.data.maxLineBytes === undefined
              ? {}
              : { maxLineBytes: params.data.maxLineBytes }),
          })
          .pipe(
            Effect.map((outcome) => {
              if (outcome.kind === "failure" && outcome.cause === "timeout")
                rememberTimeout(id, after);
              return resultOf(outcome);
            }),
          );
        // The deadline runs on the seeded clock when one is injected (TestClock).
        return seed.clock === undefined ? call : Effect.provideService(call, Clock.Clock, seed.clock);
      });
  });
}
