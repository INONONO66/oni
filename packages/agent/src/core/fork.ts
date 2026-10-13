/**
 * `Session.fork` (#1257): fork a session at a verifiable chain boundary into
 * a new session file with its own hash chain. The child genesis is a
 * `session.configure{operation: "fork", forkedFrom}` row pinning the parent,
 * the boundary anchor, the anchor's parent ordinal and the parent chain head
 * at fork time — so later parent appends or compactions can never alter the
 * child's verification. Eligible pre-anchor parent rows are appended after
 * genesis in parent order, rehashed on the child chain.
 *
 * Exclusions (#1254 semantics): `alarm{arm}` rows and the `armed_alarms`
 * index are never copied, so the child re-registers zero alarms while the
 * parent keeps firing; copied `alarm{fired}` rows without an arm fold to a
 * `skip{unknown}` disposition. `fold.checkpoint` accelerator rows are
 * store-internal and carry parent ordinals, so they are excluded too.
 *
 * Deduplication rebuilds only after genesis: copied input rows (the rows
 * carrying an `deliveryKind` effect, whose ids are the deliver door's
 * idempotency keys) AND their delivery rows (`<deliveryId>:delivery`, the one
 * deterministic id consumption re-mints — core/commit.ts `deliveryActions`)
 * are renamed `fork:<parentSessionId>:<id>` — the embedded parent session id
 * marks a leaked key stale — with every `deliveryId`/`turnId` reference and
 * parent pointer remapped alongside, so a pre-fork `idempotencyKey` delivered
 * to the child is admitted fresh AND completes its turn: no copied row
 * occupies an id the child's own admission or consumption will need.
 */
import { Data, Effect } from "effect";
import type { LedgerAction, LedgerSession, PlainValue, SessionGeneration } from "@openomni/protocol";
import type { SessionKernel } from "./store/fence";
import { configureAction } from "./store/fence";
import { consumptionSettings } from "./commit";
import type { LedgerError } from "./store/errors";
import type {
  SessionForkReceipt,
  SessionIndexUnit,
  SessionStore,
  ToolOutputWrite,
} from "./store/session-file/index.js";
import { SESSION_FILE_SCHEMA_VERSION } from "./store/session-file/index.js";

/**
 * Default cap on copied journal bytes. A session generation overrides it by
 * pinning `session.configure{settings.forkCopyByteCap}` (#1257); the fork
 * path reads the cap off the parent generation it runs under, never a
 * caller-supplied constant.
 */
export const DEFAULT_FORK_COPY_BYTE_CAP = 4 * 1024 * 1024;

export type ForkRefusalReason =
  | "parent_not_found"
  | "parent_chain_broken"
  | "schema_version"
  | "anchor_not_found"
  | "anchor_not_boundary"
  | "byte_cap"
  | "child_exists";

/** Typed fork refusal (#1257): every fork failure path lands here. */
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
  /** Parent session id. */
  readonly from: string;
  /** Anchor: the parent `actionHash` of a `turn{terminal}`, `prompt` or `compaction` row. */
  readonly at: string;
  /** Caller-minted child session id (injected entropy, #1245). */
  readonly childId: string;
  /** Caller-minted child genesis action id. */
  readonly genesisActionId: string;
  /** Injected wall-clock timestamp of the fork. */
  readonly now: number;
}

export interface ForkPorts {
  /** Read surface over the parent's committed chain. */
  readonly parent: SessionKernel;
  /** The parent session file's schemaVersion, probed without modifying the file. */
  readonly parentSchemaVersion: number;
  /** Opens the child session store; called only after every parent-side check passed. */
  readonly openChild: () => SessionStore;
  /** The catalog write unit the child's index lands in, enclosing the child write. */
  readonly catalog: SessionIndexUnit;
}

