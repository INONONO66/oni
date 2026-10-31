import { Core } from "@oni/agent";
import { MachinesFailure, type CapturedResult, type CaptureRefusal, type MachineError, type MachineInputCapture } from "@oni/machines";
import { Machine, PlainValueSchema, type PlainValue } from "@oni/protocol";
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
    }, (intent) => forward.pipe(
      Effect.result,
      Effect.map((result): PlainValue => {
        sent = result;
        if (Result.isFailure(result)) return { status: "failed", message: result.failure.message };
        policy.answered(intent.action.sessionId, request, result.success);
        if (request.method === Machine.WireMethod.ClipboardRead && result.success.status === "ok" &&
          "changeCount" in result.success && !("previous" in result.success)) {
          const formats = ["text", "html", "image"].filter((format) => format in result.success);
          const bytes = Object.entries(result.success).reduce((count, [format, content]) => {
            return count + (typeof content === "string" ? format === "image"
              ? Buffer.from(content, "base64").length : Buffer.byteLength(content) : 0);
          }, 0);
          return { status: "ok", changeCount: result.success.changeCount, formats, bytes };
        }
        return PlainValueSchema.parse(result.success);
      }),
    )).pipe(Effect.mapError((error) => new MachinesFailure({ operation: `${request.method}.capture`, cause: String(error) })));
    if (outcome.terminal !== "executed" || sent === undefined) {
      const refused = Machine.ComputerRefusal.safeParse({
        status: "refused", reason: outcome.terminal === "blocked_pre" ? outcome.reason : "permission_denied",
      });
      return refused.success ? refused.data : { status: "refused", reason: "permission_denied", message: `machine input not executed: ${outcome.terminal}` } as const;
    }
    return Result.isSuccess(sent) ? sent.success : yield* Effect.fail(sent.failure);
  });
}
