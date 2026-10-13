import { conform, systemText } from "../core/completion-format";
import { Machine, type ToolExecutionContext } from "@openomni/protocol";
import { z } from "zod";
import { Core } from "@openomni/agent";
const defineTool = Core.defineTool;
const ToolRefused = Core.ToolRefused;

/** What one sub-model call asks for: the prompt, and optionally a system text and model id. */
export interface LlmCall {
  readonly prompt: string;
  readonly system?: string;
  /** A model id on the port's configured provider; the port owns that provider's credential. */
  readonly model?: string;
}

/**
 * A one-shot sub-model call, without knowing how the host is composed: a
 * prompt in, the model's text out. Stateless by contract — each call is a
 * fresh completion, so the port carries no history.
 */
export type LlmPort = (call: LlmCall) => Promise<string>;

/** The per-cell call budget: how many sub-model calls one cell may make. */
const MAX_COMPLETION_CALLS = 32;

/** The cell's `completion(prompt, {model?, system?, schema?})`, one prompt per call. */
const Input = Machine.CompletionRequest;

const COMPLETION_TOOL_NAME = "completion";

/**
 * Budgets keyed by the cell that spends them. The cell door dispatches with
 * `turnId` = cell id, and one catalog serves every cell of a generation, so
 * a single counter in the tool closure would pool unrelated cells' budgets.
 */
function executeCompletion(llm: LlmPort | undefined) {
  const spent = new Map<string, number>();
  return async (input: z.output<typeof Input>, ctx: ToolExecutionContext): Promise<string> => {
    if (llm === undefined)
      throw new ToolRefused(COMPLETION_TOOL_NAME, "sub-model port is not composed");
    const calls = spent.get(ctx.turnId) ?? 0;
    if (calls >= MAX_COMPLETION_CALLS) {
      throw new ToolRefused(
        COMPLETION_TOOL_NAME,
        `the per-cell budget of ${MAX_COMPLETION_CALLS} sub-model calls is spent`,
      );
    }
    spent.set(ctx.turnId, calls + 1);
    const system = systemText(input);
    const answer = await llm({
      prompt: input.prompt,
      ...(system === "" ? {} : { system }),
      ...(input.model === undefined ? {} : { model: input.model }),
    });
    return input.schema === undefined ? answer : conform(answer, input.schema);
  };
}

/** Cell-only: batching is the cell's `parallel()`, so the input is one prompt. */
export function createCompletionTool(llm: LlmPort | undefined) {
  return defineTool({
    name: COMPLETION_TOOL_NAME,
    category: "execution",
    description:
      "Ask a sub-model one one-shot, stateless question and return its text. Options: model (an id on the configured provider), system, schema (a JSON Schema the answer must satisfy; the validated JSON text is returned).",
    input: Input,
    output: z.string(),
    visibility: { model: [], cell: ["resident", "child"] },
    execute: executeCompletion(llm),
    render: (_args, value) => value,
  });
}
