import { turnTerminal } from "../core/store/session-reads";
import * as SessionReads from "../core/store/session-reads";
import { Effect } from "effect";
import { z } from "zod";

import type { SessionKernel } from "../core/session/entity";
import { AgentInvariantViolation } from "../core/ports/failure";
import { canonicalDigest, type CheckpointPolicy, FoldCheckpoint, NamedError, Message, PlainValueSchema, Tool, toolResultText, type LedgerAction, type PlainObject, type PlainValue, } from "@openomni/protocol";
import { actionPayloadBytes } from "../core/store/action-hash";

/**
 * Canonical model-context fold over committed actions: delivered prompts,
 * assistant snapshots, positional tool settlements and compaction projections.
 * Originals and each replaced projection remain append-only; bus ticks, policy
 * decisions and diagnostics never enter model context.
 */
export function foldSessionHistory(
  sessionId: string,
  actions: readonly LedgerAction.Node[],
  seed?: FoldCheckpoint.State,
): Message.WithParts[] {
  return deriveHistory(foldHistoryState(sessionId, actions, seed));
}

/** The continuation is captured before view-only cancellation of unsettled tools. */
export function foldHistoryState(
  sessionId: string,
  actions: readonly LedgerAction.Node[],
  seed?: FoldCheckpoint.State,
): FoldCheckpoint.State {
  const state: FoldCheckpoint.State =
    seed === undefined
      ? {
          messages: [],
          canonicalTurn: false,
          messageTurns: [],
          parents: [],
          compatibility: [],
          successorActionId: null,
          budgetState: null,
        }
      : { budgetState: null, ...structuredClone(seed) };
  const parents = new Map<string, string | null>(state.parents);
  const messageTurns = new Map<string, string | null>(state.messageTurns);
  for (const action of actions) {
    applyHistoryAction(sessionId, state, parents, messageTurns, action);
    const live = new Set(state.messages.map((message) => message.info.id));
    for (const [id, turnId] of messageTurns) {
      if (!live.has(id) && (turnId === null || !parents.has(turnId))) messageTurns.delete(id);
    }
  }
  state.messageTurns = [...messageTurns].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  state.parents = [...parents].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return state;
}

function applyHistoryAction(
  sessionId: string,
  state: FoldCheckpoint.State,
  parents: Map<string, string | null>,
  messageTurns: Map<string, string | null>,
  action: LedgerAction.Node,
) {
  if (action.kind === "fold.checkpoint") return;
  chargeBudget(state, action);
  const turnId = parents.get(action.parentId ?? "");
  if (object(action.intent.value).phase === "intent") parents.set(action.id, action.parentId);
  if (opensTurn(action)) state.canonicalTurn = false;
  const prompt = deliveredPrompt(action, sessionId);
  if (prompt !== undefined) {
    state.messages.push(prompt);
    const delivery = SessionReads.delivery(action);
    if (delivery !== undefined)
      state.compatibility.push({ id: delivery.deliveryId, role: "user", text: delivery.content });
  }
  const snapshot = assistantSnapshot(action);
  if (snapshot !== undefined) {
    messageTurns.set(snapshot.info.id, turnId ?? null);
    state.messages = upsertMessage(state.messages, snapshot);
    state.canonicalTurn = true;
  }
  const projection = compactionProjection(action);
  if (projection !== undefined) {
    state.messages = projection;
    state.successorActionId = action.id;
  }
  const result = toolSettlement(action);
  if (result !== undefined)
    state.messages = state.messages.map((message) =>
      messageTurns.get(message.info.id) !== turnId
        ? message
        : settleToolParts(message, result, action.ts),
    );
  const terminalTurn = applyTerminal(state, action);
  if (terminalTurn !== undefined) parents.delete(terminalTurn);
  if (object(action.effect.value).phase === "result" && action.parentId !== null)
    parents.delete(action.parentId);
}

