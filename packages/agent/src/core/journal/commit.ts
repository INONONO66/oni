import type { OpenTurn } from "../store/session-reads";
import { SessionGeneration, type PlainValue } from "@oni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import { GenerationUnavailable } from "../ports/failure";
import { RunReasonCode } from "../ports/reason-codes";
import type { SessionKernel } from "../session/entity";
import type { SessionRunnerResult, SessionTool } from "../session/run";

import { SessionPolicyRefusal } from "./messages";

export function toolSnapshot(tool: SessionTool): SessionGeneration.Tool {
  return SessionGeneration.Tool.parse(tool);
}

export function policyRefusalResult(reason: string): SessionRunnerResult {
  const cause = new SessionPolicyRefusal(reason);
  return { kind: "error", text: cause.message, cause };
}

export function sessionRunnerResultValue(result: SessionRunnerResult): PlainValue {
  if (result.kind === "waiting") return { ...result, alarmIds: [...result.alarmIds] };
  if (result.kind === "interrupted") {
    return { kind: result.kind, ...(result.text === undefined ? {} : { text: result.text }) };
  }
  if (result.kind === "error") {
    return {
      kind: result.kind,
      text: result.text,
      ...(result.reported === undefined ? {} : { reported: result.reported }),
    };
  }
  return {
    kind: result.kind,
    text: result.text,
    ...(result.finishReason === undefined ? {} : { finishReason: result.finishReason }),
    ...(result.usage === undefined
      ? {}
      : {
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
            ...(result.usage.reasoningTokens === undefined
              ? {}
              : { reasoningTokens: result.usage.reasoningTokens }),
            ...(result.usage.cacheReadTokens === undefined
              ? {}
              : { cacheReadTokens: result.usage.cacheReadTokens }),
            ...(result.usage.cacheWriteTokens === undefined
              ? {}
              : { cacheWriteTokens: result.usage.cacheWriteTokens }),
          },
        }),
  };
}

const SessionUsage = z.strictObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  reasoningTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
});

const SessionResult = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("result"),
    text: z.string(),
    finishReason: z.enum(["stop", "max-steps", RunReasonCode.Stalled]).optional(),
    usage: SessionUsage.optional(),
  }),
  z.strictObject({
    kind: z.literal("waiting"),
    text: z.string(),
    reason: z.literal("live_wait"),
    alarmIds: z.array(z.string()).nonempty(),
  }),
  z.strictObject({ kind: z.literal("interrupted"), text: z.string().optional() }),
  z.strictObject({
    kind: z.literal("error"),
    text: z.string(),
    reported: z.literal(true).optional(),
  }),
]);

export function sessionRunnerResultFromValue(value: PlainValue): SessionRunnerResult | undefined {
  const result = SessionResult.safeParse(value);
  return result.success ? result.data : undefined;
}

export function generationForOpen(
  kernel: SessionKernel,
  open: OpenTurn,
): Effect.Effect<SessionGeneration.Snapshot, GenerationUnavailable> {
  const snapshot = kernel.generationFor(open.action.sessionId, open.toolsGeneration);
  if (
    snapshot === undefined ||
    snapshot.toolsHash !== open.toolsHash ||
    snapshot.systemHash !== open.systemHash ||
    snapshot.policyGeneration !== open.policyGeneration
  ) {
    return Effect.fail(new GenerationUnavailable({ generation: open.toolsGeneration }));
  }
  return Effect.succeed(snapshot);
}
