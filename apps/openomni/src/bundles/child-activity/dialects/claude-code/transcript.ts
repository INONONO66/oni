import { ChildLifecycleEvidence } from "@openomni/protocol";
import { z } from "zod";
import { DialectDecodeError, type TranscriptContext } from "../pack.js";

const Content = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool_use"), id: z.string().min(1) }),
  z.object({ type: z.literal("tool_result"), tool_use_id: z.string().min(1) }),
  z.object({ type: z.literal("text"), text: z.string() }),
]);
const RecordLine = z.object({
  type: z.enum(["user", "assistant"]),
  message: z.object({
    content: z.array(Content).min(1),
    stop_reason: z.string().nullable().optional(),
  }),
});

export function transcript(record: string, context: TranscriptContext): ChildLifecycleEvidence {
  let decoded: ReturnType<typeof RecordLine.safeParse>;
  try {
    decoded = RecordLine.safeParse(JSON.parse(record));
  } catch (error) {
    if (error instanceof SyntaxError) throw new DialectDecodeError("transcript", "malformed");
    throw error;
  }
  if (!decoded.success) throw new DialectDecodeError("transcript", "malformed");
  const { type, message } = decoded.data;
  const toolUse = message.content.find((block) => block.type === "tool_use");
  const toolResult = message.content.find((block) => block.type === "tool_result");
  if (type === "user" && toolUse !== undefined)
    throw new DialectDecodeError("transcript", "unsupported");
  if (type === "assistant" && toolResult !== undefined)
    throw new DialectDecodeError("transcript", "unsupported");
  const toolUseId = type === "assistant" ? toolUse?.id : toolResult?.tool_use_id;
  const phase =
    type === "assistant" && toolUse !== undefined
      ? "requested"
      : type === "user" && toolResult !== undefined
        ? "result"
        : type === "assistant" && message.stop_reason === "end_turn"
          ? "terminal"
          : "observed";
  return ChildLifecycleEvidence.parse({
    child: context.child,
    turn: context.turn,
    toolUseId,
    phase,
    ref: context.ref,
    diagnostics: [],
  });
}
