import { Clock, Effect, Cause, Exit, Option } from "effect";
import { AgentInvariantViolation, type ExecutionError, ToolBodyFailed, pretty, thrownAsError } from "./failure";
import type { ChatAgentConfig } from "./types";
import type { RunState, TurnArtifacts } from "./turn";
import { recordToolCall } from "./budget";
import { type Tool, type Message, type PlainValue, PlainValueSchema, type ToolDefinition, type ToolExecutionContext, listenForAbort, type AnyToolDefinition, type LedgerAction, SessionGeneration, type ToolCategory, toolResultText } from "@openomni/protocol";
import { BOUNDED_CONCURRENCY } from "./ports";
import { z } from "zod";
import { RawToolSlots, openInvocation, withExecutor, withInvocation, type InvocationFrame, type Executor, type ExecutionRequest } from "./gate/decide";
import type { ToolOutputPorts } from "./tool-output";

export function buildSystemPrompt(
  basePrompt: string | undefined,
  tools: Tool.Spec[],
): string | undefined {
  const toolPrompts = tools
    .filter((t) => t.prompt)
    .map((t) => `## Tool: ${t.name}\n${t.prompt}`)
    .join("\n\n");

  if (!toolPrompts) return basePrompt;
  if (!basePrompt) return toolPrompts;
  return `${basePrompt}\n\n---\n\n${toolPrompts}`;
}

export function assertToolExecutor(config: ChatAgentConfig): void {
  if ((config.tools?.length ?? 0) > 0 && !config.toolExecutor && !config.toolWave) {
    throw new AgentInvariantViolation("toolExecutor is required when tools are provided");
  }
}

/** Config-time: an ambiguous catalog refuses the run before it opens instead of surfacing mid-turn as a retryable "tool" error. */
export function assertUnambiguousToolMetadata(config: ChatAgentConfig): void {
  const tools = config.tools;
  // Two tools resolving to the same key (`a_b` alongside `a.b`) used to be a
  // silent last-writer-wins on policy lookups; refuse loudly, naming both.
  // Owners are keyed by tool IDENTITY, not name, so same-name tools collide too.
  const owners = new Map<string, { readonly name: string; readonly tool: object }>();
  const claim = (key: string, tool: { name: string }): void => {
    const owner = owners.get(key);
    if (owner !== undefined && owner.tool !== tool) {
      throw new AgentInvariantViolation(
        `tool metadata collision: "${key}" is claimed by both "${owner.name}" and "${tool.name}"`,
      );
    }
    owners.set(key, { name: tool.name, tool });
  };
  for (const tool of tools ?? []) {
    const labels = tool.labels ?? tool.descriptor?.labels;
    if (labels === undefined && tool.descriptor === undefined) continue;
    claim(tool.name, tool);
    const canonical = labels?.find((label) => label.startsWith("tool:"))?.slice(5);
    if (canonical) claim(canonical, tool);
    const dotted = tool.name.replace(/_/g, ".");
    if (dotted !== tool.name) claim(dotted, tool);
  }
}

interface PreparedTurnTools {
  readonly allTools: Tool.Spec[];
  readonly executor: NonNullable<ChatAgentConfig["toolExecutor"]> | undefined;
}

export function prepareTurnTools(state: RunState, config: Pick<ChatAgentConfig, "tools" | "toolExecutor">): PreparedTurnTools {
  const allTools = config.tools ?? [];
  const configuredExecutor = config.toolExecutor;
  const executor = configuredExecutor
    ? (call: Tool.Call, context?: Tool.ExecutionContext) =>
        Clock.currentTimeMillis.pipe(Effect.flatMap((startedAt) =>
          configuredExecutor(call, context).pipe(Effect.ensuring(
            Clock.currentTimeMillis.pipe(Effect.flatMap((endedAt) => Effect.sync(() => {
              state.budgetState = recordToolCall(state.budgetState, endedAt - startedAt);
            }))),
          )),
        ))
    : undefined;
  return { allTools, executor };
}

export interface WaveControl {
  readonly signal: AbortSignal;
  readonly retain?: (effect: Promise<void>) => void;
}

