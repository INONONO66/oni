import type { Model } from "@openomni/agent";
type RunInput = Model.RunInput;
type Sink = Model.Sink;
import type { Message, Tool } from "@openomni/protocol";

export interface AssistantMessageOptions {
  readonly call?: number;
  readonly createdAt?: number;
  readonly id?: string;
  readonly parts?: Message.WithParts["parts"];
  readonly reason?: string;
  readonly text?: string;
  readonly tokens?: Message.AssistantMessage["tokens"];
}

export function assistantMessage(
  input: RunInput,
  options: AssistantMessageOptions = {},
): Message.WithParts {
  const sessionID = input.trace.sessionId;
  const id =
    options.id ??
    (options.call === undefined
      ? `fake-${sessionID}-${input.messages.length}`
      : `assistant-${options.call}`);
  const tokens = options.tokens ?? {
    input: 4,
    output: 5,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };
  const text = options.text ?? (options.call === undefined ? "" : `reply ${options.call}`);
  const parts = options.parts ?? [
    { id: `${id}-text`, sessionID, messageID: id, type: "text" as const, text },
  ];

  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: options.createdAt ?? Date.now() },
      parentID: "",
      modelID: input.model.id,
      providerID: input.model.providerID,
      agent: "resident",
      path: { cwd: "", root: "" },
      tokens,
    },
    parts: [
      ...parts.map((part) => ({ ...part, id: `${id}-${part.type}`, sessionID, messageID: id })),
      {
        id: `${id}-finish`,
        sessionID,
        messageID: id,
        type: "step-finish",
        reason: options.reason ?? "stop",
        tokens,
      },
    ],
  };
}

/** A fake provider emits invocation data, then reads the real executor's next-step result. */
export function requestToolStep(
  input: RunInput,
  sink: Sink,
  call: Tool.Call,
): Tool.Result | undefined {
  for (const message of input.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.callID !== call.id) continue;
      if (part.state.status === "completed")
        return { id: call.id, toolCallId: call.id, toolName: call.tool, content: part.state.output };
      if (part.state.status === "error")
        return {
          id: call.id,
          toolCallId: call.id,
          toolName: call.tool,
          content: part.state.error,
          isError: true,
        };
    }
  }
  const sessionID = input.trace.sessionId;
  sink.onMessage(
    assistantMessage(input, {
      reason: "tool-calls",
      parts: [
        {
          id: `${call.id}-part`,
          sessionID,
          messageID: `${call.id}-message`,
          type: "tool",
          callID: call.id,
          tool: call.tool,
          state: { status: "pending", input: call.input },
        },
      ],
    }),
  );
  return undefined;
}

/** send_message input that commissions one native child child under the calling session. */
export function commissionInput(send: {
  readonly message: string;
  readonly reply_to: string;
  readonly deadline_ms?: number;
  readonly spend_cap?: number;
}) {
  return {
    to: { kind: "new_session", role: "child", runner: "native", parent: "me" } as const,
    // #1258: delegation policy refuses child creation without a spend cap.
    spend_cap: 1,
    ...send,
  };
}
