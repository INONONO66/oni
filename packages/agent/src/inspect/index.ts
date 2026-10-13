import * as SessionHandleStore from "../core/store/fence";
import type { SessionKernel } from "../core/entity";
import { canonicalDigest, type LedgerAction, type PlainObject, type PlainValue, SessionHistory, SessionTransition, } from "@openomni/protocol";
import { z } from "zod";

export const InspectRequest = SessionHistory.InspectRequest.extend({
  limit: z.number().int().positive().max(256).default(100),
  cursor: z.number().int().nonnegative().default(0),
  childrenCursor: z.string().default(""),
}).strict();
export type InspectRequest = z.input<typeof InspectRequest>;

export interface InspectionPage extends SessionHistory.Inspection {
  readonly nextCursor: number | null;
  readonly nextChildrenCursor: string | null;
  readonly children: readonly InspectionPage[];
}

/**
 * Diagnostic projection of one session's committed actions. Pure over the
 * action list: it reads no store, runs no body and appends nothing. Payloads
 * are reduced to identities, hashes, terminals and reasons.
 */
function inspectActions(
  actions: readonly LedgerAction.Node[],
  sessionId: string,
  parentId: string | null,
  headRevision: number,
  ancestorWindow: (afterRevision: number) => readonly LedgerAction.Node[],
): Omit<SessionHistory.Inspection, "children"> {
  const turns = new Map<string, string | null>();
  // A slice's first actions may descend from turns on earlier pages, so ancestry
  // is resolved outside the page through 256-action history windows: O(chain/256)
  // range reads, and a turn-less chain reports null only when the walk hits root.
  const ancestralTurnId = (child: LedgerAction.Node): string | null => {
    const trail: string[] = [];
    let turnId: string | null = null;
    let current = child.parentId;
    // Every ancestor lives at an ordinal in (0, child.ordinal): parents commit
    // strictly before children and never cross sessions (chain law), so the
    // windows below `low` cover the whole remaining chain.
    const window = new Map<string, LedgerAction.Node>();
    let low = child.ordinal - 1;
    const ancestor = (id: string): LedgerAction.Node | undefined => {
      for (;;) {
        const known = window.get(id);
        if (known !== undefined) return known;
        if (low <= 0) return undefined;
        const after = Math.max(0, low - 256);
        for (const node of ancestorWindow(after)) window.set(node.id, node);
        low = after;
      }
    };
    while (current !== null) {
      if (turns.has(current)) {
        turnId = turns.get(current) ?? null;
        break;
      }
      const node = ancestor(current);
      if (node === undefined) break;
      trail.push(current);
      const own = ownTurnId(node);
      if (own !== undefined) {
        turnId = own;
        break;
      }
      current = node.parentId;
    }
    for (const visited of trail) turns.set(visited, turnId);
    return turnId;
  };
  const turnOf: TurnOf = (action) => (action === undefined ? null : (turns.get(action.id) ?? null));
  const transitions: SessionHistory.Transition[] = [];
  const policy: SessionHistory.PolicyDecision[] = [];
  const requests = new Map<string, SessionHistory.Request>();
  const compactions: SessionHistory.Compaction[] = [];
  const restorations = new Map<string, string[]>();
  for (const action of actions) {
    const turnId = ownTurnId(action) ?? ancestralTurnId(action);
    turns.set(action.id, turnId);
    transitions.push(transitionOf(action, turnId));
    policy.push(...policyDecisionOf(action, turnId));
    const request = requestRecord(action, turnOf);
    if (request !== undefined) requests.set(request.requestId, request);
    const compaction = compactionRecord(action, turnOf, restorations);
    if (compaction !== undefined) compactions.push(compaction);
    const target = restorationTarget(action);
    if (target !== undefined)
      restorations.set(target, [...(restorations.get(target) ?? []), action.id]);
  }
  return {
    sessionId,
    parentId,
    headRevision,
    transitions,
    policy,
    requests: [...requests.values()],
    compactions: compactions.map((record) => ({
      ...record,
      restoredBy: restoredBy(restorations, record.compactionId),
    })),
  };
}

/**
 * Authoritative inspection of a stored session and, to `depth`, the sessions
 * it commissioned, following only the ledger's `parentId` authority. The limit
 * bounds aggregate actions and descendant visits independently: the mandatory
 * root response never consumes the descendant budget.
 */
