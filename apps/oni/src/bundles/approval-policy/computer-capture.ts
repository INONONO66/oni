import { Core } from "@oni/agent";
import { MachinesFailure, type CapturedResult, type CaptureRefusal, type MachineError, type MachineInputCapture } from "@oni/machines";
import { Machine, PlainValueSchema, type PlainValue } from "@oni/protocol";
import { Effect, Result } from "effect";
import type { ComputerPolicy } from "./computer-policy";

function refusal(
  policy: ComputerPolicy,
  machineId: string,
  outcome: { readonly terminal: string; readonly reason?: string },
): Machine.ComputerRefusal {
  if (outcome.terminal === "blocked_pre" && outcome.reason === "paused:human_input") return policy.humanRefusal(machineId);
  const parsed = Machine.ComputerRefusal.safeParse({
    status: "refused", reason: outcome.terminal === "blocked_pre" ? outcome.reason : "permission_denied",
  });
  return parsed.success ? parsed.data : {
    status: "refused", reason: "permission_denied", message: `machine input not executed: ${outcome.terminal}`,
  };
}

export function computerCapture(policy: ComputerPolicy) {
  return <R extends CapturedResult>(
    request: MachineInputCapture,
    forward: Effect.Effect<R, MachineError>,
  ): Effect.Effect<R | CaptureRefusal, MachineError> => Effect.gen(function* () {
    const executor = yield* Core.optionalExecutor;
    if (executor === undefined) return { status: "refused", reason: "permission_denied", message: "machine input requires an active tool invocation" } as const;
    let sent: Result.Result<R, MachineError> | undefined;
    const outcome = yield* executor.run({
      kind: "tool", op: request.method, intent: policy.intent(request),
      effect: { category: "execution" }, recovery: "ambiguous_no_replay",
    }, (intent) => forward.pipe(
      Effect.result,
      Effect.map((result): PlainValue => {
        sent = result;
        if (Result.isFailure(result)) return { status: "failed", message: result.failure.message };
        policy.answered(intent.action.sessionId, request, result.success);
        return PlainValueSchema.parse(result.success);
      }),
    )).pipe(Effect.mapError((error) => new MachinesFailure({ operation: `${request.method}.capture`, cause: String(error) })));
    if (outcome.terminal !== "executed" || sent === undefined) {
      return refusal(policy, request.machineId, outcome);
    }
    return Result.isSuccess(sent) ? sent.success : yield* Effect.fail(sent.failure);
  });
}
