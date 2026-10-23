import { AppInvariantError } from "../invariant";
import { canonicalDigest } from "@oni/protocol";
import type { createGatewayRouter } from "@oni/channels";
import type { SessionReadModel } from "./cluster-runtime";

type Request = Parameters<Parameters<typeof createGatewayRouter>[0]["run"]>[1];

export function messageDecisionRules(
  kernel: SessionReadModel,
  sessionId: string,
  request: Request,
): readonly string[] {
  const inputHash = canonicalDigest({
    kind: "message",
    phase: "pre",
    op: request.op,
    role: kernel.row(sessionId).role,
    sessionId,
    message: request.message,
    value: request.intent,
  });
  const ids = kernel.policyDecisionRuleIds(sessionId, inputHash);
  if (ids === undefined) throw new AppInvariantError("message pre decision is missing");
  return ids;
}
