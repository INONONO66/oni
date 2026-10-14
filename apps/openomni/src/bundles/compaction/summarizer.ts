import { Core } from "@openomni/agent";
type ObservationSink = Core.ObservationSink;
const AgentFailure = Core.AgentFailure;
type CompactionOptions = Core.CompactionOptions;
type Llm = Core.Llm;
type RunInput = Core.RunInput;
import { Duration, Effect, Result } from "effect";
import type { Message, PlainObject } from "@openomni/protocol";
import { runResolvedText } from "../../composition/completion";

export type SummarizerErrorKind = "empty" | "overflow" | "timeout";

export class SummarizerError extends AgentFailure {
  readonly kind: SummarizerErrorKind;

  constructor(kind: SummarizerErrorKind, message: string) {
    super({ operation: `compaction.${kind}`, cause: message });
    this.name = "SummarizerError";
    this.kind = kind;
  }
}

interface SummarizerConfig {
  readonly sessionId: string;
  readonly system: string;
  readonly deadline?: Duration.Duration;
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

export const MAX_SUMMARY_OUTPUT_TOKENS = 32_768;

export function summaryDeadline(maxOutputTokens: number, override?: Duration.Duration): Duration.Duration {
  // Allow 30s setup plus the output at a conservative 20 tokens/s: a timeout
  // cuts the window deterministically and disables session speculation via summarizerFailed.
  return override ?? Duration.millis(30_000 + Math.ceil(maxOutputTokens / 20) * 1000);
}

function reasoningOptions(provider: string): PlainObject {
  return provider === "anthropic"
    ? { anthropic: { thinking: { type: "disabled" } } }
    : { openai: { reasoningEffort: "minimal" } };
}

function messageWithText(
  input: Message.WithParts[],
  text: string,
  sources: Pick<SummarizerConfig, "now" | "id" | "sessionId">,
): Message.WithParts[] {
  const id = `compaction-${sources.id()}`;
  return [
    ...input,
    {
      info: {
        id,
        sessionID: sources.sessionId,
        role: "user",
        time: { created: sources.now() },
        agent: "compaction",
        model: { providerID: "", modelID: "" },
      },
      parts: [
        { id: sources.id(), sessionID: sources.sessionId, messageID: id, type: "text", text },
      ],
    },
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
    const maxTokens = Math.min(
      MAX_SUMMARY_OUTPUT_TOKENS,
      Math.floor(budget.contextWindowTokens * 0.5),
      budget.maxOutputTokens,
    );
    const deadline = summaryDeadline(maxTokens, config.deadline);
    let working = messages;
    for (let attempt = 0; ; attempt += 1) {
      const answer = yield* Effect.result(runResolvedText(
          {
            model: config.model,
            now: config.now,
            id: config.id,
            messages: messageWithText(working, prompt, config),
            sessionId: config.sessionId,
            system: config.system,
            purpose: "compaction",
            signal,
            maxTokens,
            providerOptions: reasoningOptions(config.model.provider),
          },
        ).pipe(
          Effect.provide(services),
          Effect.timeoutOrElse({
            duration: deadline,
            orElse: () => Effect.fail(new SummarizerError("timeout", `summarizer_deadline:${Duration.toMillis(deadline)}`)),
          }),
        ));
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