/** Budget counters charged as the loop does: a turn per logical `llm` intent, tokens per attempt, a call plus wall slice per settled tool. */
function chargeBudget(state: FoldCheckpoint.State, action: LedgerAction.Node): void {
  const intent = object(action.intent.value);
  if (action.kind === "turn" && intent.phase === "intent") {
    state.budgetState = {
      startTime: action.ts, chargedAt: action.ts, turns: 0, toolCalls: 0, toolRuntimeMs: 0,
      totalInputTokens: 0, totalOutputTokens: 0, toolsThrough: action.ts, openTools: [],
    };
    return;
  }
  const budget = state.budgetState;
  if (budget === null || budget === undefined) return;
  budget.chargedAt = Math.max(budget.chargedAt, action.ts);
  if (action.kind === "llm") chargeModel(budget, action, intent);
  if (action.kind === "tool") chargeTool(budget, action, intent);
  if (turnTerminal(action) !== undefined) state.budgetState = null;
}

function chargeModel(budget: FoldCheckpoint.BudgetState, action: LedgerAction.Node, intent: PlainObject): void {
  if (intent.phase === "intent" && typeof intent.attempt !== "number") budget.turns += 1;
  if (intent.phase !== "result") return;
  const effect = object(action.effect.value);
  if (effect.usageProvenance !== "reported" && effect.usageProvenance !== "estimated") return;
  const usage = object(object(effect.evidence).usage);
  budget.totalInputTokens += count(usage.inputTokens);
  budget.totalOutputTokens += count(usage.outputTokens);
}

function chargeTool(budget: FoldCheckpoint.BudgetState, action: LedgerAction.Node, intent: PlainObject): void {
  if (intent.phase === "intent") {
    budget.openTools.push([action.id, action.ts]);
    return;
  }
  if (intent.phase !== "result") return;
  const index = budget.openTools.findIndex(([id]) => id === action.parentId);
  if (index === -1) return;
  const [[, startedAt]] = budget.openTools.splice(index, 1) as [[string, number]];
  budget.toolCalls += 1;
  budget.toolRuntimeMs += Math.max(0, action.ts - Math.max(startedAt, budget.toolsThrough));
  budget.toolsThrough = Math.max(budget.toolsThrough, action.ts);
}

