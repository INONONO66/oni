import type { Message } from "@openomni/protocol";

/** Caller-owned time and identity; the factory refuses to reach for ambient clocks or entropy. */
export interface MessageSource {
  readonly now: () => number;
  readonly id: () => string;
}

function messageIdentity(sessionID: string, source: MessageSource, timeCreated?: number) {
  return {
    id: source.id(),
    sessionID,
    time: { created: timeCreated ?? source.now() },
    agent: sessionID,
  };
}

export function createUserMessage(
  content: string,
  sessionID: string,
  source: MessageSource,
  partMetadata?: Message.TextPart["metadata"],
  // Hydrated messages retain their recorded creation time.
  timeCreated?: number,
): Message.WithParts {
  const info: Message.UserMessage = {
    ...messageIdentity(sessionID, source, timeCreated),
    role: "user",
    model: { providerID: "", modelID: "" },
  };

  return withTextPart(info, content, partMetadata, source);
}

export function createAssistantMessage(
  content: string,
  parentID: string,
  sessionID: string,
  source: MessageSource,
  partMetadata?: Message.TextPart["metadata"],
  timeCreated?: number,
): Message.WithParts {
  const info: Message.AssistantMessage = {
    ...messageIdentity(sessionID, source, timeCreated),
    role: "assistant",
    parentID,
    modelID: "",
    providerID: "",
    path: { cwd: process.cwd(), root: process.cwd() },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };

  return withTextPart(info, content, partMetadata, source);
}

function withTextPart(
  info: Message.Info,
  content: string,
  metadata: Message.TextPart["metadata"],
  source: MessageSource,
): Message.WithParts {
  return {
    info,
    parts: [
      {
        id: source.id(),
        sessionID: info.sessionID,
        messageID: info.id,
        type: "text",
        text: content,
        ...(metadata === undefined ? {} : { metadata }),
      },
    ],
  };
}

/** Preserve durable prompt/result identity when hydrating its model projection. */
export function withMessageId(
  message: Message.WithParts,
  id: string | undefined,
): Message.WithParts {
  if (id === undefined) return message;
  return {
    info: { ...message.info, id },
    parts: message.parts.map((part, index) => ({
      ...part,
      id: `${id}:part:${index}`,
      messageID: id,
    })),
  };
}