export function inspectSession(
  kernel: SessionKernel,
  sessionId: string,
  request: InspectRequest = {},
  openKernel: (id: string) => SessionKernel = () => kernel,
): InspectionPage {
  const { depth, cursor, limit, childrenCursor } = InspectRequest.parse(request);
  let budget = limit;
  // Review F3: the descendant visit budget is independent of the mandatory
  // root visit, so every advertised children continuation advances.
  let descendants = limit;
  const visit = (id: string, remaining: number, afterRevision: number, afterChild: string): InspectionPage => {
    const reader = id === sessionId ? kernel : openKernel(id);
    const current = reader.row(id);
    const page = reader.historyPage(id, { afterRevision, limit: budget });
    budget -= page.actions.length;
    const children: InspectionPage[] = [];
    const childRows = remaining === 0 ? [] : reader.childSessionsPage(id, afterChild, limit);
    let nextChildrenCursor: string | null = null;
    let lastChild = afterChild;
    for (const child of childRows) {
      if (budget === 0 || descendants === 0) {
        nextChildrenCursor = lastChild;
        break;
      }
      descendants -= 1;
      children.push(visit(child.id, remaining - 1, 0, ""));
      lastChild = child.id;
    }
    if (childRows.length === limit) nextChildrenCursor ??= lastChild;
    return {
      ...inspectActions(page.actions, id, current.parentId, page.headRevision, (afterRevision) =>
        reader.historyPage(id, { afterRevision, limit: 256 }).actions,
      ),
      nextCursor: page.nextRevision,
      nextChildrenCursor,
      children,
    };
  };
  return visit(sessionId, depth, cursor, childrenCursor);
}

/** Policy decisions narrowed by generation, matched rule and verdict. */
function all(...checks: readonly boolean[]): boolean {
  return checks.every((check) => check);
}

function firstDefined<T>(...values: readonly (T | undefined)[]): T | undefined {
  return values.find((value) => value !== undefined);
}

/** The first non-empty string among candidate payload fields, else null. */
function firstText(...values: readonly (PlainValue | undefined)[]): string | null {
  return firstDefined(...values.map(text)) ?? null;
}

function transitionOf(action: LedgerAction.Node, turnId: string | null): SessionHistory.Transition {
  const intent = object(action.intent.value);
  const effect = object(action.effect.value);
  const request = SessionTransition.Request.safeParse(effect.request);
  const outbound = SessionTransition.Outbound.safeParse(effect.outbound);
  return SessionHistory.Transition.parse({
    revision: action.ordinal,
    actionId: action.id,
    parentId: action.parentId,
    sessionId: action.sessionId,
    kind: action.kind,
    phase: phaseOf(action, intent, effect),
    op: firstText(intent.op, intent.hook),
    at: action.ts,
    turnId,
    callId: firstText(effect.callId, intent.callId, request.data?.callId),
    requestId: firstText(request.data?.requestId, outbound.data?.message.requestId),
    peerSessionId: peerOf(intent, outbound.data),
    cause: causeOf(action, effect),
    outcome: outcomeOf(action, effect, request.data, outbound.data),
    reason: reasonOf(intent, effect),
    digest: canonicalDigest({ intent: action.intent, effect: action.effect }),
  });
}

function ownTurnId(action: LedgerAction.Node): string | undefined {
  if (SessionHandleStore.turnIntent(action) !== undefined) return action.id;
  if (action.kind !== "turn" && SessionHandleStore.delivery(action) === undefined) return undefined;
  return firstDefined(
    text(object(action.effect.value).turnId),
    text(object(action.intent.value).turnId),
  );
}

const KIND_PHASES: Partial<Record<LedgerAction.Kind, SessionHistory.Phase>> = {
  "session.configure": "configure",
  "policy.decision": "decision",
};

const EFFECT_PHASES: ReadonlySet<PlainValue> = new Set([
  "checkpoint",
  "terminal",
  "state",
  "delivery",
  "open",
  "answered",
  "resolved",
  "expired",
]);

function effectPhase(phase: PlainValue | undefined): SessionHistory.Phase | undefined {
  return typeof phase === "string" && EFFECT_PHASES.has(phase)
    ? SessionHistory.Phase.parse(phase)
    : undefined;
}

function intentPhase(phase: PlainValue | undefined): SessionHistory.Phase {
  if (phase === "intent" || phase === "resume") return "intent";
  return phase === "result" ? "result" : "record";
}

function phaseOf(
  action: LedgerAction.Node,
  intent: PlainObject,
  effect: PlainObject,
): SessionHistory.Phase {
  return KIND_PHASES[action.kind] ?? effectPhase(effect.phase) ?? intentPhase(intent.phase);
}

