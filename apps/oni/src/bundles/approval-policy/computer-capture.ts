import { Core } from "@oni/agent";
import { MachinesFailure, type CapturedResult, type CaptureRefusal, type MachineError, type MachineInputCapture } from "@oni/machines";
import { PlainValueSchema, type PlainValue } from "@oni/protocol";
import { Effect, Result } from "effect";
import type { ComputerPolicy } from "./computer-policy";

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
    }, (intent) => Effect.sync(() => {
      if (request.method.startsWith("machine.input.")) policy.injected(request.machineId);
    }).pipe(Effect.andThen(forward),
      Effect.result,
      Effect.map((result): PlainValue => {
        sent = result;
        if (Result.isFailure(result)) return { status: "failed", message: result.failure.message };
        policy.answered(intent.action.sessionId, request, result.success);
        return PlainValueSchema.parse(result.success);
      }),
    )).pipe(Effect.mapError((error) => new MachinesFailure({ operation: `${request.method}.capture`, cause: String(error) })));
    if (outcome.terminal !== "executed" || sent === undefined) {
      return policy.captureRefusal(request, outcome.terminal === "blocked_pre" ? outcome.reason : "permission_denied", outcome.terminal);
    }
    return yield* Result.match(sent, { onSuccess: Effect.succeed, onFailure: Effect.fail });
  });
}
