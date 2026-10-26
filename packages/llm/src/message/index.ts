import { Delivery, type Message, type PlainObject } from "@oni/protocol";
import type { ModelMessage } from "ai";
import type { Provider } from "../provider";
import { ProviderTransform } from "../provider/transform";
import type { UserBlock } from "./parts";

export type SDKMessage = ModelMessage;
export type SystemMessage = Extract<SDKMessage, { role: "system" }>;
type AssistantMessage = Extract<SDKMessage, { role: "assistant" }>;
type ToolMessage = Extract<SDKMessage, { role: "tool" }>;
type AssistantContentBlock = Exclude<AssistantMessage["content"], string>[number];
type AssistantTextBlock = Extract<AssistantContentBlock, { type: "text" }>;
type AssistantReasoningBlock = Extract<AssistantContentBlock, { type: "reasoning" }>;
type AssistantToolCallBlock = Extract<AssistantContentBlock, { type: "tool-call" }>;
type ToolResultBlock = Extract<ToolMessage["content"][number], { type: "tool-result" }>;

/**
 * A reasoning signature is valid only for the exact model that produced it, so it is resent only
 * when {providerID, modelID} match the stored pair; other providers ignore the foreign `anthropic`
 * namespace.
 */
function buildAssistantReasoningBlock(
  part: Message.ReasoningPart,
  resendSignature: boolean,
): AssistantReasoningBlock {
  if (resendSignature && part.signature !== undefined) {
    return {
      type: "reasoning",
      text: part.text,
      providerOptions: { anthropic: { signature: part.signature } },
    };
  }
  return { type: "reasoning", text: part.text };
}

function buildToolCallBlock(call: {
  id: string;
  tool: string;
  input: PlainObject;
}): AssistantToolCallBlock {
  return {
    type: "tool-call",
    toolCallId: call.id,
    // Wire name: prior turns must re-serialize the same provider-pattern-safe
    // name the tools array advertised, or the request is rejected on replay.
    // Runs for every provider (this builder is provider-agnostic).
    toolName: ProviderTransform.sanitizeToolName(call.tool),
    input: call.input,
    providerExecuted: false,
  };
}

function buildToolResultBlock(result: {
  id: string;
  tool: string;
  output: string;
}): ToolResultBlock {
  return {
    type: "tool-result",
    toolCallId: result.id,
    // Wire name, matching the tool-call block above (all providers).
    toolName: ProviderTransform.sanitizeToolName(result.tool),
    output: { type: "text", value: result.output },
  };
}

export type SDKToolValue =
  | string
  | number
  | bigint
  | boolean
  | symbol
  | null
  | Date
  | object
  | (() => void);

export function stringifyToolOutput(output: SDKToolValue | Error | undefined): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  if (output instanceof Error) return output.message || String(output);
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}

function buildToolResult(result: Message.ToolPart): ToolMessage {
  const output =
    result.state.status === "completed"
      ? stringifyToolOutput(result.state.output)
      : result.state.status === "error"
        ? `Error: ${result.state.error}`
        : "[Tool execution was interrupted]";
  return {
    role: "tool",
    content: [buildToolResultBlock({ id: result.callID, tool: result.tool, output })],
  };
}

type AssistantWithParts = { info: Message.AssistantMessage; parts: Message.Part[] };

function buildAssistantMessage(msg: AssistantWithParts, model: Provider.Model): SDKMessage[] {
  if (msg.info.finish === "error") return [];
  const resendSignature = msg.info.providerID === model.providerID && msg.info.modelID === model.id;
  const textContent: string[] = [];
  const reasoningBlocks: AssistantReasoningBlock[] = [];
  const toolCalls: AssistantToolCallBlock[] = [];
  const toolResults: ToolMessage[] = [];
  for (const part of msg.parts) {
    if (part.type === "text") textContent.push(part.text);
    if (part.type === "reasoning")
      reasoningBlocks.push(buildAssistantReasoningBlock(part, resendSignature));
    if (part.type === "tool") {
      toolCalls.push(
        buildToolCallBlock({ id: part.callID, tool: part.tool, input: part.state.input }),
      );
      toolResults.push(buildToolResult(part));
    }
  }
  return assembleAssistantMessages(textContent, reasoningBlocks, toolCalls, toolResults);
}

function assembleAssistantMessages(
  textContent: string[],
  reasoningBlocks: AssistantReasoningBlock[],
  toolCalls: AssistantToolCallBlock[],
  toolResults: ToolMessage[],
): SDKMessage[] {
  if (toolCalls.length > 0) {
    const content: Array<AssistantTextBlock | AssistantReasoningBlock | AssistantToolCallBlock> = [
      ...reasoningBlocks,
    ];
    if (textContent.length > 0) content.push({ type: "text", text: textContent.join("\n") });
    content.push(...toolCalls);
    return [{ role: "assistant", content }, ...toolResults];
  }
  if (reasoningBlocks.length > 0) {
    const content: Array<AssistantTextBlock | AssistantReasoningBlock> = [...reasoningBlocks];
    if (textContent.length > 0) content.push({ type: "text", text: textContent.join("\n") });
    return [{ role: "assistant", content }];
  }
  return textContent.length > 0 ? [{ role: "assistant", content: textContent.join("\n") }] : [];
}

function messageToSDK(
  msg: Message.WithParts,
  model: Provider.Model,
  blocksById?: ReadonlyMap<string, readonly UserBlock[]>,
): SDKMessage[] {
  if (msg.info.role === "assistant") {
    return buildAssistantMessage({ info: msg.info, parts: msg.parts }, model);
  }
  if (blocksById === undefined) {
    const content = msg.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    return content.length > 0 ? [{ role: "user", content }] : [];
  }
  const blocks: UserBlock[] = [];
  let text: string[] = [];
  let hasFile = false;
  for (const part of msg.parts) {
    if (part.type === "text") {
      text.push(part.text);
      continue;
    }
    if (part.type !== "file") continue;
    hasFile = true;
    if (text.length > 0) blocks.push({ type: "text", text: text.join("\n") });
    text = [];
    blocks.push(...(blocksById.get(part.id) ?? [{ type: "text", text: Delivery.text([part]) }]));
  }
  if (text.length > 0) blocks.push({ type: "text", text: text.join("\n") });
  if (hasFile) return blocks.length > 0 ? [{ role: "user", content: blocks }] : [];
  const content = text.join("\n");
  return content.length > 0 ? [{ role: "user", content }] : [];
}

export function toModelMessages(
  messagesWithParts: Message.WithParts[],
  model: Provider.Model,
  blocksById?: ReadonlyMap<string, readonly UserBlock[]>,
): SDKMessage[] {
  const coreMessages: SDKMessage[] = [];
  for (const msg of messagesWithParts) coreMessages.push(...messageToSDK(msg, model, blocksById));
  return ProviderTransform.normalizeMessages(coreMessages, model);
}