function deliveryCause(
  action: LedgerAction.Node,
  effect: PlainObject,
): SessionHistory.Cause | undefined {
  const deliveryId = text(effect.deliveryId);
  return SessionHandleStore.delivery(action) !== undefined && deliveryId !== undefined
    ? { kind: "delivery", deliveryIds: [deliveryId] }
    : undefined;
}

function lineageCause(action: LedgerAction.Node): SessionHistory.Cause {
  if (action.parentId !== null) return { kind: "action", actionId: action.parentId };
  // Turns always descend from `session.configure`, so a root action is never a turn with delivery ids.
  return action.kind === "prompt" ? { kind: "delivery", deliveryIds: [action.id] } : { kind: "root" };
}

function causeOf(
  action: LedgerAction.Node,
  effect: PlainObject,
): SessionHistory.Cause {
  // Alarm rows surface through the `alarms` read model, so history causes
  // fall through to delivery/lineage.
  return deliveryCause(action, effect) ?? lineageCause(action);
}

function outboundOutcome(outbound: SessionTransition.Outbound): SessionHistory.Outcome {
  return outbound.state === "delivered" ? "executed" : "pending";
}

function outcomeOf(
  action: LedgerAction.Node,
  effect: PlainObject,
  request: SessionTransition.Request | undefined,
  outbound: SessionTransition.Outbound | undefined,
): SessionHistory.Outcome | null {
  if (request !== undefined) return requestOutcome(request);
  if (outbound !== undefined) return outboundOutcome(outbound);
  // A pre denial commits no intent; its decision is the call's only terminal record.
  if (action.kind === "policy.decision") return preDenial(object(action.intent.value));
  return recordedOutcome(action, effect);
}

/** The outcome an action's own record states: its turn terminal, a pending phase, or a settled terminal. */
function recordedOutcome(
  action: LedgerAction.Node,
  effect: PlainObject,
): SessionHistory.Outcome | null {
  const terminal = SessionHandleStore.turnTerminal(action);
  if (terminal !== undefined) return TURN_OUTCOMES[terminal.kind];
  if (effect.phase === "pending") return "pending";
  const settled = SessionHistory.Outcome.safeParse(effect.terminal);
  return settled.success ? settled.data : null;
}

function preDenial(intent: PlainObject): SessionHistory.Outcome | null {
  return intent.verdict === "deny" && text(intent.hook)?.endsWith(".pre") === true
    ? "blocked_pre"
    : null;
}

const TURN_OUTCOMES = {
  result: "executed",
  error: "failed",
  interrupted: "cancelled",
  waiting: "pending",
} as const satisfies Record<string, SessionHistory.Outcome>;

const REQUEST_OUTCOMES = {
  answered: "executed",
  denied: "blocked_pre",
  outcome_unknown: "outcome_unknown",
  cancelled: "cancelled",
} as const satisfies Record<string, SessionHistory.Outcome>;

function requestOutcome(request: SessionTransition.Request): SessionHistory.Outcome {
  return request.outcome === null ? "pending" : REQUEST_OUTCOMES[request.outcome];
}

function reasonOf(intent: PlainObject, effect: PlainObject): string | null {
  const terminal = text(effect.kind);
  if (effect.phase === "terminal" && terminal !== undefined) return terminal;
  const verdict = text(intent.verdict);
  if (verdict !== undefined) return firstText(effect.reason, verdict);
  return firstText(object(effect.error).name, effect.reason, effect.status);
}

function peerOf(
  intent: PlainObject,
  outbound: SessionTransition.Outbound | undefined,
): string | null {
  if (outbound !== undefined) return outbound.message.destinationSessionId;
  return firstText(
    intent.sourceSessionId,
    intent.senderSessionId,
    object(intent.message).senderSessionId,
  );
}

function policyDecisionOf(
  action: LedgerAction.Node,
  turnId: string | null,
): SessionHistory.PolicyDecision[] {
  if (action.kind !== "policy.decision") return [];
  const intent = object(action.intent.value);
  const effect = object(action.effect.value);
  return [
    SessionHistory.PolicyDecision.parse({
      revision: action.ordinal,
      actionId: action.id,
      subjectActionId: action.parentId,
      turnId,
      hook: intent.hook,
      op: intent.op,
      generation: intent.generation,
      matchedRuleIds: intent.matchedRuleIds,
      transforms: intent.transforms,
      ref: intent.ref,
      verdict: intent.verdict,
      reason: effect.reason ?? null,
      inputHash: intent.inputHash,
    }),
  ];
}

