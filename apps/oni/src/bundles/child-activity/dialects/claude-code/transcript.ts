import { ChildLifecycleEvidence } from "@oni/protocol";
import { z } from "zod";
import { DialectDecodeError, type TranscriptContext } from "../pack.js";

const Content = z.object({
  type: z.string().min(1),
  id: z.string().min(1).optional(),
  tool_use_id: z.string().min(1).optional(),
  text: z.string().optional(),
});
const RecordLine = z.object({
  type: z.string().min(1),
  message: z
    .object({
      content: z.union([z.string(), z.array(Content).min(1)]),
      stop_reason: z.string().nullable().optional(),
    })
    .optional(),
  toolDenialKind: z.string().min(1).optional(),
});

function supportedContent(record: z.infer<typeof RecordLine>): z.infer<typeof Content>[] {
  if (record.type !== "user" && record.type !== "assistant")
    throw new DialectDecodeError("transcript", "unsupported");
  const content = record.message?.content;
  if (content === undefined) throw new DialectDecodeError("transcript", "malformed");
  if (typeof content === "string") throw new DialectDecodeError("transcript", "unsupported");
  for (const block of content) {
    if (!["tool_use", "tool_result", "text"].includes(block.type))
      throw new DialectDecodeError("transcript", "unsupported");
    if (
      (block.type === "tool_use" && block.id === undefined) ||
      (block.type === "tool_result" && block.tool_use_id === undefined) ||
      (block.type === "text" && block.text === undefined)
    )
      throw new DialectDecodeError("transcript", "malformed");
  }
  return content;
}

function evidenceFields(
  record: z.infer<typeof RecordLine>,
  content: z.infer<typeof Content>[],
): Pick<ChildLifecycleEvidence, "phase" | "toolUseId"> {
  const toolUse = content.find((block) => block.type === "tool_use");
  const toolResult = content.find((block) => block.type === "tool_result");
  if (
    (record.type === "user" && toolUse !== undefined) ||
    (record.type === "assistant" && toolResult !== undefined)
  )
    throw new DialectDecodeError("transcript", "unsupported");
  const toolUseId = record.type === "assistant" ? toolUse?.id : toolResult?.tool_use_id;
  const phase =
    record.type === "user" && record.toolDenialKind !== undefined && toolResult !== undefined
      ? "decided"
      : toolUse !== undefined
        ? "requested"
        : toolResult !== undefined
          ? "result"
          : record.type === "assistant" && record.message?.stop_reason === "end_turn"
            ? "terminal"
            : "observed";
  return { phase, toolUseId };
}

export function transcript(record: string, context: TranscriptContext): ChildLifecycleEvidence {
  let decoded: ReturnType<typeof RecordLine.safeParse>;
  try {
    decoded = RecordLine.safeParse(JSON.parse(record));
  } catch (error) {
    if (error instanceof SyntaxError) throw new DialectDecodeError("transcript", "malformed");
    throw error;
  }
  if (!decoded.success) throw new DialectDecodeError("transcript", "malformed");
  const content = supportedContent(decoded.data);
  const { phase, toolUseId } = evidenceFields(decoded.data, content);
  return ChildLifecycleEvidence.parse({
    child: context.child,
    turn: context.turn,
    toolUseId,
    phase,
    ref: context.ref,
    diagnostics: [],
  });
}
