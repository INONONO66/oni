/**
 * The tool dispatcher (#1316): moved verbatim from `core/tool.ts` so the
 * `plugins/tool` band owns dispatcher construction. The core keeps the
 * `Dispatcher` contract, tool definition, body execution and the three tool
 * projections; this file owns how calls are prepared, admitted through the
 * executor and finished into model/cell results, plus the per-turn
 * executor+dispatcher composition (`createTurnDispatcher`).
 */
import { Effect } from "effect";
import { z } from "zod";
import {
  canonicalDigest, PlainValueSchema, toolResultJsonSchema,
  type SessionGeneration,
  type AnyToolDefinition, type LedgerAction, type LedgerSession, type PlainValue,
  type Tool, type ToolExecutionContext,
} from "@openomni/protocol";
import {
  activeInvocation, AgentFailure, AgentInvariantViolation, createExecutor,
  executeToolBody, GenerationOwnership, immutableInput, projectTools,
  requireExecutor, SessionLayer, ToolBodyOutcome, ToolCatalog, ToolRefused,
  type CellToolDispatchResult, type DispatchContext, type Dispatcher,
  type DispatcherOptions, type DurableExecutor, type ExecutionApprovals,
  type ExecutionBatchResult, type ExecutionError, type ExecutionLedger,
  type ExecutionRequest, type Executor, type ExecutorOptions,
  type InvocationFrame, type ProcessServices, type RawToolSlots,
  type ToolDispatchDefinition, type ToolDispatchResult, type ToolErrorKind,
  DEFAULT_TOOL_OUTPUT_BUDGET_BYTES, projectToolOutput, type ToolOutputPorts, renderBodyCause,
} from "../../core/api";

const NEVER_ABORTED = new AbortController().signal;

/** D5 bound: typed data rides structuredContent only when it fits the protocol JSON bound. */
const BoundedResultJson = toolResultJsonSchema();

function invalidInputReason(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue?.path.map(String).join(".") ?? "";
  return issue === undefined
    ? "invalid input"
    : path === ""
      ? issue.message
      : `${path}: ${issue.message}`;
}

/** Non-executed terminals map to a failed result; a cell-door refusal throws. */
function finishResult(
  call: Tool.Call,
  definition: AnyToolDefinition,
  inputData: PlainValue,
  door: "model" | "cell",
  execution: ExecutionBatchResult,
  toolOutput: ToolOutputPorts | undefined,
): ToolDispatchResult | CellToolDispatchResult {
  if (execution.terminal === "interrupted" || execution.terminal === "outcome_unknown")
    return failed(call, execution.reason, "execution_failed");
  if (execution.terminal === "executed" && execution.failure !== undefined)
    return failed(
      call,
      execution.failure._tag === "ToolBodyFailed" ? renderBodyCause(execution.failure.cause) : execution.failure.message,
      "execution_failed",
    );
  if (execution.terminal !== "executed") {
    const refusal = new ToolRefused(definition.name, execution.reason);
    if (door === "cell") throw refusal;
    return failed(call, refusal.message, "precondition_failed");
  }
  const parsedOutcome = ToolBodyOutcome.safeParse(execution.value);
  if (!parsedOutcome.success) {
    return failed(call, `${definition.name} produced invalid output`, "invalid_output");
  }
  const outcome = parsedOutcome.data;
  if (outcome.status === "timed_out") {
    return failed(call, `${definition.name} timed out`, "execution_failed");
  }
  if (outcome.status === "error") {
    return failed(call, outcome.message, outcome.errorKind);
  }

  const transformedOutput = definition.output.safeParse(outcome.output);
  if (!transformedOutput.success) {
    return failed(call, `${definition.name} produced invalid output`, "invalid_output");
  }
  const output = PlainValueSchema.safeParse(transformedOutput.data);
  if (!output.success) {
    return failed(call, `${definition.name} produced invalid output`, "invalid_output");
  }
  if (door === "cell") {
    // The cell door stays render-free: typed data only.
    return {
      toolCallId: call.id,
      id: call.id,
      toolName: call.tool,
      structuredContent: output.data,
    } satisfies CellToolDispatchResult;
  }
  // Typed data rides structuredContent only when it fits the protocol bound;
  // content stays the authoritative model text either way.
  const structured = BoundedResultJson.safeParse(output.data);
  // #1305: over-budget renders are stored once and projected — the model
  // reads a bounded preview plus the identifier, never a destructive cut.
  const rendered = definition.render(inputData, output.data);
  const projected = toolOutput === undefined ? { content: rendered } : projectToolOutput(rendered, toolOutput);
  return {
    toolCallId: call.id,
    id: call.id,
    toolName: call.tool,
    content: projected.content,
    ...(structured.success ? { structuredContent: structured.data } : {}),
    ...(projected.outputRef === undefined ? {} : { details: { outputRef: { ...projected.outputRef } } }),
  } satisfies ToolDispatchResult;
}

