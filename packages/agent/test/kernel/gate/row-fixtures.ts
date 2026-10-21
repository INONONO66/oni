import { openCatalogStore } from "../../../src/core/store/catalog";
import type { PlainValue, PolicyRow, Storage } from "@oni/protocol";

export function withPolicyRows<A>(run: (source: Storage.PolicyRowSubAdapter) => A): A {
  const catalog = openCatalogStore(":memory:", { now: () => 1_700_000_000_000 });
  try {
    return run(catalog.policies);
  } finally {
    catalog.close();
  }
}

export type PolicyRowDraft = Omit<PolicyRow.Row, "generation">;

export function draft(
  name: string,
  kind: string,
  phase: PolicyRow.Phase,
  verdict: PlainValue,
  options: {
    readonly match?: PlainValue;
    readonly priority?: number;
  } = {},
): PolicyRowDraft {
  return {
    name,
    kind,
    phase,
    match: { encodingVersion: 1, value: options.match ?? {} },
    verdict: { encodingVersion: 1, value: verdict },
    priority: options.priority ?? 0,
  };
}

export function atGeneration(row: PolicyRowDraft, generation: number): PolicyRow.Row {
  return { ...row, generation };
}

export class MemoryPolicyRows implements Pick<Storage.PolicyRowSubAdapter, "append" | "rows"> {
  readonly stored: PolicyRow.Row[];
  reads = 0;

  constructor(rows: readonly PolicyRow.Row[] = []) {
    this.stored = [...rows];
  }

  append(row: PolicyRow.Row): boolean {
    const duplicate = this.stored.some(
      (candidate) =>
        candidate.generation === row.generation &&
        candidate.name === row.name &&
        candidate.kind === row.kind &&
        candidate.phase === row.phase,
    );
    if (duplicate) return false;
    this.stored.push(row);
    return true;
  }

  rows(generation?: number): PolicyRow.Row[] {
    this.reads += 1;
    return this.stored.filter((row) => generation === undefined || row.generation === generation);
  }
}

export function unrelatedRows(count: number): PolicyRow.Row[] {
  return Array.from({ length: count } as ArrayLike<undefined>, (_, index) =>
    atGeneration(
      draft(`unrelated-${index}`, index % 2 === 0 ? "llm" : "prompt", "pre", {
        type: "allow",
      }),
      1,
    ),
  );
}

export const compaction = draft(
  "compaction",
  "turn",
  "post",
  { type: "allow" },
  { match: { op: "compaction" }, priority: 1_000 },
);
