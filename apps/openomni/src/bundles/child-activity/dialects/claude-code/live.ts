import { ChildLifecycleEvidence } from "@openomni/protocol";
import { z } from "zod";
import { DialectDecodeError, type LiveContext } from "../pack.js";

const Payload = z.object({
  hook_event_name: z.string().min(1),
  tool_use_id: z.string().min(1).optional(),
});
const SpoolLine = z.strictObject({
  seq: z.number().int().nonnegative(),
  event: z.string().min(1),
  receivedAt: z.number().int().nonnegative(),
  payload: Payload,
  decision: z.enum(["allow", "deny"]).optional(),
});

/** `decision` belongs to our spool envelope, not the vendor hook input. */
export function live(line: string, context: LiveContext): ChildLifecycleEvidence {
  let decoded: ReturnType<typeof SpoolLine.safeParse>;
  try {
    decoded = SpoolLine.safeParse(JSON.parse(line));
  } catch (error) {
    if (error instanceof SyntaxError) throw new DialectDecodeError("live", "malformed");
    throw error;
  }
  if (!decoded.success) throw new DialectDecodeError("live", "malformed");
  const { seq, event, receivedAt, payload, decision } = decoded.data;
  if (event !== payload.hook_event_name) throw new DialectDecodeError("live", "malformed");
  if (seq <= context.lastSeq) throw new DialectDecodeError("live", "stale_seq", { seq });
  let phase: ChildLifecycleEvidence["phase"];
  switch (event) {
    case "SessionStart":
    case "UserPromptSubmit":
    case "Stop":
      phase = "observed";
      break;
    case "PreToolUse":
      phase = "requested";
      break;
    case "PermissionRequest":
      phase = decision === undefined ? "waiting" : "decided";
      break;
    case "PostToolUse":
      phase = "result";
      break;
    case "SessionEnd":
      phase = "terminal";
      break;
    default:
      throw new DialectDecodeError("live", "unsupported");
  }
  return ChildLifecycleEvidence.parse({
    child: context.child,
    turn: context.turn,
    toolUseId: payload.tool_use_id,
    phase,
    ref: { kind: "hook", event, seq, receivedAt },
    diagnostics: [],
  });
}