/** Results land on the original assistant slots, never completion order. */
export function settleModelTools(
  turn: TurnArtifacts,
  config: Omit<ChatAgentConfig, "budget" | "defaultBudget">,
  state: RunState,
): Effect.Effect<number, ExecutionError> {
  return Effect.gen(function* () {
  const assistant = turn.turnAssistant.message;
  const pending =
    assistant?.parts.filter(
      (part: Message.Part): part is Message.ToolPart =>
        part.type === "tool" &&
        (part.state.status === "pending" || part.state.status === "running"),
    ) ?? [];
  if (assistant === undefined || pending.length === 0) return 0;
  const calls = pending.map((part) => ({
    id: part.callID,
    tool: part.tool,
    input: part.state.input,
  }));
  const execute = turn.toolExecutor;
  const startedAt = yield* Clock.currentTimeMillis;
  if (config.toolWave === undefined && execute === undefined)
    return yield* Effect.die(new Error("tool wave executor is required"));
  const executed =
    config.toolWave !== undefined
      ? yield* config.toolWave(calls, config.signal)
      : yield* Effect.forEach(calls, (call) => {
          if (execute === undefined) return Effect.die(new Error("tool executor missing"));
          return Effect.exit(Effect.suspend(() => execute(call, { signal: config.signal }))).pipe(
            Effect.flatMap((exit) => {
              if (Exit.isSuccess(exit)) return Effect.succeed(exit.value);
              if (Cause.hasInterrupts(exit.cause)) return Effect.failCause(exit.cause);
              const content = Option.match(Cause.findErrorOption(exit.cause), {
                onNone: () => pretty(exit.cause),
                onSome: (error) => error.message,
              });
              return Effect.succeed({ id: call.id, toolCallId: call.id, toolName: call.tool, content, isError: true });
            }),
          );
        }, { concurrency: BOUNDED_CONCURRENCY });
  const byId = new Map(executed.map((result) => [result.toolCallId, result]));
  const settledAt = yield* Clock.currentTimeMillis;
  // The out-of-process wave bills its real wall time once; the in-process
  // executor path already billed per call inside prepareTurnTools.
  if (config.toolWave !== undefined) {
    const elapsedMs = settledAt - startedAt;
    for (let index = 0; index < calls.length; index += 1) {
      state.budgetState = recordToolCall(state.budgetState, index === 0 ? elapsedMs : 0);
    }
  }
  const parts = assistant.parts.map((part): Message.Part => {
    if (part.type !== "tool" || !pending.includes(part)) return part;
    const result = byId.get(part.callID);
    if (result === undefined) throw new AgentInvariantViolation(`missing tool result: ${part.callID}`);
    return {
      ...part,
      state: result.isError
        ? {
            status: "error",
            input: part.state.input,
            error: toolResultText(result),
            time: { start: startedAt, end: settledAt },
          }
        : {
            status: "completed",
            input: part.state.input,
            output: toolResultText(result),
            title: part.tool,
            metadata: {},
            time: { start: startedAt, end: settledAt },
          },
    };
  });
  turn.turnAssistant.message = { ...assistant, parts };
  for (const result of executed) turn.trackingSink.onToolResult(result);
  turn.trackingSink.onMessage(turn.turnAssistant.message);
  // Exhaustion is judged (and its telemetry published) once, in handleStop's
  // stop judgment — an early fail here would terminate the run without the
  // guaranteed "budget exceeded" operational record.
  return calls.length;
  });
}

export const ToolBodyOutcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("timed_out") }).strict(),
  z.object({
    status: z.literal("error"),
    message: z.string(),
    errorKind: z.enum(["invalid_input", "precondition_failed", "execution_failed", "invalid_output"]),
  }).strict(),
  z.object({ status: z.literal("success"), output: PlainValueSchema }).strict(),
]);
type ToolBodyOutcome = z.infer<typeof ToolBodyOutcome>;

