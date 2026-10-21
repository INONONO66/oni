import { configurationSnapshot, configureAction } from "../store/configure";
/**
 * The child genesis pins the parent, anchor, anchor parent ordinal and chain
 * head so later parent appends never alter the child's verification. Arms,
 * the armed index and checkpoint rows are never copied; copied input and
 * delivery rows are renamed `fork:<parent>:<id>` so a pre-fork key is admitted fresh.
 */
import { Data, Effect } from "effect";
import type { LedgerAction, LedgerSession, PlainValue, SessionGeneration } from "@oni/protocol";
import type { SessionKernel } from "../store/fence";

import { actionPayloadBytes } from "../store/action-hash";
import { consumptionSettings } from "../journal/delivery";
import type { LedgerError } from "../store/errors";
import type { SessionForkReceipt, SessionIndexUnit, SessionStore } from "../store/session-file/index.js";
import type { ToolOutputWrite } from "../store/session-file/outputs";
import { SESSION_FILE_SCHEMA_VERSION } from "../store/session-file/index.js";
import { sessionIdProblem } from "./session-id";

/**
 * A generation overrides this by pinning `settings.forkCopyByteCap`; the fork reads the cap off the
 * parent generation, never a caller constant.
 */
export const DEFAULT_FORK_COPY_BYTE_CAP = 4 * 1024 * 1024;

export type ForkRefusalReason =
  | "parent_not_found"
  | "parent_chain_broken"
  | "schema_version"
  | "anchor_not_found"
  | "anchor_not_boundary"
  | "byte_cap"
  | "child_exists"
  | "child_id_invalid"
  | "output_missing";

/** Every fork failure path lands here. */
export class ForkRefused extends Data.TaggedError("ForkRefused")<{
  readonly sessionId: string;
  readonly reason: ForkRefusalReason;
  readonly detail: string;
}> {
  override get message(): string {
    return `fork of session ${this.sessionId} refused (${this.reason}): ${this.detail}`;
  }
}

export interface ForkInput {
  readonly from: string;
  /** The parent `actionHash` of a `turn{terminal}`, `prompt` or `compaction` row. */
  readonly at: string;
  /** Caller-minted (injected entropy). */
  readonly childId: string;
  readonly genesisActionId: string;
  readonly now: number;
}

export interface ForkPorts {
  readonly parent: SessionKernel;
  /** Probed without modifying the file. */
  readonly parentSchemaVersion: number;
  /** Called only after every parent-side check passed. */
  readonly openChild: () => SessionStore;
  readonly catalog: SessionIndexUnit;
}

export interface ForkReceipt {
  readonly childId: string;
  readonly parentId: string;
  readonly forkedFrom: SessionGeneration.ForkAncestry;
  readonly head: string;
  readonly row: LedgerSession.Row;
}

function plainObject(value: PlainValue): Record<string, PlainValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/** Only `turn{terminal}`, `prompt` and `compaction` hashes anchor a fork. */
export function isForkBoundary(action: LedgerAction.Node): boolean {
  if (action.kind === "prompt" || action.kind === "compaction") return true;
  return action.kind === "turn" && plainObject(action.effect.value)?.phase === "terminal";
}

/** Input rows carry the deliver door's idempotency key as their id. */
function isInputRow(action: LedgerAction.Node): boolean {
  if (action.kind !== "prompt" && action.kind !== "signal" && action.kind !== "action") return false;
  return typeof plainObject(action.effect.value)?.deliveryKind === "string";
}

/** Consumption re-mints `<deliveryId>:delivery` on re-admission; a copy must not keep it. */
function isDeliveryRow(action: LedgerAction.Node): boolean {
  if (action.kind !== "prompt" && action.kind !== "signal" && action.kind !== "action") return false;
  return plainObject(action.effect.value)?.phase === "delivery";
}

function isArmRow(action: LedgerAction.Node): boolean {
  return action.kind === "alarm" && plainObject(action.intent.value)?.op === "arm";
}

