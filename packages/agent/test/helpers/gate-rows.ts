import type { GateHandler, GatePointTable, PointRows, PointInput, EvaluationOptions } from "../../src/core/gate/types";
import { composePointTable, KERNEL_CAPABILITY_POINTS, compile } from "../../src/core/gate/compile";
import { evaluate } from "../../src/core/gate/evaluate";
export function gateSnapshot<Context = never>({ handlers, ...source }: Omit<PointRows<Context>, "pointRows"> & { readonly handlers: readonly string[] }) {
  const snapshot = compile({ ...source, pointRows: true }, { transformers: [], obligations: handlers.map((name) => ({ name })) });
  return { generation: snapshot.generation,
    rowsAt: (point: PointId) => (snapshot.byPoint.get(point) ?? []).map((entry) => entry.row),
    decide: (point: PointId, input: Omit<PointInput<Context>, "point">, options?: EvaluationOptions) => evaluate(snapshot, { point, ...input }, options),
  };
}

import type { GateRow, PlainValue, PointId } from "@oni/protocol";

/** The fully composed table: eight core points plus the four built-in capabilities. */
export function fullPointTable(): GatePointTable {
  return composePointTable({ capabilities: KERNEL_CAPABILITY_POINTS });
}

let sequence = 0;

export function gateRow(on: PointId, overrides: Partial<GateRow> = {}): GateRow {
  sequence += 1;
  return {
    id: `fixture/${on}#${sequence}`,
    on,
    when: {},
    do: "gate",
    how: { verdict: "allow" },
    order: sequence,
    generation: 1,
    ...overrides,
  };
}

/** The `model` string of a plain object value, else `""` (the rewrite probes read it). */
function plainModel(value: PlainValue): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "";
  const model = value.model;
  return typeof model === "string" ? model : "";
}

/** A handler that counts its invocations and answers `reply` each time (`reply` may read the running count). */
export function countingHandler(reply: (calls: number) => ReturnType<GateHandler>) {
  let calls = 0;
  const handler: GateHandler = () => {
    calls += 1;
    return reply(calls);
  };
  return { handler, calls: () => calls };
}

/** One guard row on `point` consulting `ref`, compiled at `generation`. */
export function guardGate(table: GatePointTable, ref: string, point: PointId = "tool.pre", generation = 1) {
  return gateSnapshot({ table, rows: [gateRow(point, { how: { ref } })], handlers: [ref], generation });
}

/** The single `audit/tool.pre#1` observe row consulting `audit/log`. */
export function auditObserveGate(table: GatePointTable) {
  return gateSnapshot({
    table,
    rows: [gateRow("tool.pre", { id: "audit/tool.pre#1", do: "observe", how: { ref: "audit/log" } })],
    handlers: ["audit/log"],
    generation: 1,
  });
}

/** The single `hooks/tool.pre#1` rewrite row over `command`, consulting `hook/process`. */
export function commandRewriteGate(table: GatePointTable) {
  return gateSnapshot({
    table,
    rows: [
      gateRow("tool.pre", {
        id: "hooks/tool.pre#1",
        do: "rewrite",
        how: { ref: "hook/process", fields: ["command"] },
      }),
    ],
    handlers: ["hook/process"],
    generation: 1,
  });
}

/**
 * Two ordered `llm.pre` rewrite rows over `model`: `rewrite/upgrade` appends
 * `+a` (plus `extra` fields, to prove undeclared output is dropped) and
 * `rewrite/suffix` appends `+b`.
 */
export function rewriteChain(table: GatePointTable, extra: Record<string, PlainValue> = {}) {
  const upgrade: GateHandler = (input) => ({
    value: { model: `${plainModel(input.value)}+a`, ...extra },
    payload: { step: "a" },
  });
  const suffix: GateHandler = (input) => ({
    value: { model: `${plainModel(input.value)}+b` },
    payload: { step: "b" },
  });
  const handlers = new Map<string, GateHandler>([
    ["rewrite/upgrade", upgrade],
    ["rewrite/suffix", suffix],
  ]);
  const gate = gateSnapshot({
    table,
    rows: [
      gateRow("llm.pre", { order: 1, do: "rewrite", how: { ref: "rewrite/upgrade", fields: ["model"] } }),
      gateRow("llm.pre", { order: 2, do: "rewrite", how: { ref: "rewrite/suffix", fields: ["model"] } }),
    ],
    handlers: [...handlers.keys()],
    generation: 1,
  });
  return { gate, handlers: (ref: string) => handlers.get(ref) };
}
