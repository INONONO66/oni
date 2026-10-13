import type { Machine } from "@openomni/protocol";
import { Core } from "@openomni/agent";
const ToolRefused = Core.ToolRefused;
import { z } from "zod";

function schemaInstruction(schema: NonNullable<Machine.CompletionRequest["schema"]>): string {
  return `Answer with one JSON value that satisfies this JSON Schema, and nothing else:\n${JSON.stringify(schema)}`;
}

/** Strip a Markdown code fence a model may wrap its JSON in; the content is what gets validated. */
function unfence(text: string): string {
  const fenced = /^\s*```[a-zA-Z]*\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return fenced?.[1] ?? text;
}

/** The answer as canonical JSON text once it satisfies the schema; otherwise a refusal the cell can catch. */
export function conform(
  answer: string,
  schema: NonNullable<Machine.CompletionRequest["schema"]>,
): string {
  const validator = z.fromJSONSchema(schema);
  let checked: ReturnType<typeof validator.safeParse>;
  try {
    checked = validator.safeParse(JSON.parse(unfence(answer)));
  } catch {
    throw new ToolRefused("completion", `sub-model answer is not JSON: ${answer}`);
  }
  if (!checked.success)
    throw new ToolRefused(
      "completion",
      `sub-model answer does not satisfy the schema: ${checked.error.message}`,
    );
  return JSON.stringify(checked.data);
}

/** The sub-model's system text: the cell's own system text, then the schema instruction when a schema is given. */
export function systemText(input: z.output<typeof Machine.CompletionRequest>): string {
  const parts: string[] = [];
  if (input.system !== undefined) parts.push(input.system);
  if (input.schema !== undefined) parts.push(schemaInstruction(input.schema));
  return parts.join("\n\n");
}