type TurnOf = (action: LedgerAction.Node | undefined) => string | null;

function requestSummary(
  request: SessionTransition.Request,
  action: LedgerAction.Node,
  turnOf: TurnOf,
): SessionHistory.Request {
  return {
    requestId: request.requestId,
    revision: action.ordinal,
    turnId: request.turnId ?? turnOf(action),
    callId: request.callId,
    mode: request.mode,
    inputHash: request.inputHash,
    state: request.state,
    outcome: requestOutcome(request),
    deadline: request.deadline,
    expectedResponders: request.expectedResponders,
    replyCount: request.replies.length,
  };
}

function requestRecord(
  action: LedgerAction.Node,
  turnOf: TurnOf,
): SessionHistory.Request | undefined {
  if (action.kind !== "request") return undefined;
  const parsed = SessionTransition.Request.safeParse(object(action.effect.value).request);
  return parsed.success ? requestSummary(parsed.data, action, turnOf) : undefined;
}

function isRestoreIntent(action: LedgerAction.Node, intent: PlainObject): boolean {
  return all(
    action.kind === "compaction",
    intent.op === "restore_context_projection",
    intent.phase === "intent",
  );
}

function restorationTarget(action: LedgerAction.Node): string | undefined {
  const intent = object(action.intent.value);
  if (!isRestoreIntent(action, intent)) return undefined;
  const compactionId = object(intent.value).compactionId;
  return typeof compactionId === "string" ? compactionId : undefined;
}

function compactionResult(
  action: LedgerAction.Node,
): { readonly result: PlainObject; readonly summary: string } | undefined {
  const effect = object(action.effect.value);
  const result = object(effect.result);
  const { summary } = result;
  return effect.terminal === "executed" && typeof summary === "string"
    ? { result, summary }
    : undefined;
}

function discardedOf(discarded: PlainObject): SessionHistory.Compaction["discarded"] {
  return {
    firstEntryId: String(discarded.firstEntryId),
    lastEntryId: String(discarded.lastEntryId),
    count: Number(discarded.count),
    sha256: String(discarded.sha256),
  };
}

function restoredBy(restorations: ReadonlyMap<string, string[]>, compactionId: string): string[] {
  return restorations.get(compactionId) ?? [];
}

function compactionRecord(
  action: LedgerAction.Node,
  turnOf: TurnOf,
  restorations: ReadonlyMap<string, string[]>,
): SessionHistory.Compaction | undefined {
  const executed = action.kind === "compaction" ? compactionResult(action) : undefined;
  if (action.parentId === null || executed === undefined) return undefined;
  return {
    compactionId: action.parentId,
    resultId: action.id,
    revision: action.ordinal,
    turnId: turnOf(action),
    summaryDigest: canonicalDigest(executed.summary),
    firstKeptEntryId: String(executed.result.firstKeptEntryId),
    discarded: discardedOf(object(executed.result.discarded)),
    restoredBy: restoredBy(restorations, action.parentId),
  };
}

function object(value: PlainValue | undefined): PlainObject {
  return Array.isArray(value) || typeof value !== "object" || value === null ? {} : value;
}

function text(value: PlainValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** One stored tool output resolved for a reader, or the typed unknown. */
export type ToolOutputInspection =
  | {
      readonly kind: "output";
      readonly outputId: string;
      readonly bytes: number;
      readonly mediaType?: string;
      /** UTF-8 decode of the stored bytes — both stored media types are text. */
      readonly text: string;
    }
  | { readonly kind: "unknown_output"; readonly outputId: string };

/**
 * Resolves a projected row's `outputRef` back to the full stored output: a
 * pure read over the session file's `tool_outputs` table; an unknown
 * identifier answers typed instead of throwing.
 */
export function toolOutput(
  kernel: SessionHandleStore.SessionKernel,
  outputId: string,
): ToolOutputInspection {
  const stored = kernel.toolOutput(outputId);
  if (stored === undefined) return { kind: "unknown_output", outputId };
  return {
    kind: "output",
    outputId,
    bytes: stored.bytes.byteLength,
    ...(stored.mediaType === undefined ? {} : { mediaType: stored.mediaType }),
    text: new TextDecoder().decode(stored.bytes),
  };
}

export { attemptUsage, toolWallMs } from "../core/metrics";

export { FORK_ASIDE_REF, forkAncestryOf, forkAside, inspectTree, type InspectTreeRequest, type SessionTreeNode } from "./tree";
