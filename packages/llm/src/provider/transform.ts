import { toolWireName } from "@openomni/protocol";
import type { SDKMessage } from "../message";
import type { Provider } from ".";

export namespace ProviderTransform {
  type AssistantMessageContent = Extract<SDKMessage, { role: "assistant" }>["content"];
  type AssistantContentPart = Exclude<AssistantMessageContent, string>[number];
  type ToolContentPart = Extract<SDKMessage, { role: "tool" }>["content"][number];
  type NormalizableContentPart = Exclude<SDKMessage["content"], string>[number];

  export function normalizeMessages(msgs: SDKMessage[], model: Provider.Model): SDKMessage[] {
    if (isAnthropicPackage(model.api?.npm)) {
      return normalizeAnthropic(msgs, model.id);
    }

    return msgs;
  }

  function isAnthropicPackage(npm: string | undefined): boolean {
    return npm === "@ai-sdk/anthropic";
  }

  function normalizeAnthropic(msgs: SDKMessage[], modelId: string): SDKMessage[] {
    let result = msgs
      .map((msg) => {
        if (typeof msg.content === "string") {
          if (msg.content === "") return undefined;
          return msg;
        }
        if (!Array.isArray(msg.content)) return msg;

        // toModelMessages emits user/system content as strings (handled
        // above), so array content only ever arrives on assistant/tool
        // messages — the roles the empty-part filter and rebuild handle.
        if (msg.role !== "assistant" && msg.role !== "tool") return msg;

        const filtered = msg.content.filter((part) => {
          if (part.type === "text" || part.type === "reasoning") {
            return part.text !== "";
          }
          return true;
        });
        if (filtered.length === 0) return undefined;
        return buildMessageWithContent(msg, filtered);
      })
      .flatMap((msg) => (msg === undefined || msg.content === "" ? [] : [msg]));

    if (modelId.includes("claude")) {
      result = result.map((msg) => {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          return { ...msg, content: msg.content.map(sanitizeAssistantContentPart) };
        }
        if (msg.role === "tool" && Array.isArray(msg.content)) {
          return { ...msg, content: msg.content.map(sanitizeToolContentPart) };
        }
        return msg;
      });
    }

    return applyAnthropicCaching(result);
  }

  const CACHE_CONTROL = { type: "ephemeral" as const, ttl: "1h" as const };

  /**
     * Three of Anthropic's four breakpoints at the stable->volatile seams, so a
     * per-turn system mutation invalidates the system entry but not tools; 1h
     * TTL because turns arrive minutes apart. run.ts marks system and tools.
     */
  export function applyAnthropicCaching(msgs: SDKMessage[]): SDKMessage[] {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role !== "user") continue;
      return msgs.map((msg, index) => {
        if (index !== i) return msg;
        const existing = msg.providerOptions;
        return {
          ...msg,
          providerOptions: {
            ...existing,
            anthropic: { ...existing?.anthropic, cacheControl: CACHE_CONTROL },
          },
        };
      });
    }
    return msgs;
  }

  /**
   * providerOptions carrying the Anthropic cache breakpoint, or undefined for
   * non-Anthropic models. run.ts attaches this to the system message and the
   * last tool definition (namespaced under `anthropic`, so it would be inert
   * elsewhere — the gate just avoids advertising foreign vocabulary).
   */
  export function anthropicCacheOptions(
    model: Provider.Model,
  ): { anthropic: { cacheControl: typeof CACHE_CONTROL } } | undefined {
    if (!isAnthropicPackage(model.api?.npm)) return undefined;
    return { anthropic: { cacheControl: CACHE_CONTROL } };
  }

  function sanitizeAssistantContentPart(part: AssistantContentPart): AssistantContentPart {
    if (part.type !== "tool-call") return part;
    return {
      ...part,
      toolCallId: sanitizeToolCallID(part.toolCallId),
    };
  }

  function sanitizeToolContentPart(part: ToolContentPart): ToolContentPart {
    if (part.type !== "tool-result") return part;
    return {
      ...part,
      toolCallId: sanitizeToolCallID(part.toolCallId),
    };
  }

  function sanitizeToolCallID(toolCallID: string): string {
    return toolCallID.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  /**
     * Every provider SDK rejects a dotted name, so the wire name is coerced to
     * `^[a-zA-Z0-9_-]{1,128}$` for ALL providers; the internal dotted
     * vocabulary is unchanged and the SDK's key-match dispatch makes the reverse map free.
     */
  export function sanitizeToolName(name: string): string {
    return toolWireName(name);
  }

  function buildMessageWithContent(
    msg: Extract<SDKMessage, { role: "assistant" | "tool" }>,
    content: NormalizableContentPart[],
  ): SDKMessage {
    if (msg.role === "assistant") {
      return {
        ...msg,
        content: content.flatMap((part) => {
          const assistantPart = assistantContentPart(part);
          return assistantPart === undefined ? [] : [assistantPart];
        }),
      };
    }
    return {
      ...msg,
      content: content.flatMap((part) => {
        const toolPart = toolContentPart(part);
        return toolPart === undefined ? [] : [toolPart];
      }),
    };
  }

  function assistantContentPart(part: NormalizableContentPart): AssistantContentPart | undefined {
    switch (part.type) {
      case "text":
      case "file":
      case "reasoning":
      case "tool-call":
      case "tool-result":
      case "tool-approval-request":
        return part;
      default:
        return undefined;
    }
  }

  function toolContentPart(part: NormalizableContentPart): ToolContentPart | undefined {
    switch (part.type) {
      case "tool-result":
      case "tool-approval-response":
        return part;
      default:
        return undefined;
    }
  }
}
