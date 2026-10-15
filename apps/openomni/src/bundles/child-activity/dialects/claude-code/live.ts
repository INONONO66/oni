import { ChildLifecycleEvidence } from "@openomni/protocol";
import { z } from "zod";
import { DialectDecodeError, type LiveContext } from "../pack.js";

const Payload = z.object({
  hook_event_name: z.enum([
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
    "SessionEnd",
  ]),
  tool_use_id: z.string().min(1).optional(),
  permission_decision: z.enum(["allow", "deny"]).optional(),
});
const SpoolLine = z.strictObject({
  seq: z.number().int().nonnegative(),
  receivedAt: z.number().int().nonnegative(),
  payload: Payload,
});

export function live(line: string, context: LiveContext): ChildLifecycleEvidence {
  let decoded: ReturnType<typeof SpoolLine.safeParse>;
  try {
    decoded = SpoolLine.safeParse(JSON.parse(line));
  } catch (error) {
    if (error instanceof SyntaxError) throw new DialectDecodeError("live", "malformed");
    throw error;
  }
  if (!decoded.success) throw new DialectDecodeError("live", "malformed");
  const { seq, receivedAt, payload } = decoded.data;
  if (seq <= context.lastSeq) throw new DialectDecodeError("live", "stale_seq");
  let phase: ChildLifecycleEvidence["phase"];
  switch (payload.hook_event_name) {
    case "SessionStart":
    case "UserPromptSubmit":
    case "Stop":
      phase = "observed";
      break;
    case "PreToolUse":
      phase = "requested";
      break;
    case "PermissionRequest":
      phase = payload.permission_decision === undefined ? "waiting" : "decided";
      break;
    case "PostToolUse":
      phase = "result";
      break;
    case "SessionEnd":
      phase = "terminal";
      break;
  }
  return ChildLifecycleEvidence.parse({
    child: context.child,
    turn: context.turn,
    toolUseId: payload.tool_use_id,
    phase,
    ref: { kind: "hook", event: payload.hook_event_name, seq, receivedAt },
    diagnostics: [],
  });
}
