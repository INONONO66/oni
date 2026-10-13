import { z } from "zod";
import { defineTool } from "../../src/core/loop/tool";
import type { ExecutionRequest } from "../../src/core/loop/executor";
import type { ToolExecutionContext } from "@openomni/protocol";

export function timedQueryTool(description: string, execute: (input: Record<string, never>, context: ToolExecutionContext) => Promise<string>) {
  return defineTool({
    name: "timed",
    description,
    category: "query",
    visibility: { model: ["resident"], cell: ["resident"] },
    input: z.object({}),
    output: z.string(),
    render: (_input, output) => output,
    execute,
  });
}

/** A resident-visible query tool with no input that returns a string. */
export function stringQueryTool(name: string, description: string, execute: () => Promise<string>) {
  return defineTool({
    name,
    description,
    category: "query",
    input: z.object({}).strict(),
    output: z.string(),
    visibility: { model: ["resident"], cell: ["resident"] },
    execute,
    render: (_input, output) => output,
  });
}

/** A resident-visible tool taking `{ value: string }` and answering with a string. */
export function valueTool(options: {
  readonly name: string;
  readonly description?: string;
  readonly category?: "query" | "execution" | "mutation";
  readonly execute: (value: string) => Promise<string>;
  readonly render?: (value: string) => string;
  /** Marks the tool as needing approval before its body runs. */
  readonly approval?: (input: { value: string }) => NonNullable<ExecutionRequest["approval"]>;
}) {
  return defineTool(
    {
      name: options.name,
      description: options.description ?? options.name,
      category: options.category ?? "query",
      input: z.object({ value: z.string() }).strict(),
      output: z.string(),
      visibility: { model: ["resident"], cell: ["resident"] },
      execute: ({ value }) => options.execute(value),
      render: (_input, value) => options.render?.(value) ?? value,
    },
    options.approval,
  );
}
