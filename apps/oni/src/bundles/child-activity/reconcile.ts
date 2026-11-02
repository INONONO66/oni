import { ChildLifecycleEvidence, Delivery, Machine, TranscriptRef, canonicalDigest, canonicalJson, parseJson, type LedgerAction } from "@oni/protocol";
import { z } from "zod";
import { phaseOf } from "./contact/rule";

const Fact = ChildLifecycleEvidence.pick({ child: true, turn: true, toolUseId: true, phase: true });
const Receipt = z.strictObject({
  factKey: z.string(),
  ref: ChildLifecycleEvidence.shape.ref,
  diagnostics: ChildLifecycleEvidence.shape.diagnostics,
  observedAt: z.number().int().nonnegative(),
  contact: z.string().min(1).optional(),
  cursor: Machine.AgentSessionCursor.optional(),
});
const Conflict = z.strictObject({
  code: z.literal("idempotency_conflict"),
  key: z.string(),
  receivedDigest: z.string(),
});
export const ChildRow = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("child_fact"), key: z.string(), content: Fact }),
  z.strictObject({ kind: z.literal("child_receipt"), key: z.string(), content: Receipt }),
  z.strictObject({ kind: z.literal("child_conflict"), key: z.string(), content: Conflict }),
  z.strictObject({
    kind: z.literal("child_diagnostic"), key: z.string(),
    content: z.strictObject({
      child: z.string(), turn: z.string(), ref: TranscriptRef,
      diagnostic: ChildLifecycleEvidence.shape.diagnostics.element,
    }),
  }),
]);
export type ChildRow = z.infer<typeof ChildRow>;
const ReceivedChildAction = z.object({
  kind: z.literal("action"),
  intent: z.object({ value: z.object({ kind: z.literal("child_activity") }) }),
  effect: z.object({ value: z.object({ content: Delivery.Content }) }),
});

export function receivedChildRows(actions: readonly Pick<LedgerAction.Node, "kind" | "intent" | "effect">[]): ChildRow[] {
  return actions.flatMap((action) => {
    const received = ReceivedChildAction.safeParse(action);
    if (!received.success) return [];
    const row = parseJson(ChildRow, Delivery.text(received.data.effect.value.content));
    return row === undefined ? [] : [row];
  });
}

const authority = { screen: 0, transcript: 1, hook: 2 } as const;
function source(ref: ChildLifecycleEvidence["ref"]): keyof typeof authority {
  return "kind" in ref ? "hook" : "transcript";
}

export function conflictRow(row: ChildRow): Extract<ChildRow, { kind: "child_conflict" }> {
  const content = {
    code: "idempotency_conflict" as const,
    key: row.key,
    receivedDigest: canonicalDigest(row.content),
  };
  return { kind: "child_conflict", key: canonicalDigest(content), content };
}

function diagnosticRow(
  identity: { readonly child: string; readonly turn: string },
  diagnostic: { readonly ref: TranscriptRef; readonly diagnostic: { readonly code: string; readonly detail: string } },
): ChildRow {
  const content = { ...identity, ...diagnostic };
  return { kind: "child_diagnostic", key: canonicalDigest(content), content };
}

interface TranscriptPage {
  readonly machine: string;
  readonly contact: string;
  readonly child: string;
  readonly turn: string;
  readonly records: readonly Machine.AgentTranscriptRecord[];
  readonly cursor: Machine.AgentSessionCursor;
  readonly previous: Machine.AgentSessionCursor;
  readonly observedAt: number;
}

function recordRef(page: TranscriptPage): TranscriptRef {
  return {
    machine: page.machine,
    export: "agent-session",
    path: `/agent-session/${page.child}`,
    generation: {
      kind: "inode",
      device: String(page.cursor.generation),
      inode: page.cursor.recordHash,
    },
    range: {
      offsetBytes: page.previous.byteOffset,
      lengthBytes: page.cursor.byteOffset - page.previous.byteOffset,
    },
    parser: { dialect: "agent-session", version: "1" },
  };
}