function approvalFromOriginal(
  original: PlainValue | undefined,
  approval: ExecutionRequest["approval"],
): ExecutionRequest["approval"] {
  if (
    original === undefined ||
    original === null ||
    typeof original !== "object" ||
    Array.isArray(original)
  )
    return approval;
  return {
    required: original.approvalRequired === true,
    domainRevisions: z.record(z.string(), z.number().int()).parse(original.domainRevisions),
    timeoutMs: approval?.timeoutMs,
  };
}

export function createDispatcher(
  options?: DispatcherOptions,
): Effect.Effect<Dispatcher, ExecutionError, ToolCatalog> {
  return Effect.gen(function* () {
  const { definitions } = yield* ToolCatalog;
  return buildDispatcher(definitions, options);
  });
}

function buildDispatcher(definitions: readonly ToolDispatchDefinition[], options?: DispatcherOptions, invocation?: () => InvocationFrame): Dispatcher {
  /**
   * The cell door builds its dispatcher at tool-definition time, well ahead of every
   * execution context exists, so the ambient executor is resolved per dispatch:
   * an explicitly injected executor wins, otherwise the enclosing execution's
   * executor is inherited (nested cell tools), otherwise the dispatch fails
   * closed. Resolving once at construction would permanently capture
   * `undefined`; a definition-keyed cache would leak a stale executor from an
   * unrelated prior session into a context-less cell dispatch.
   */
  const resolveExecutor = (): Executor | undefined =>
    options?.executor ?? activeInvocation.getStore()?.executor;
  const { specs, dispatch: dispatchTable } = projectTools(definitions);
  type Prepared =
    | { readonly kind: "refused"; readonly result: ToolDispatchResult }
    | {
        readonly kind: "ready";
        readonly executor: Executor;
         readonly request: ExecutionRequest;
        readonly body: (receipt: LedgerAction.Receipt, admittedInput: PlainValue) => Effect.Effect<PlainValue, ExecutionError, RawToolSlots>;
        readonly sequential?: true;
        readonly finish: (
          result: ExecutionBatchResult,
        ) => ToolDispatchResult | CellToolDispatchResult;
      };
  function prepare(
    call: Tool.Call,
    providedContext: DispatchContext,
    door: "model" | "cell",
    originalAction?: LedgerAction.Node,
  ): Prepared {
    const context = executionContext(call, providedContext);
    const entry = dispatchTable.get(call.tool);
    if (entry === undefined) {
      return {
        kind: "refused",
        result: failed(call, `unregistered tool: ${call.tool}`, "unregistered_tool"),
      };
    }
    const { definition, approval: binding } = entry;
    const parsedInput = definition.input.safeParse(call.input);
    if (!parsedInput.success) {
      const reason = invalidInputReason(parsedInput.error);
      return {
        kind: "refused",
        result: failed(call, `${definition.name} refused: ${reason}`, "invalid_input"),
      };
    }

    const executor = requireExecutor(resolveExecutor());
    const parsedValue = PlainValueSchema.parse(parsedInput.data);
    const approval = approvalFromOriginal(originalAction?.intent.value, binding?.(parsedValue));
    const request: ExecutionRequest = {
      kind: "tool",
      op: definition.name,
      intent: parsedValue,
      effect: { category: definition.category },
      toolObservation: {
        turnId: context.turnId,
        callId: call.id,
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      },
      ...(originalAction === undefined ? {} : { originalAction }),
      ...(approval === undefined
        ? {}
        : {
            approval,
            domainRevisions: () => binding?.(parsedValue).domainRevisions ?? {},
          }),
    };
    let admittedValue = parsedValue;
    const body = (_receipt: LedgerAction.Receipt, admittedInput: PlainValue) => Effect.suspend(() => {
      const admitted = definition.input.safeParse(admittedInput);
      if (!admitted.success) return Effect.succeed({ status: "error" as const, errorKind: "invalid_input" as const, message: invalidInputReason(admitted.error) });
      admittedValue = immutableInput(PlainValueSchema.parse(admitted.data));
      return executeToolBody(
      definition,
      admittedValue,
      {
        ...context,
        ...(approval === undefined ? {} : { domainRevisions: approval.domainRevisions }),
      },
      options?.timeoutMs,
      executor,
      invocation?.(),
      ).pipe(Effect.map(PlainValueSchema.parse));
    });
    const finish = (
      execution: ExecutionBatchResult,
    ): ToolDispatchResult | CellToolDispatchResult =>
      finishResult(call, definition, admittedValue, door, execution, options?.toolOutput);
    let modelResult: ToolDispatchResult | undefined;
    return {
      kind: "ready",
      executor,
      request: {
        ...request,
        ...(door === "model"
          ? {
              toolResult: (execution: ExecutionBatchResult): Tool.Result => {
                modelResult = renderedResult(finish(execution));
                return modelResult;
              },
            }
          : {}),
      },
      body,
      finish: (execution) => modelResult ?? finish(execution),
      ...(definition.sequential ? { sequential: true } : {}),
    };
  }

  function dispatch(call: Tool.Call, context: DispatchContext, door: "model" | "cell") {
    return Effect.suspend(() => {
      const prepared = prepare(call, context, door);
      if (prepared.kind === "refused") return Effect.succeed(prepared.result);
      const runBatch = requireExecutor(prepared.executor.runBatch);
      return runBatch([prepared], { signal: context.signal ?? NEVER_ABORTED }).pipe(
        Effect.flatMap((results) => {
          const result = results[0];
          if (result === undefined) return Effect.die(new Error("single dispatch lost its result"));
          if (door === "cell" && result.terminal === "interrupted") return Effect.interrupt;
          return Effect.succeed(prepared.finish(result));
        }),
      );
    });
  }

  function runPreparedBatch(
    ready: readonly Extract<Prepared, { kind: "ready" }>[],
    context: DispatchContext,
    retain?: (effect: Promise<void>) => void,
  ) {
    const runBatch = requireExecutor(resolveExecutor()?.runBatch);
    return runBatch(ready, {
      signal: context.signal ?? NEVER_ABORTED,
      ...(retain === undefined ? {} : { retain }),
    });
  }

  function executeWave(
    calls: readonly Tool.Call[],
    context: DispatchContext,
  ): Effect.Effect<readonly ToolDispatchResult[], ExecutionError> {
    return Effect.gen(function* () {
      const prepared = calls.map((call) => prepare(call, context, "model"));
      const ready = prepared.filter(
        (item: Prepared): item is Extract<Prepared, { kind: "ready" }> => item.kind === "ready",
      );
      const results = yield* runPreparedBatch(ready, context, options?.retainEffect);
      let index = 0;
      return prepared.map((item) => {
        if (item.kind === "refused") return item.result;
        const result = results[index++];
        if (result === undefined) throw new AgentInvariantViolation("wave result missing");
        return renderedResult(item.finish(result));
      });
    });
  }

  return {
    ...(options?.executor === undefined ? {} : { executor: options.executor }),
    specs,
    executeWave,
    recover(actions, context) {
      return Effect.gen(function* () {
      const groups = recoverableWaves(actions, context.turnId);
      const approvalWaves = new Set<string>();
      for (const action of actions) {
        const intent = action.intent.value;
        if (
          intent !== null &&
          typeof intent === "object" &&
          !Array.isArray(intent) &&
          typeof intent.waveId === "string" &&
          intent.approvalRequired === true
        ) {
          approvalWaves.add(intent.waveId);
        }
      }
      for (const [waveId, group] of groups) {
        if (!approvalWaves.has(waveId)) continue;
        const prepared = group.map(({ action, call }) => prepare(call, context, "model", action));
        if (prepared.some((item) => item.kind === "refused"))
          return yield* Effect.die(new Error("captured invocation no longer parses"));
        const ready = prepared.filter(
          (item: Prepared): item is Extract<Prepared, { kind: "ready" }> => item.kind === "ready",
        );
        const results = yield* runPreparedBatch(ready, context);
        results.forEach((result, index) => {
          ready[index]?.finish(result);
        });
      }
      });
    },
    execute(call, context) {
      return dispatch(call, context, "model").pipe(Effect.map(renderedResult));
    },
    executeCell(call, context) {
      return dispatch(call, context, "cell");
    },
  };
}