/** Register ownership and handlers before entering foreign code. */
export function executeToolBody<In extends z.ZodType, Out extends z.ZodType>(
  definition: ToolDefinition<In, Out>,
  input: z.output<In>,
  context: ToolExecutionContext,
  timeoutMs: number | undefined,
  executor?: Executor,
  invocation?: InvocationFrame,
): Effect.Effect<ToolBodyOutcome, ToolBodyFailed, RawToolSlots> {
  return Effect.gen(function* () {
    const slots = yield* RawToolSlots;
    const execution = Effect.callback<ToolBodyOutcome, ToolBodyFailed>((resume) => {
      const release = slots.open();
      const controller = new AbortController();
      const scopedContext = {
        ...context,
        signal: AbortSignal.any([context.signal, controller.signal]),
      };
      const owned = invocation === undefined ? undefined : openInvocation(invocation, definition.name);
      const detach = listenForAbort(scopedContext.signal, () => owned?.close("interrupted"));
      const settle = (reason: "settled" | "failed") => {
        owned?.close(reason);
        detach();
        release();
      };
      const activeExecutor = owned?.frame.executor ?? executor;
      const enter = () => activeExecutor === undefined ? definition.execute(input, scopedContext)
        : withExecutor(activeExecutor, () => definition.execute(input, scopedContext));
      const raw = Promise.resolve().then(() => owned === undefined ? enter() : withInvocation(owned.frame, enter));
      raw.then(
        (value) => {
          settle("settled");
          resume(Effect.sync(() => decodeOutput(definition, value)));
        },
        (cause: CaughtValue) => {
          settle("failed");
          // An explicit ToolRefused keeps its model-facing classification; every other
          // foreign rejection is a typed body failure recorded as evidence (an Error rides structured).
          resume(isToolRefusal(cause)
            ? Effect.succeed<ToolBodyOutcome>({ status: "error", message: cause.message, errorKind: "precondition_failed" })
            : Effect.fail(new ToolBodyFailed({ tool: definition.name, cause: cause instanceof Error ? cause : thrownAsError(cause).message })));
        },
      );
      return Effect.sync(() => controller.abort());
    });
    if (timeoutMs === undefined) return yield* execution;
    return yield* execution.pipe(Effect.timeoutOption(timeoutMs), Effect.map((outcome: Option.Option<ToolBodyOutcome>) =>
      Option.getOrElse(outcome, (): ToolBodyOutcome => ({ status: "timed_out" }))));
  });
}

function decodeOutput<In extends z.ZodType, Out extends z.ZodType>(
  definition: ToolDefinition<In, Out>,
  value: z.output<Out>,
): ToolBodyOutcome {
  const parsed = definition.output.safeParse(value);
  const json = parsed.success ? PlainValueSchema.safeParse(parsed.data) : parsed;
  if (!json.success) {
    return {
      status: "error",
      message: `${definition.name} produced invalid output`,
      errorKind: "invalid_output",
    };
  }
  return { status: "success", output: json.data };
}

type CaughtValue = PlainValue | Error | bigint | symbol | undefined | ((...args: never[]) => void);

function isToolRefusal(value: CaughtValue): value is Error {
  return value instanceof Error && value.name === "ToolRefused";
}

export type ToolDispatchDefinition<In extends z.ZodType = z.ZodType, Out extends z.ZodType = z.ZodType> = ToolDefinition<In, Out> & {
  readonly approval?: (
    input: PlainValue,
    context?: ToolExecutionContext,
    prepare?: boolean,
  ) => NonNullable<ExecutionRequest["approval"]>;
};

export class ToolRefused extends Error {
  readonly errorKind = "precondition_failed";

  constructor(toolName: string, reason: string) {
    super(`${toolName} refused: ${reason}`);
    this.name = "ToolRefused";
  }
}

function toolIsSafe(category: ToolCategory): boolean {
  return category === "query";
}

export type ToolErrorKind =
  | "unregistered_tool"
  | "invalid_input"
  | "precondition_failed"
  | "execution_failed"
  | "invalid_output";

export type ToolDispatchResult = Tool.Result & { readonly content: string; readonly errorKind?: ToolErrorKind };
export type CellToolDispatchResult = Omit<ToolDispatchResult, "output" | "content"> & {
  /** Cell-door successes skip render: typed data without model text. */
  readonly content?: string;
};

