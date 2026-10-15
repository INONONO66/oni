import { ChildLifecycleEvidence, TranscriptRef, canonicalDigest, canonicalJson, parseJson, type LedgerAction } from "@openomni/protocol";
import { z } from "zod";
import type { SourceDiagnostic, SourceObservation } from "./transcript";

const Fact = ChildLifecycleEvidence.pick({ child: true, turn: true, toolUseId: true, phase: true });
const Receipt = z.strictObject({
  factKey: z.string(),
  ref: ChildLifecycleEvidence.shape.ref,
  diagnostics: ChildLifecycleEvidence.shape.diagnostics,
  observedAt: z.number().int().nonnegative(),
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
  effect: z.object({ value: z.object({ content: z.string() }) }),
});

export function receivedChildRows(actions: readonly Pick<LedgerAction.Node, "kind" | "intent" | "effect">[]): ChildRow[] {
  return actions.flatMap((action) => {
    const received = ReceivedChildAction.safeParse(action);
    if (!received.success) return [];
    const row = parseJson(ChildRow, received.data.effect.value.content);
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

export function diagnosticRow(
  identity: { readonly child: string; readonly turn: string },
  diagnostic: SourceDiagnostic,
): ChildRow {
  const content = { ...identity, ...diagnostic };
  return { kind: "child_diagnostic", key: canonicalDigest(content), content };
}

/** Authority orders a batch only; every source independently admits its fact and receipt. */
export function reconcile(
  observations: readonly SourceObservation[],
  admitted: readonly ChildRow[],
  replays: readonly { readonly child: string; readonly turn: string; readonly seq: number; readonly digest: string }[] = [],
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
  for (const { evidence, observedAt } of [...observations].sort(
    (a, b) => authority[source(b.evidence.ref)] - authority[source(a.evidence.ref)],
  )) {
    const content = {
      child: evidence.child, turn: evidence.turn, phase: evidence.phase,
      ...(evidence.toolUseId === undefined ? {} : { toolUseId: evidence.toolUseId }),
    };
    const factKey = canonicalDigest(content);
    append({ kind: "child_fact", key: factKey, content });
    const key = canonicalDigest([factKey, source(evidence.ref), evidence.ref]);
    const previous = known.get(key);
    append({
      kind: "child_receipt", key,
      content: {
        factKey, ref: evidence.ref, diagnostics: evidence.diagnostics,
        // A later read is not a new observation of the same retained bytes.
        observedAt: previous?.kind === "child_receipt" ? previous.content.observedAt : observedAt,
      },
    });
  }
  for (const replay of replays) {
    const previous = stateReceipts([...known.values()], replay.child, replay.turn).find(
      (entry) => "kind" in entry.receipt.ref && entry.receipt.ref.seq === replay.seq,
    );
    const digest = previous?.receipt.diagnostics.find((entry) => entry.code === "source_sha256");
    if (previous === undefined || digest === undefined || digest.detail === replay.digest) continue;
    append(conflictRow({
      kind: "child_receipt",
      key: canonicalDigest([previous.receipt.factKey, "hook", previous.receipt.ref]),
      content: {
        ...previous.receipt,
        diagnostics: previous.receipt.diagnostics.map((entry) =>
          entry.code === "source_sha256" ? { ...entry, detail: replay.digest } : entry),
      },
    }));
  }
  return added;
}

export interface StateReceipt {
  readonly fact: z.infer<typeof Fact>;
  readonly receipt: z.infer<typeof Receipt>;
  readonly source: keyof typeof authority;
}

function receiptPosition(receipt: StateReceipt["receipt"]): number {
  return "kind" in receipt.ref ? receipt.ref.seq : receipt.observedAt;
}

/** A derived view only: no winning receipt removes or rewrites a journal row. */
export function currentState(receipts: readonly StateReceipt[]): StateReceipt | undefined {
  return receipts.reduce<StateReceipt | undefined>((current, next) => {
    if (current === undefined) return next;
    const rank = authority[next.source] - authority[current.source];
    if (rank !== 0) return rank > 0 ? next : current;
    const latest = receiptPosition(next.receipt);
    const prior = receiptPosition(current.receipt);
    if (latest !== prior) return latest > prior ? next : current;
    if ("kind" in next.receipt.ref || "kind" in current.receipt.ref) return current;
    if (canonicalJson(next.receipt.ref.generation) !== canonicalJson(current.receipt.ref.generation))
      return next;
    return next.receipt.ref.range.offsetBytes > current.receipt.ref.range.offsetBytes ? next : current;
  }, undefined);
}

/** Join persisted receipt references to their source-free facts for one child turn. */
export function stateReceipts(rows: readonly ChildRow[], child: string, turn: string): StateReceipt[] {
  const facts = new Map(rows.flatMap((row) => row.kind === "child_fact" ? [[row.key, row.content] as const] : []));
  return rows.flatMap((row) => {
    if (row.kind !== "child_receipt") return [];
    const fact = facts.get(row.content.factKey);
    return fact?.child === child && fact.turn === turn
      ? [{ fact, receipt: row.content, source: source(row.content.ref) }]
      : [];
  });
}