/** A projected tool row carries stored-output refs; the fork copies those bytes for the child. */
function collectOutputIds(value: PlainValue, into: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectOutputIds(entry, into);
    return;
  }
  const outputId = value.outputId;
  if (typeof outputId === "string" && /^sha256:[0-9a-f]{64}$/.test(outputId)) into.add(outputId);
  for (const entry of Object.values(value)) collectOutputIds(entry, into);
}

/** Remaps renamed-row references (`deliveryId`/`turnId`) inside one payload. */
function remapPayload(
  payload: LedgerAction.Node["intent"],
  renames: ReadonlyMap<string, string>,
): LedgerAction.Node["intent"] {
  const value = plainObject(payload.value);
  if (value === undefined) return payload;
  let next: Record<string, PlainValue> | undefined;
  for (const field of ["deliveryId", "turnId"] as const) {
    const reference = value[field];
    if (typeof reference !== "string") continue;
    const renamed = renames.get(reference);
    if (renamed === undefined) continue;
    next ??= { ...value };
    next[field] = renamed;
  }
  return next === undefined ? payload : { encodingVersion: payload.encodingVersion, value: next };
}

function copyAction(
  node: LedgerAction.Node,
  childId: string,
  ids: ReadonlyMap<string, string>,
  renames: ReadonlyMap<string, string>,
): LedgerAction.Append {
  const base = {
    id: ids.get(node.id) ?? node.id,
    // A parent reference to an excluded row (an arm, a checkpoint) drops to null.
    parentId: node.parentId === null ? null : (ids.get(node.parentId) ?? null),
    sessionId: childId,
    kind: node.kind,
    intent: remapPayload(node.intent, renames),
    effect: remapPayload(node.effect, renames),
    ts: node.ts,
  };
  return "revert" in node ? { ...base, revert: node.revert } : { ...base, irreversible: true };
}

function readParentPrefix(
  parent: SessionKernel,
  from: string,
  anchorHash: string,
): { anchor: LedgerAction.Node | undefined; prefix: LedgerAction.Node[] } {
  const prefix: LedgerAction.Node[] = [];
  let afterRevision = 0;
  for (;;) {
    const page = parent.historyPage(from, { afterRevision, limit: 256 });
    for (const action of page.actions) {
      prefix.push(action);
      if (action.actionHash === anchorHash) return { anchor: action, prefix };
    }
    if (page.nextRevision === null) return { anchor: undefined, prefix };
    afterRevision = page.nextRevision;
  }
}

/**
 * Parent-side checks first; the child is written in one transaction; the catalog `parent_id` row
 * lands last because its connection cannot join the file transaction.
 */
interface ForkPlan {
  readonly parentRow: ReturnType<SessionKernel["row"]>;
  readonly copies: readonly LedgerAction.Append[];
  /** Stored outputs the copied rows reference, re-stored on the child. */
  readonly outputs: readonly ToolOutputWrite[];
  readonly forkedFrom: SessionGeneration.ForkAncestry;
  /** The newest configure at or before the anchor. */
  readonly snapshot: SessionGeneration.Snapshot;
}