function count(value: PlainValue | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function applyTerminal(state: FoldCheckpoint.State, action: LedgerAction.Node) {
  const terminal = turnTerminal(action);
  if (terminal === undefined) return;
  if (terminal.text.length > 0) {
    state.compatibility.push({ id: action.id, role: "assistant", text: terminal.text });
    if (!state.canonicalTurn)
      state.messages.push(
        terminalAssistant(
          terminal.text,
          state.messages.at(-1)?.info.id ?? "",
          action.sessionId,
          action,
        ),
      );
  }
  if (terminal.kind === "interrupted" || terminal.kind === "error")
    state.messages = state.messages.map((message) =>
      cancelOpenToolParts(message, terminal.kind, action.ts),
    );
  return terminal.turnId;
}

function deriveHistory(state: FoldCheckpoint.State): Message.WithParts[] {
  return state.messages.map((message) =>
    cancelOpenToolParts(message, "tool execution cancelled", message.info.time.created),
  );
}

export const FoldCheckpointIntegrityError = NamedError.create(
  "FoldCheckpointIntegrityError",
  z
    .object({
      code: z.literal("fold_checkpoint_integrity"),
      sessionId: z.string(),
      checkpointId: z.string(),
      reason: z.enum(["version", "revision", "seed", "stateHash"]),
      revision: z.number().int().nonnegative(),
      expected: z.string().nullable(),
      actual: z.string().nullable(),
    })
    .strict(),
);

function checkpointSeed(sessionId: string, checkpoint: LedgerAction.Node) {
  const intent = object(checkpoint.intent.value);
  const result = object(object(checkpoint.effect.value).result);
  const fail = (
    reason: InstanceType<typeof FoldCheckpointIntegrityError>["data"]["reason"],
    actual: string | null = null,
  ): never => {
    throw new FoldCheckpointIntegrityError({
      code: "fold_checkpoint_integrity",
      sessionId,
      checkpointId: checkpoint.id,
      revision: checkpoint.ordinal - 1,
      reason,
      expected: typeof result.stateHash === "string" ? result.stateHash : null,
      actual,
    });
  };
  if (intent.foldVersion !== 1 || result.foldVersion !== 1) fail("version");
  if (
    intent.revision !== checkpoint.ordinal - 1 ||
    result.revision !== intent.revision ||
    checkpoint.sessionId !== sessionId
  )
    fail("revision");
  const parsed = FoldCheckpoint.Effect.safeParse(checkpoint.effect.value);
  if (!parsed.success || !FoldCheckpoint.Intent.safeParse(intent).success) return fail("seed");
  const state = PlainValueSchema.parse(parsed.data.result.state);
  const actual = canonicalDigest({ foldVersion: 1, state });
  if (actual !== parsed.data.result.stateHash) fail("stateHash", actual);
  return parsed.data.result;
}

/** Core default: applies when no `session.configure{settings.checkpoint}` row pins one. */
export const DEFAULT_CHECKPOINT_POLICY: CheckpointPolicy = {
  everyActions: 256,
  maxTailBytes: 4 * 1024 * 1024,
};

/** The checkpoint policy folded from the latest configure settings, never a literal. */
export function checkpointPolicy(kernel: SessionKernel, sessionId: string): CheckpointPolicy {
  return kernel.latestSettings(sessionId)?.checkpoint ?? DEFAULT_CHECKPOINT_POLICY;
}

/** The suffix page size: the existing `historyPage` default, not a policy value. */
const RESTORE_PAGE_ROWS = 256;

/** What one restore read after its checkpoint. */
interface RestoreTelemetry {
  readonly rows: number;
  readonly bytes: number;
  readonly pages: number;
  readonly ms: number;
}

/** Injected clock for `RestoreTelemetry.ms`. */
export interface RestoreOptions {
  readonly now?: () => number;
}

/**
 * The activation restore tail exceeded `maxTailBytes`: no partial state, the work done rides along.
 * Reached when a checkpoint was refused at the row cap (the writer then lets the tail grow), by rows
 * appended outside `commitFoldBatch`, or by a lowered policy.
 */
export const RestoreRefused = NamedError.create(
  "RestoreRefused",
  z
    .object({
      code: z.literal("budget"),
      sessionId: z.string(),
      revision: z.number().int().nonnegative(),
      maxTailBytes: z.number().int().positive(),
      telemetry: z
        .object({
          rows: z.number().int().nonnegative(),
          bytes: z.number().int().nonnegative(),
          pages: z.number().int().nonnegative(),
          ms: z.number().nonnegative(),
        })
        .strict(),
    })
    .strict(),
);
export type RestoreRefused = InstanceType<typeof RestoreRefused>;

/** One committed prefix materialized as fold state, model history and compatibility rows. */
export interface HydratedSessionHistory {
  readonly revision: number;
  readonly state: FoldCheckpoint.State;
  readonly history: Message.WithParts[];
  readonly messages: FoldCheckpoint.State["compatibility"];
  readonly nonCheckpointActions: number;
  readonly telemetry: RestoreTelemetry;
}

/** Validate the durable seed even when a commit does not need to materialize its suffix. */
export function readHistoryCheckpoint(
  kernel: SessionKernel,
  sessionId: string,
  throughRevision?: number,
  options: RestoreOptions = {},
): {
  nonCheckpointActions: number;
  /** Payload bytes from the checkpoint row (inclusive) through the revision: the restore tail. */
  tailBytes: () => number;
  hydrate: () => HydratedSessionHistory;
  /** The bounded read: the page carrying the tail past `maxTailBytes` refuses with nothing folded. */
  restore: (maxTailBytes: number) => HydratedSessionHistory | RestoreRefused;
} {
  const { revision, checkpoint } = kernel.latestFoldCheckpoint(sessionId, throughRevision);
  const seed = checkpoint === undefined ? undefined : checkpointSeed(sessionId, checkpoint);
  const afterRevision = seed?.revision ?? 0;
  const initial = () => foldHistoryState(sessionId, [], seed?.state);
  return {
    nonCheckpointActions: revision - (checkpoint?.ordinal ?? 0),
    tailBytes: () => kernel.payloadBytes(sessionId, afterRevision, revision),
    hydrate: () => readHistorySuffix(kernel, sessionId, revision, initial(), afterRevision, 0, options),
    restore: (maxTailBytes) =>
      readHistorySuffix(kernel, sessionId, revision, initial(), afterRevision, 0, options, maxTailBytes),
  };
}

/** Read one fixed committed prefix; a missing checkpoint alone permits genesis replay. */
export function hydrateSessionHistory(
  kernel: SessionKernel,
  sessionId: string,
  throughRevision?: number,
  options: RestoreOptions = {},
): HydratedSessionHistory {
  return readHistoryCheckpoint(kernel, sessionId, throughRevision, options).hydrate();
}

/**
 * The activation restore: the one read bound by the folded `maxTailBytes`, refused once in the error
 * channel. Shared hydrate paths stay unbounded; the writer keeps the tail under that policy only while
 * its checkpoints fit the row cap.
 */
export function restoreSessionHistory(
  kernel: SessionKernel,
  sessionId: string,
  options: RestoreOptions = {},
): Effect.Effect<HydratedSessionHistory, RestoreRefused> {
  return Effect.suspend(() => {
    const { maxTailBytes } = checkpointPolicy(kernel, sessionId);
    const restored = readHistoryCheckpoint(kernel, sessionId, undefined, options).restore(maxTailBytes);
    return RestoreRefused.isInstance(restored) ? Effect.fail(restored) : Effect.succeed(restored);
  });
}

/** Recovery refresh consumes only commits newer than the runner's captured prefix. */
export function refreshSessionHistory(
  kernel: SessionKernel,
  sessionId: string,
  previous: HydratedSessionHistory,
): HydratedSessionHistory {
  return readHistorySuffix(
    kernel,
    sessionId,
    kernel.row(sessionId).revision,
    previous.state,
    previous.revision,
    previous.nonCheckpointActions,
  );
}

/**
 * Folds the suffix page by page; each page's bytes count BEFORE folding, and under a `maxTailBytes`
 * bound the page that carries the total past it refuses with nothing folded. Unbounded otherwise.
 */
function readHistorySuffix(
  kernel: SessionKernel,
  sessionId: string,
  revision: number,
  initial: FoldCheckpoint.State,
  afterRevision: number,
  count: number,
  options: RestoreOptions,
  maxTailBytes: number,
): HydratedSessionHistory | RestoreRefused;
function readHistorySuffix(
  kernel: SessionKernel,
  sessionId: string,
  revision: number,
  initial: FoldCheckpoint.State,
  afterRevision: number,
  count: number,
  options?: RestoreOptions,
): HydratedSessionHistory;
function readHistorySuffix(
  kernel: SessionKernel,
  sessionId: string,
  revision: number,
  initial: FoldCheckpoint.State,
  afterRevision: number,
  count: number,
  options: RestoreOptions = {},
  maxTailBytes?: number,
): HydratedSessionHistory | RestoreRefused {
  const now = options.now ?? (() => performance.now());
  const started = now();
  let state = initial;
  let cursor = afterRevision;
  let nonCheckpointActions = count;
  let rows = 0;
  let bytes = 0;
  let pages = 0;
  while (cursor < revision) {
    const page = kernel.historyPage(sessionId, { afterRevision: cursor, limit: RESTORE_PAGE_ROWS });
    const suffix = page.actions.filter((action) => action.ordinal <= revision);
    if (suffix.length === 0) throw new AgentInvariantViolation("history prefix has a revision gap");
    pages += 1;
    rows += suffix.length;
    bytes += suffix.reduce((total, action) => total + actionPayloadBytes(action), 0);
    if (maxTailBytes !== undefined && bytes > maxTailBytes)
      return new RestoreRefused({
        code: "budget",
        sessionId,
        revision,
        maxTailBytes,
        telemetry: { rows, bytes, pages, ms: now() - started },
      });
    state = foldHistoryState(sessionId, suffix, state);
    nonCheckpointActions += suffix.filter((action) => action.kind !== "fold.checkpoint").length;
    cursor = suffix.at(-1)?.ordinal ?? cursor;
  }
  return {
    revision,
    state,
    history: deriveHistory(state),
    messages: state.compatibility,
    nonCheckpointActions,
    telemetry: { rows, bytes, pages, ms: now() - started },
  };
}

/** A turn intent or resume starts a fresh turn: its assistant text is not yet canonical. */
function opensTurn(action: LedgerAction.Node): boolean {
  const intent = object(action.intent.value);
  return action.kind === "turn" && (intent.phase === "intent" || intent.phase === "resume");
}

/** A delivered prompt enters model context as the user message keyed by its delivery id. */
function deliveredPrompt(
  action: LedgerAction.Node,
  sessionId: string,
): Message.WithParts | undefined {
  const delivery = SessionReads.delivery(action);
  if (delivery?.kind !== "prompt") return undefined;
  return durableText(
    {
      id: delivery.deliveryId,
      sessionID: sessionId,
      role: "user",
      time: { created: action.ts },
      agent: sessionId,
      model: { providerID: "", modelID: "" },
    },
    delivery.content,
  );
}

/** An executed assistant message action carries the message snapshot as its result. */
function assistantSnapshot(action: LedgerAction.Node): Message.WithParts | undefined {
  const intent = object(action.intent.value);
  const effect = object(action.effect.value);
  if (action.kind !== "message" || intent.op !== "assistant") return undefined;
  if (effect.terminal !== "executed") return undefined;
  return Message.WithParts.parse(effect.result);
}

/** A snapshot replaces the message it re-states, or appends when it is new. */
function upsertMessage(
  messages: readonly Message.WithParts[],
  message: Message.WithParts,
): Message.WithParts[] {
  const index = messages.findIndex((existing) => existing.info.id === message.info.id);
  if (index < 0) return [...messages, message];
  return messages.map((existing, position) => (position === index ? message : existing));
}

/** An executed compaction replaces the whole context with its projection. */
function compactionProjection(action: LedgerAction.Node): Message.WithParts[] | undefined {
  const effect = object(action.effect.value);
  if (action.kind !== "compaction" || effect.terminal !== "executed") return undefined;
  const projection = object(effect.result).projection;
  if (!Array.isArray(projection)) return undefined;
  return projection.map((entry) => Message.WithParts.parse(entry));
}

/** A tool action with a committed result settles the matching tool part. */
function toolSettlement(action: LedgerAction.Node): Tool.Result | undefined {
  const effect = object(action.effect.value);
  if (action.kind !== "tool" || effect.toolResult === undefined) return undefined;
  return Tool.Result.parse(effect.toolResult);
}

type OpenToolPart = Message.ToolPart & {
  readonly state: Extract<Tool.State, { status: "pending" | "running" }>;
};

/** The part as a tool part still awaiting its settlement, or nothing for any other part. */
function openToolPart(part: Message.Part): OpenToolPart | undefined {
  if (part.type !== "tool") return undefined;
  const state = part.state;
  return state.status === "pending" || state.status === "running" ? { ...part, state } : undefined;
}

/** The settled state a result gives an open call: its error, or its output under the title. */
function settledState(part: OpenToolPart, result: Tool.Result, at: number): Tool.State {
  const time = { start: at, end: at };
  return result.isError
    ? { status: "error", input: part.state.input, error: toolResultText(result), time }
    : {
        status: "completed",
        input: part.state.input,
        output: toolResultText(result),
        title: part.tool,
        metadata: {},
        time,
      };
}

/** Settle the open part this result names; every other part is untouched. */
function settleToolParts(
  message: Message.WithParts,
  result: Tool.Result,
  at: number,
): Message.WithParts {
  return {
    ...message,
    parts: message.parts.map((part) => {
      const open = openToolPart(part);
      return open !== undefined &&
        open.callID === result.toolCallId &&
        open.tool === result.toolName
        ? { ...open, state: settledState(open, result, at) }
        : part;
    }),
  };
}

/** Every open tool part in the message fails with the given reason at the given time. */
function cancelOpenToolParts(
  message: Message.WithParts,
  error: string,
  at: number,
): Message.WithParts {
  return {
    ...message,
    parts: message.parts.map((part) => {
      const open = openToolPart(part);
      if (open === undefined) return part;
      const state: Tool.State = {
        status: "error",
        input: open.state.input,
        error,
        time: { start: at, end: at },
      };
      return { ...open, state };
    }),
  };
}

/** A turn that ended without a canonical assistant snapshot contributes its terminal text. */
function terminalAssistant(
  text: string,
  parentId: string,
  sessionId: string,
  action: LedgerAction.Node,
): Message.WithParts {
  return durableText(
    {
      id: action.id,
      sessionID: sessionId,
      role: "assistant",
      time: { created: action.ts },
      agent: sessionId,
      parentID: parentId,
      modelID: "",
      providerID: "",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    text,
  );
}

function durableText(info: Message.Info, text: string): Message.WithParts {
  return {
    info,
    parts: [
      {
        id: `${info.id}:part:0`,
        sessionID: info.sessionID,
        messageID: info.id,
        type: "text",
        text,
      },
    ],
  };
}

/** The value as a record, or an empty one: absent facts read as absent fields. */
function object(value: PlainValue | undefined): PlainObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
