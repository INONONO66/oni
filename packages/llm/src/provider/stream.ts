import { Operational, PlainObjectSchema, type Tool } from "@oni/protocol";
import {
  jsonSchema,
  isStepCount,
  type streamText,
  type StopCondition,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { toModelMessages, type SystemMessage } from "../message";
import { ProviderEvent, type StreamEvent } from "../processor/event-schema";
import type { RunInput } from "../run";
import type { getLanguage } from "./sdk";
import { ProviderTransform } from "./transform";
import type { Provider } from ".";

/** Schemas only: execution and authorization remain with the receiving executor. */
function streamTools(specs: Tool.Spec[], names: string[], model: Provider.Model): ToolSet {
  const cacheOptions = ProviderTransform.anthropicCacheOptions(model);
  return Object.fromEntries(
    specs.map((spec, index) => [
      names[index],
      {
        type: "function" as const,
        description: spec.description,
        inputSchema: jsonSchema(spec.inputSchema),
        ...(index === specs.length - 1 && cacheOptions ? { providerOptions: cacheOptions } : {}),
      },
    ]),
  );
}

const ProviderOptions = z.record(z.string(), PlainObjectSchema);

function stopConditions(input: RunInput): StopCondition<ToolSet>[] {
  const conditions: StopCondition<ToolSet>[] = [isStepCount(1)];
  const threshold = input.yieldAtInputTokens;
  if (threshold !== undefined)
    conditions.push(({ steps }) => (steps[steps.length - 1]?.usage?.inputTokens ?? 0) >= threshold);
  const shouldYield = input.shouldYield;
  if (shouldYield !== undefined) conditions.push(() => shouldYield());
  return conditions;
}

export function streamArguments(
  input: RunInput,
  system: string,
  abortSignal: AbortSignal,
  names: string[],
  model: ReturnType<typeof getLanguage>,
): Parameters<typeof streamText>[0] {
  const cacheOptions = ProviderTransform.anthropicCacheOptions(input.model);
  const instructions: SystemMessage[] = system
    ? [{ role: "system", content: system, ...(cacheOptions && { providerOptions: cacheOptions }) }]
    : [];
  return {
    model,
    ...(instructions.length > 0 && { instructions }),
    messages: toModelMessages(input.messages, input.model),
    tools: streamTools(input.tools, names, input.model),
    toolChoice: input.toolChoice,
    ...(input.maxTokens === undefined ? {} : { maxOutputTokens: input.maxTokens }),
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    maxRetries: 0,
    stopWhen: stopConditions(input),
    onError: (failure) => {
      input.events.publish(Operational.Events.Error, {
        traceId: input.trace.traceId,
        time: input.now(),
        sessionId: input.trace.sessionId,
        component: "llm.stream",
        msg: "streamText error",
        error: String(failure.error),
      });
    },
    abortSignal,
    // Provider namespaces cannot overwrite call-owned arguments.
    ...(input.providerOptions !== undefined && {
      providerOptions: ProviderOptions.parse(input.providerOptions),
    }),
  };
}

/**
 * The SDK-to-wire boundary: v7 block boundaries pass through unchanged, only
 * step marker names differ, and every event is decoded into the consumed wire
 * shape here because this is where SDK values become processor input.
 */
export async function* adaptStream(
  stream: AsyncIterable<TextStreamPart<ToolSet>>,
): AsyncGenerator<StreamEvent, void, undefined> {
  for await (const event of stream) {
    if (event.type === "finish-step") yield ProviderEvent.parse({ ...event, type: "step-finish" });
    else if (event.type === "start-step")
      yield ProviderEvent.parse({ ...event, type: "step-start" });
    else yield ProviderEvent.parse(event);
  }
}