/**
 * The per-turn identity and lease under which a dispatcher's tools commit.
 * Mirrors the fields both the resident and child runners already pin on their
 * {@link SessionRunnerInput}, so composing the executor+dispatcher has one owner
 * instead of being copied per role.
 */
interface TurnDispatchInput {
  readonly signal?: AbortSignal;
  readonly sessionId: string;
  readonly role: LedgerSession.Role;
  readonly actionId: string;
  readonly turnId?: string;
  readonly tools?: readonly SessionGeneration.Tool[];
  readonly toolsGeneration?: number;
  readonly toolsHash?: string;
  readonly systemHash?: string;
  readonly ledger: ExecutionLedger;
  readonly retainEffect?: (effect: Promise<void>) => void;
  readonly bindApprovals?: (approvals: ExecutionApprovals) => void;
}

function guardedOperations(ledger: ExecutionLedger, turnId: string): LedgerAction.Node[] {
  const actions: LedgerAction.Node[] = [];
  let cursor = 0;
  for (;;) {
    const page = ledger.guardedOperationsPage?.(turnId, cursor) ?? [];
    actions.push(...page);
    if (page.length < 256) return actions;
    cursor = page.at(-1)?.ordinal ?? cursor;
  }
}

function recoverableWaves(actions: readonly LedgerAction.Node[], turnId: string | undefined) {
  const groups = new Map<string, { action: LedgerAction.Node; call: Tool.Call }[]>();
  const settledIntents = new Set(
    actions
      .filter((action) => {
        const effect = action.effect.value;
        return (
          action.kind === "tool" &&
          effect !== null &&
          typeof effect === "object" &&
          !Array.isArray(effect) &&
          effect.phase === "result"
        );
      })
      .map((action) => action.parentId),
  );
  for (const action of actions) {
    if (action.kind !== "tool") continue;
    const intent = action.intent.value;
    if (
      intent === null ||
      typeof intent !== "object" ||
      Array.isArray(intent) ||
      intent.phase !== "intent" ||
      intent.turnId !== turnId ||
      typeof intent.callId !== "string" ||
      typeof intent.op !== "string" ||
      typeof intent.waveId !== "string"
    )
      continue;
    if (settledIntents.has(action.id)) continue;
    const parsed = PlainValueSchema.parse(intent.originalArgs ?? intent.value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new AgentInvariantViolation(`invalid durable invocation: ${action.id}`);
    const group = groups.get(intent.waveId) ?? [];
    group.push({ action, call: { id: intent.callId, tool: intent.op, input: parsed } });
    groups.set(intent.waveId, group);
  }
  return groups;
}

/** The runtime clock/entropy/observation sink shared across a session's turns. */
interface TurnDispatchRuntime {
  readonly closeGraceMs?: ExecutorOptions["closeGraceMs"];
  readonly retryAlarm?: ExecutorOptions["retryAlarm"];
  readonly approvalTimeoutMs?: ExecutorOptions["approvalTimeoutMs"];
  /** The composed approval policy (#1309); required, the executor keeps no fallback. */
  readonly approvalPolicy: ExecutorOptions["approvalPolicy"];
  readonly authorizeApproval?: ExecutorOptions["authorizeApproval"];
}

/**
 * Compose the per-turn executor and dispatcher for a prepared runner turn. Both
 * the resident and child runners build this identically; keeping it here makes
 * "how a turn's tools commit durably" a single owner.
 */
export function createTurnDispatcher(
  input: TurnDispatchInput,
  runtime: TurnDispatchRuntime,
): Effect.Effect<Dispatcher & { readonly executor: DurableExecutor }, ExecutionError, ProcessServices | SessionLayer | ToolCatalog | GenerationOwnership> {
  return Effect.gen(function* () {
  const { definitions } = yield* ToolCatalog;
  const generation = yield* GenerationOwnership;
  const { policy } = yield* SessionLayer;
  const projected = new Map(projectTools(definitions).session.map((tool) => [tool.name, tool]));
  for (const captured of input.tools ?? []) {
    const current = projected.get(captured.name);
    if (current === undefined || canonicalDigest(current) !== canonicalDigest(captured)) {
      return yield* new AgentFailure({ operation: "dispatcher.acquire", cause: `captured catalog mismatch: ${captured.name}` });
    }
  }
  const executor = yield* createExecutor({
    retryAlarm: runtime.retryAlarm,
    closeGraceMs: runtime.closeGraceMs,
    signal: input.signal,
    retainEffect: input.retainEffect,
    authorizeApproval: runtime.authorizeApproval,
    approvalTimeoutMs: runtime.approvalTimeoutMs,
    approvalPolicy: runtime.approvalPolicy,
    ledger: input.ledger,
    identity: {
      sessionId: input.sessionId,
      role: input.role,
      parentActionId: input.turnId ?? input.actionId,
      turnId: input.turnId,
      toolsGeneration: input.toolsGeneration,
      toolsHash: input.toolsHash,
      systemHash: input.systemHash,
    },
  });
  if (executor.approvals !== undefined) input.bindApprovals?.(executor.approvals);
  const pinnedNames =
    input.tools === undefined ? undefined : new Set(input.tools.map((tool) => tool.name));
  const pinnedDefinitions =
    pinnedNames === undefined
      ? definitions
      : definitions.filter((definition) => pinnedNames.has(definition.name));
  // #1305: the per-turn dispatcher projects over-budget renders through the
  // ledger-backed output store under the generation's resolved budget.
  const putToolOutput = input.ledger.putToolOutput;
  const toolOutput: ToolOutputPorts | undefined = putToolOutput === undefined ? undefined : {
    budgetBytes: input.ledger.toolOutputBudgetBytes?.() ?? DEFAULT_TOOL_OUTPUT_BUDGET_BYTES,
    put: putToolOutput,
  };
  const dispatcher = buildDispatcher(pinnedDefinitions, {
    executor,
    retainEffect: input.retainEffect,
    ...(toolOutput === undefined ? {} : { toolOutput }),
  }, () => frame);
  const frame: InvocationFrame = { executor, cell: dispatcher, policy, generation };
  return {
    ...dispatcher,
    executor: {
      ...executor,
      recover() {
        // Persisted evidence settles ordinary crash-open intents first; only
        // request-bearing waves then re-admit their captured invocations.
        return executor.recover().pipe(Effect.andThen(() =>
          dispatcher.recover(guardedOperations(input.ledger, input.turnId ?? input.actionId), {
            sessionId: input.sessionId,
            turnId: input.turnId ?? input.actionId,
            signal: input.signal,
          }),
        ));
      },
    },
  };
  });
}


function executionContext(call: Tool.Call, context: DispatchContext): ToolExecutionContext {
  return {
    sessionId: context.sessionId,
    turnId: context.turnId,
    callId: call.id,
    signal: context.signal ?? NEVER_ABORTED,
  };
}

function renderedResult(result: ToolDispatchResult | CellToolDispatchResult): ToolDispatchResult {
  const { content, ...settled } = result;
  if (content === undefined) throw new AgentInvariantViolation("model tool result must carry rendered content");
  return { ...settled, content };
}

function failed(call: Tool.Call, content: string, errorKind: ToolErrorKind): ToolDispatchResult {
  return {
    toolCallId: call.id,
    id: call.id,
    toolName: call.tool,
    content,
    isError: true,
    errorKind,
    details: { errorKind },
  };
}

