import { LlmRunFailure } from "../model";
import { z } from "zod";

export const RetryReason = z.enum([
  "timeout",
  "tool_error",
  "transient_error",
  "validation_error",
  "context_overflow",
]);
export type RetryReason = z.infer<typeof RetryReason>;

/** `aborted` is not a `RetryReason`: an abort is an instruction to stop, never a fault to classify, so it never appears on `agent.error.retry`. */
/** An honest absence, never defaulted to a transient claim. */
export type TerminalReason = RetryReason | "aborted" | "unclassified";

/** The name is the identity `isAbort` checks — never the message, which tool and provider errors may collide with. */
export function abortError(message = "aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** Decided by the signal state or the typed identity — never by message substrings; an abort must not emit retry-promising telemetry. */
export function isAbort(error: Error, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    error.name === "AbortError" ||
    asLlmFailure(error)?.aborted === true
  );
}

function asLlmFailure(error: Error): LlmRunFailure | undefined {
  return error instanceof LlmRunFailure ? error : undefined;
}

/** A host that must TELL someone why the turn produced nothing needs these facts; re-deriving them from the message is the string matching the closed vocabulary exists to avoid. */
const AgentFailureFacts = z.object({
  reason: z.enum([...RetryReason.options, "aborted"]),
  attempt: z.number(),
  maxAttempts: z.number(),
  llm: z.literal(true),
});
type AgentFailureFacts = z.infer<typeof AgentFailureFacts>;

/** Carried on the error itself (wrapping would change the identity every catcher reads); the symbol keeps the facts off enumeration. */
const FAILURE_FACTS = Symbol.for("openomni.agent.failureFacts");

export function attachFailureFacts(error: Error, facts: AgentFailureFacts): void {
  Object.defineProperty(error, FAILURE_FACTS, {
    value: facts,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/** Undefined when the error did not come from a run or died before any decision; absent is a real answer — never invent an attempt count. */
export function failureFacts<T>(error: T): AgentFailureFacts | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const parsed = AgentFailureFacts.safeParse(Reflect.get(error, FAILURE_FACTS));
  return parsed.success ? parsed.data : undefined;
}