export interface DispatcherOptions {
  readonly executor: Executor;
  readonly timeoutMs?: number;
  readonly retainEffect?: (effect: Promise<void>) => void;
  /** A dispatcher composed without it performs no projection; the per-turn dispatcher always carries the ledger-backed ports. */
  readonly toolOutput?: ToolOutputPorts;
}

export interface DispatchContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
}

export interface Dispatcher {
  readonly executor?: Executor;
  readonly specs: readonly Tool.Spec[];
  execute(call: Tool.Call, context: DispatchContext): Effect.Effect<ToolDispatchResult, ExecutionError>;
  executeWave(
    calls: readonly Tool.Call[],
    context: DispatchContext,
  ): Effect.Effect<readonly ToolDispatchResult[], ExecutionError>;
  executeCell(call: Tool.Call, context: DispatchContext): Effect.Effect<CellToolDispatchResult, ExecutionError>;
  recover(actions: readonly LedgerAction.Node[], context: DispatchContext): Effect.Effect<void, ExecutionError>;
}

export function defineTool<In extends z.ZodType, Out extends z.ZodType>(
  definition: ToolDefinition<In, Out>,
  approval?: (
    input: z.output<In>,
    context?: ToolExecutionContext,
    prepare?: boolean,
  ) => NonNullable<ExecutionRequest["approval"]>,
): ToolDispatchDefinition<In, Out> {
  if (definition.name.trim() === "") throw new AgentInvariantViolation("tool name must not be empty");
  if (definition.description.trim() === "") throw new AgentInvariantViolation("tool description must not be empty");
  if (toolInputSchema(definition).type !== "object") {
    throw new AgentInvariantViolation(`${definition.name} input schema root must be an object`);
  }
  return {
    ...definition,
    ...(approval === undefined ? {} : {
      approval: (input: PlainValue, context?: ToolExecutionContext, prepare?: boolean) =>
        approval(definition.input.parse(input), context, prepare),
    }),
  };
}

export function eraseTool<In extends z.ZodType, Out extends z.ZodType>(
  definition: ToolDefinition<In, Out>,
): AnyToolDefinition {
  return definition;
}

type JsonSchemaObject = Record<string, PlainValue>;

export function toolInputSchema(definition: AnyToolDefinition): JsonSchemaObject {
  const { $schema: _dialect, ...projected } = z
    .record(z.string(), PlainValueSchema)
    .parse(z.toJSONSchema(definition.input, { io: "input", target: "draft-7" }));
  if (projected.type !== "object") {
    throw new AgentInvariantViolation(`${definition.name} input schema root must be an object`);
  }
  return projected;
}

export type ProjectableTool = ToolDispatchDefinition & { readonly idempotent?: boolean };

/** Derived ONCE from one definition list; no caller re-projects. `idempotent` is preserved — the run loop alone decides replay. */
export interface ToolProjections {
  readonly session: readonly SessionGeneration.Tool[];
  readonly specs: readonly Tool.Spec[];
  readonly dispatch: ReadonlyMap<
    string,
    { readonly definition: ProjectableTool; readonly approval?: ToolDispatchDefinition["approval"] }
  >;
}

export function projectTools(definitions: readonly ProjectableTool[]): ToolProjections {
  const session = definitions.map((definition) =>
    SessionGeneration.Tool.parse({
      name: definition.name,
      inputSchema: toolInputSchema(definition),
      category: definition.category,
      ...(definition.sequential ? { sequential: true } : {}),
      ...(definition.idempotent === true ? { idempotent: true } : {}),
    }),
  );
  const specs = definitions
    .filter((definition) => definition.visibility.model.length > 0)
    .map((definition): Tool.Spec => ({
      name: definition.name,
      description: definition.description,
      inputSchema: toolInputSchema(definition),
      safe: toolIsSafe(definition.category),
      ...(definition.sequential ? { sequential: true } : {}),
    }));
  const dispatch = new Map(
    definitions.map((definition) => [
      definition.name,
      Object.freeze({ definition, approval: definition.approval }),
    ]),
  );
  return { session: Object.freeze(session), specs: Object.freeze(specs), dispatch };
}

export { currentExecutor } from "./gate/decide";
