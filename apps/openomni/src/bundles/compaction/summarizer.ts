import { Core } from "@openomni/agent";
type ObservationSink = Core.ObservationSink;
const AgentFailure = Core.AgentFailure;
type CompactionOptions = Core.CompactionOptions;
type Llm = Core.Llm;
type RunInput = Core.RunInput;
import { Effect, Result } from "effect";
import type { Message, PlainObject } from "@openomni/protocol";
import { runResolvedText } from "../../composition/completion";

export type SummarizerErrorKind = "empty" | "overflow";

export class SummarizerError extends AgentFailure {
  readonly kind: SummarizerErrorKind;

  constructor(kind: SummarizerErrorKind, message: string) {
    super({ operation: `compaction.${kind}`, cause: message });
    this.name = "SummarizerError";
    this.kind = kind;
  }
}

interface SummarizerConfig {
  /** Injected clock + id entropy (#1245): required, no ambient Date/crypto. */
  readonly now: () => number;
  readonly id: () => string;
  readonly model: {
    readonly provider: string;
    readonly id: string;
    readonly apiKey: string;
    readonly transport?: RunInput["transport"];
  };
}

const INSTRUCTION =
  "Merge the previous anchor and the new conversation span into one dense summary. " +
  "Preserve decisions, open work, identifiers, file paths, and explicit Owner instructions. " +
  "Never invent or infer facts; omit anything that is not supported by the input.";

function reasoningOptions(provider: string): PlainObject {
  return provider === "anthropic"
    ? { anthropic: { thinking: { type: "disabled" } } }
    : { openai: { reasoningEffort: "minimal" } };
}

function messageWithText(
  input: Message.WithParts[],
  text: string,
  sources: { readonly now: () => number; readonly id: () => string },
): Message.WithParts[] {
  const id = `compaction-${sources.id()}`;
  return [
    {
      info: {
        id,
        sessionID: "compaction",
        role: "user",
        time: { created: sources.now() },
        agent: "compaction",
        model: { providerID: "", modelID: "" },
      },
      parts: [
        { id: sources.id(), sessionID: "compaction", messageID: id, type: "text", text },
      ],
    },
    ...input,
  ];
}

function nonemptySummary(answer: string) {
  return answer.trim().length === 0
    ? Effect.fail(new SummarizerError("empty", "compaction summarizer returned empty text"))
    : Effect.succeed(answer);
}

export function createCompactionSummarizer(
  config: SummarizerConfig,
): Effect.Effect<NonNullable<CompactionOptions["onSummarize"]>, never, Llm | ObservationSink> {
  return Effect.gen(function* () {
  const services = yield* Effect.context<Llm | ObservationSink>();
  const summarize: NonNullable<CompactionOptions["onSummarize"]> = (messages, previousAnchor, budget, signal) => Effect.gen(function* () {
    const anchor = previousAnchor ?? "(none)";
    const prompt = `${INSTRUCTION}\n\nPrevious anchor:\n${anchor}`;
    let working = messages;
    for (let attempt = 0; ; attempt += 1) {
      const answer = yield* Effect.result(runResolvedText(
          {
            model: config.model,
            now: config.now,
            id: config.id,
            messages: messageWithText(working, prompt, config),
            sessionId: "compaction",
            signal,
            maxTokens: Math.min(
              32_768,
              Math.floor(budget.contextWindowTokens * 0.5),
              budget.maxOutputTokens,
            ),
            providerOptions: reasoningOptions(config.model.provider),
          },
        ).pipe(Effect.provide(services)));
      if (Result.isSuccess(answer)) return yield* nonemptySummary(answer.success);
      const error = answer.failure;
      if (error._tag !== "LlmRunFailure" || !error.contextOverflow) return yield* Effect.fail(error);
      if (attempt >= 2)
        return yield* new SummarizerError("overflow", "compaction summarizer context overflow");
      working = working.slice(1);
    }
  });
  return summarize;
  });
}