/** Refuses before any child write. */
function planFork(ports: ForkPorts, input: ForkInput): ForkPlan | ForkRefused {
  const refuse = (reason: ForkRefusalReason, detail: string) =>
    new ForkRefused({ sessionId: input.from, reason, detail });
  const childIdProblem = sessionIdProblem(input.childId);
  if (childIdProblem !== undefined) return refuse("child_id_invalid", childIdProblem);
  if (ports.parentSchemaVersion !== SESSION_FILE_SCHEMA_VERSION)
    return refuse(
      "schema_version",
      `parent file schemaVersion ${ports.parentSchemaVersion} is not ${SESSION_FILE_SCHEMA_VERSION}`,
    );
  let parentRow: ReturnType<SessionKernel["row"]>;
  try {
    parentRow = ports.parent.row(input.from);
  } catch {
    return refuse("parent_not_found", "parent session row is missing");
  }
  const verdict = ports.parent.verifyChain(input.from);
  if (verdict.kind === "broken")
    return refuse("parent_chain_broken", `parent chain breaks at ordinal ${verdict.ordinal}`);
  if (verdict.head === null) return refuse("anchor_not_found", "parent chain is empty");
  const { anchor, prefix } = readParentPrefix(ports.parent, input.from, input.at);
  if (anchor === undefined) return refuse("anchor_not_found", `no parent action has hash ${input.at}`);
  if (!isForkBoundary(anchor))
    return refuse(
      "anchor_not_boundary",
      `anchor ${anchor.id} is a mid-turn ${anchor.kind} row, not a turn{terminal}, prompt or compaction boundary`,
    );
  const eligible = prefix.filter((node) => node.kind !== "fold.checkpoint" && !isArmRow(node));
  // Folded off the parent's latest `session.configure{settings}` row, like the consumption widths.
  const cap = consumptionSettings(ports.parent, input.from).forkCopyByteCap ?? DEFAULT_FORK_COPY_BYTE_CAP;
  // Stored outputs travel with the fork and count against the same byte cap —
  // projection must not smuggle bytes past it.
  const outputIds = new Set<string>();
  for (const node of eligible) collectOutputIds(node.effect.value, outputIds);
  const outputs: ToolOutputWrite[] = [];
  for (const outputId of outputIds) {
    const stored = ports.parent.toolOutput(outputId);
    if (stored === undefined) return refuse("output_missing", `parent holds no tool output ${outputId}`);
    outputs.push(stored);
  }
  const snapshot = eligible.map(configurationSnapshot).filter((entry) => entry !== undefined).at(-1);
  if (snapshot === undefined) return refuse("anchor_not_found", "no configured generation precedes the anchor");
  const bytes =
    eligible.reduce((total, node) => total + actionPayloadBytes(node), 0) +
    outputs.reduce((total, output) => total + output.bytes.byteLength, 0);
  if (bytes > cap) return refuse("byte_cap", `copied bytes ${bytes} exceed the cap ${cap}`);
  const renames = new Map<string, string>();
  for (const node of eligible) {
    if (isInputRow(node) || isDeliveryRow(node))
      renames.set(node.id, `fork:${input.from}:${node.id}`);
  }
  const ids = new Map<string, string>();
  for (const node of eligible) ids.set(node.id, renames.get(node.id) ?? node.id);
  return {
    parentRow,
    copies: eligible.map((node) => copyAction(node, input.childId, ids, renames)),
    outputs,
    snapshot,
    forkedFrom: {
      session: input.from,
      anchor: anchor.actionHash,
      parentSeq: anchor.ordinal,
      parentHead: verdict.head,
      copied: eligible.length,
    },
  };
}

export function forkSession(
  ports: ForkPorts,
  input: ForkInput,
): Effect.Effect<ForkReceipt, ForkRefused | LedgerError> {
  return Effect.gen(function* () {
    const plan = planFork(ports, input);
    if (plan instanceof ForkRefused) return yield* plan;
    const { parentRow, copies, outputs, forkedFrom, snapshot } = plan;
    const child = ports.openChild();
    if (child.sessions.get(input.childId) !== undefined)
      return yield* new ForkRefused({
        sessionId: input.from,
        reason: "child_exists",
        detail: `child session ${input.childId} already exists`,
      });
    const receipt: SessionForkReceipt = yield* child.fork({
      materialize: {
        row: {
          id: input.childId,
          parentId: input.from,
          role: parentRow.role,
          fenceOwner: null,
          fence: 0,
          revision: 0,
          state: "idle",
          toolsGeneration: snapshot.generation,
          systemHash: snapshot.systemHash,
          policyGeneration: snapshot.policyGeneration,
        },
        initialAction: configureAction({
          id: input.genesisActionId,
          sessionId: input.childId,
          parentId: null,
          operation: "fork",
          snapshot,
          forkedFrom,
          at: input.now,
        }),
      },
      index: ports.catalog,
      createdAt: input.now,
      copies,
      outputs,
    });
    return { childId: input.childId, parentId: input.from, forkedFrom, head: receipt.head, row: receipt.row };
  });
}
