import { z } from "zod";
import type { LedgerSession } from "../ledger/l0.js";
import { Events as EventDescriptors } from "../event/tool.js";
import type { TraceContext } from "../trace/index.js";
import { PlainObjectSchema, PlainValueSchema } from "../json.js";
import { EpochMs } from "../time.js";
import { toolResultSchema } from "./result.js";
export { toolResultText, toolResultJsonSchema, toolOutputRefSchema, type ToolOutputRef } from "./result.js";

export type ToolCategory = "query" | "mutation" | "authority" | "execution";
/** Provider-safe name shared by catalog admission and model serialization. */
export function toolWireName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}
/** Derived from the one session-role vocabulary (#1315): no second copy. */
export type ToolRole = LedgerSession.Role;

export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly signal: AbortSignal;
  readonly domainRevisions?: Readonly<Record<string, number>>;
}

/** Protocol shape only; definition validation and dispatch live in agent. */
export interface ToolDefinition<
  In extends z.ZodType = z.ZodType,
  Out extends z.ZodType = z.ZodType,
> {
  readonly name: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly input: In;
  readonly output: Out;
  readonly visibility: {
    readonly model: readonly ToolRole[];
    readonly cell: readonly ToolRole[];
  };
  readonly sequential?: true;
  execute(args: z.output<In>, ctx: ToolExecutionContext): Promise<z.output<Out>>;
  render(args: z.output<In>, value: z.output<Out>): string;
}

export type AnyToolDefinition = ToolDefinition<z.ZodType, z.ZodType>;

export namespace Tool {
  const StatePending = z.object({
    status: z.literal("pending"),
    input: PlainObjectSchema,
  });

  const StateRunning = z.object({
    status: z.literal("running"),
    input: PlainObjectSchema,
    time: z.object({
      start: EpochMs,
    }),
  });

  const StateCompleted = z.object({
    status: z.literal("completed"),
    input: PlainObjectSchema,
    output: z.string(),
    title: z.string(),
    metadata: z.record(z.string(), PlainValueSchema),
    time: z.object({
      start: EpochMs,
      end: EpochMs,
    }),
  });

  const StateError = z.object({
    status: z.literal("error"),
    input: PlainObjectSchema,
    error: z.string(),
    time: z.object({
      start: EpochMs,
      end: EpochMs,
    }),
  });

  export const State = z.discriminatedUnion("status", [
    StatePending,
    StateRunning,
    StateCompleted,
    StateError,
  ]);
  export type State = z.infer<typeof State>;

  export const Call = z.object({
    id: z.string(),
    tool: z.string(),
    input: PlainObjectSchema,
  });
  export type Call = z.infer<typeof Call>;

  /**
   * Per-call runtime context for tool execution callbacks. Cancellation is
   * cooperative: executors pass an aborted signal before returning timeout or
   * run-cancel results, and tools that start long-running work should stop their
   * own side effects when it aborts. This type documents the correlation fields
   * tools may receive; invocation owners must construct an exact runtime object
   * because TypeScript's structural typing does not remove additional fields.
   */
  export interface ExecutionContext {
    readonly signal?: AbortSignal;
    readonly traceContext?: Pick<TraceContext.Type, "traceId" | "sessionId" | "runId">;
  }

  export const Result = toolResultSchema();
  export type Result = z.infer<typeof Result>;

  export const Spec = z.object({
    name: z.string(),
    description: z.string().optional(),
    inputSchema: PlainObjectSchema,
    safe: z.boolean().optional(),
    sequential: z.literal(true).optional(),
    labels: z.array(z.string()).optional(),
    prompt: z.string().optional(),
  });
  export type Spec = z.infer<typeof Spec>;

  /** #499 observation descriptors — published via Bus; event name strings frozen. */
  export const Events = EventDescriptors;
}