/** Every machine-client record independently admits its source-free fact and retained cursor receipt. */
export function reconcile(
  page: TranscriptPage,
  admitted: readonly ChildRow[],
): ChildRow[] {
  const known = new Map(admitted.map((row) => [row.key, row]));
  const added: ChildRow[] = [];
  const append = (row: ChildRow) => {
    const previous = known.get(row.key);
    if (previous !== undefined) {
      if (canonicalJson(previous) === canonicalJson(row)) return;
      const conflict = conflictRow(row);
      if (!known.has(conflict.key)) {
        known.set(conflict.key, conflict);
        added.push(conflict);
      }
      return;
    }
    known.set(row.key, row);
    added.push(row);
  };
  for (const record of page.records) {
    const phase = phaseOf(record);
    const ref = recordRef(page);
    if (phase === undefined) {
      append(diagnosticRow(
        { child: page.child, turn: page.turn },
        { ref, diagnostic: { code: record.kind, detail: record.kind === "corrupt" ? record.reason : record.kind === "truncated" ? String(record.originalBytes) : "" } },
      ));
      continue;
    }
    const content = {
      child: page.child,
      turn: page.turn,
      phase,
      ...(record.kind === "tool_call" || record.kind === "tool_result" ? { toolUseId: record.callId } : {}),
    };
    const factKey = canonicalDigest(content);
    append({ kind: "child_fact", key: factKey, content });
    const key = canonicalDigest([factKey, "transcript", ref]);
    const previous = known.get(key);
    append({
      kind: "child_receipt", key,
      content: {
        factKey,
        ref,
        diagnostics: [],
        contact: page.contact,
        cursor: page.cursor,
        // A later read is not a new observation of the same retained bytes.
        observedAt: previous?.kind === "child_receipt" ? previous.content.observedAt : page.observedAt,
      },
    });
  }
  return added;
}

export function contactCursor(rows: readonly ChildRow[], contact: string): Machine.AgentSessionCursor | undefined {
  return rows.reduce<Machine.AgentSessionCursor | undefined>((latest, row) => {
    if (row.kind !== "child_receipt" || row.content.contact !== contact || row.content.cursor === undefined) return latest;
    if (latest === undefined || row.content.cursor.generation > latest.generation) return row.content.cursor;
    return row.content.cursor.generation === latest.generation && row.content.cursor.byteOffset > latest.byteOffset
      ? row.content.cursor
      : latest;
  }, undefined);
}

export interface StateReceipt {
  readonly fact: z.infer<typeof Fact>;
  readonly receipt: z.infer<typeof Receipt>;
  readonly source: keyof typeof authority;
}

function receiptPosition(receipt: StateReceipt["receipt"]): number {
  return "kind" in receipt.ref ? receipt.ref.seq : receipt.observedAt;
}

function generationSize(generation: TranscriptRef["generation"]): number {
  return generation.kind === "size-and-prefix-hash" ? generation.size : -1;
}

/** Same generation: the later byte offset; otherwise the larger size, then the canonical generation text. */
function compareTranscriptRefs(next: TranscriptRef, current: TranscriptRef): number {
  const generation = canonicalJson(next.generation);
  const held = canonicalJson(current.generation);
  if (generation === held) return next.range.offsetBytes - current.range.offsetBytes;
  const size = generationSize(next.generation) - generationSize(current.generation);
  if (size !== 0) return size;
  return generation > held ? 1 : -1;
}

/** Positive when `next` outranks `current`: authority, then position (hook seq or observedAt), then the transcript ref. */
function compareReceipts(next: StateReceipt, current: StateReceipt): number {
  const rank = authority[next.source] - authority[current.source];
  if (rank !== 0) return rank;
  const position = receiptPosition(next.receipt) - receiptPosition(current.receipt);
  if (position !== 0) return position;
  if ("kind" in next.receipt.ref || "kind" in current.receipt.ref) return 0;
  return compareTranscriptRefs(next.receipt.ref, current.receipt.ref);
}

/**
 * A derived view only: no winning receipt removes or rewrites a journal row.
 * The comparison is total, so the fold does not depend on input order.
 */
export function currentState(receipts: readonly StateReceipt[]): StateReceipt | undefined {
  return receipts.reduce<StateReceipt | undefined>(
    (current, next) => current === undefined || compareReceipts(next, current) > 0 ? next : current,
    undefined,
  );
}

function childReceipts(rows: readonly ChildRow[], child: string): StateReceipt[] {
  const facts = new Map(rows.flatMap((row) => row.kind === "child_fact" ? [[row.key, row.content] as const] : []));
  return rows.flatMap((row) => {
    if (row.kind !== "child_receipt") return [];
    const fact = facts.get(row.content.factKey);
    return fact?.child === child ? [{ fact, receipt: row.content, source: source(row.content.ref) }] : [];
  });
}

/** Join persisted receipt references to their source-free facts for one child turn. */
export function stateReceipts(rows: readonly ChildRow[], child: string, turn: string): StateReceipt[] {
  return childReceipts(rows, child).filter((entry) => entry.fact.turn === turn);
}
