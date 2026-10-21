import { messageSource } from "./message-source";
import type { Message } from "@oni/protocol";
import { createAssistantMessage } from "../../src/core/journal/message-factory";

/** An assistant message for `sessionId` that optionally requests one pending tool call. */
export function assistantStep(
  text: string,
  sessionId: string,
  parentId: string,
  toolCall?: { id: string; callID: string; tool: string },
): Message.WithParts {
  const message = createAssistantMessage(text, parentId, sessionId, messageSource);
  if (toolCall !== undefined)
    message.parts.push({
      id: toolCall.id,
      messageID: message.info.id,
      sessionID: sessionId,
      type: "tool",
      callID: toolCall.callID,
      tool: toolCall.tool,
      state: { status: "pending", input: {} },
    });
  return message;
}