export interface ForkReceipt {
  readonly childId: string;
  readonly parentId: string;
  readonly forkedFrom: SessionGeneration.ForkAncestry;
  /** Child chain head hash after genesis plus every copied row. */
  readonly head: string;
  readonly row: LedgerSession.Row;
}

function plainObject(value: PlainValue): Record<string, PlainValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/** Boundary rule: only `turn{terminal}`, `prompt` and `compaction` hashes anchor a fork. */
export function isForkBoundary(action: LedgerAction.Node): boolean {
  if (action.kind === "prompt" || action.kind === "compaction") return true;
  return action.kind === "turn" && plainObject(action.effect.value)?.phase === "terminal";
}

/** Input rows carry the deliver door's idempotency key as their id. */
function isInputRow(action: LedgerAction.Node): boolean {
  if (action.kind !== "prompt" && action.kind !== "signal" && action.kind !== "action") return false;
  return typeof plainObject(action.effect.value)?.deliveryKind === "string";
}

/**
 * Delivery rows: consumption deterministically re-mints `<deliveryId>:delivery`
 * (core/commit.ts `deliveryActions`) for a re-admitted key, so a copied one
 * must never keep that id slot on the child chain.
 */
function isDeliveryRow(action: LedgerAction.Node): boolean {
  if (action.kind !== "prompt" && action.kind !== "signal" && action.kind !== "action") return false;
  return plainObject(action.effect.value)?.phase === "delivery";
}

function isArmRow(action: LedgerAction.Node): boolean {
  return action.kind === "alarm" && plainObject(action.intent.value)?.op === "arm";
}

/**
 * Stored-output references inside one copied row (#1305): a projected tool
 * row carries `{outputId, bytes, preview}` refs in its effect payload; the
 * fork must copy those bytes so the child's `tool_output` reads resolve.
 */
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

function copiedBytes(action: LedgerAction.Node): number {
  const revert = "revert" in action ? JSON.stringify(action.revert.value) : "";
  return Buffer.byteLength(
    JSON.stringify(action.intent.value) + JSON.stringify(action.effect.value) + revert,
  );
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
 * Forks `input.from` at the boundary `input.at` into the child session
 * `input.childId`. Parent-side checks run first; the child file is opened and
 * written only after they pass, in one atomic transaction; the catalog
 * `session_index.parent_id` row is written last (its separate connection
 * cannot transact with the session file).
 */
interface ForkPlan {
  readonly parentRow: ReturnType<SessionKernel["row"]>;
  readonly copies: readonly LedgerAction.Append[];
  /** #1305: stored outputs the copied rows reference, re-stored on the child. */
  readonly outputs: readonly ToolOutputWrite[];
  readonly forkedFrom: SessionGeneration.ForkAncestry;
}

/** Parent-side fork checks and copy planning; refuses before any child write. */
function planFork(ports: ForkPorts, input: ForkInput): ForkPlan | ForkRefused {
  const refuse = (reason: ForkRefusalReason, detail: string) =>
    new ForkRefused({ sessionId: input.from, reason, detail });
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
  // Generation-configured cap (#1257): folded off the parent's latest
  // `session.configure{settings}` row, exactly like the consumption widths.
  const cap = consumptionSettings(ports.parent, input.from).forkCopyByteCap ?? DEFAULT_FORK_COPY_BYTE_CAP;
  // #1305: stored outputs referenced by copied rows travel with the fork and
  // count against the same byte cap — projection must not smuggle bytes past it.
  const outputIds = new Set<string>();
  for (const node of eligible) collectOutputIds(node.effect.value, outputIds);
  const outputs: ToolOutputWrite[] = [];
  for (const outputId of outputIds) {
    const stored = ports.parent.toolOutput(outputId);
    if (stored !== undefined) outputs.push(stored);
  }
  const bytes =
    eligible.reduce((total, node) => total + copiedBytes(node), 0) +
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
    const { parentRow, copies, outputs, forkedFrom } = plan;
    const snapshot = ports.parent.latestGenerationFor(input.from);
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
