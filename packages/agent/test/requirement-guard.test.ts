import { describe, expect, it } from "bun:test";
import { compileGateRows, type GateHandler } from "../src/core/gate/compose";
import { fullPointTable, gateRow } from "./helpers/gate-rows";

const table = fullPointTable();

/** Compiles the single tool.pre `row` over `handlers` (generation 1) and decides a null tool.pre value. */
function decideToolPre(row: Parameters<typeof gateRow>[1], handlers: ReadonlyMap<string, GateHandler>) {
  const gate = compileGateRows({
    table,
    rows: [gateRow("tool.pre", row)],
    handlers: [...handlers.keys()],
    generation: 1,
  });
  return gate.decide("tool.pre", { when: {}, value: null }, { handlers: (ref) => handlers.get(ref) }).decision;
}

describe("requirement guard (#1251)", () => {
  it("resolves a separately declared dependency from the row's requires collection (#1251 r2)", () => {
    const helper: GateHandler = () => ({ payload: { risk: "low" } });
    const main: GateHandler = (input) => {
      const scan = input.service("guard/helper")(input);
      return { verdict: "allow", payload: { via: "guard/helper", scan: scan.payload ?? null } };
    };
    const handlers = new Map<string, GateHandler>([
      ["guard/main", main],
      ["guard/helper", helper],
    ]);
    const decision = decideToolPre({ how: { ref: "guard/main", requires: ["guard/helper"] } }, handlers);
    expect(decision.verdict).toBe("allow");
    expect(decision.facts).toEqual([]);
    expect(decision.consulted.map((entry) => entry.payload)).toEqual([
      { via: "guard/helper", scan: { risk: "low" } },
    ]);
  });

  it("a reference outside the declared requires escapes even when other requires exist", () => {
    const main: GateHandler = (input) => {
      input.service("other/secrets");
      return { verdict: "allow", payload: { reached: true } };
    };
    const handlers = new Map<string, GateHandler>([
      ["guard/main", main],
      ["guard/helper", () => ({ payload: {} })],
      ["other/secrets", () => ({ payload: { leaked: true } })],
    ]);
    const decision = decideToolPre(
      { id: "guard/tool.pre#9", how: { ref: "guard/main", requires: ["guard/helper"] } },
      handlers,
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.facts).toEqual([
      { rowId: "guard/tool.pre#9", ref: "other/secrets", code: "requirement_escape" },
    ]);
  });

  it("records a dynamic reference escaping the declared requires as a fact and fails closed", () => {
    const escaping: GateHandler = (input) => {
      input.service("other/secrets");
      return { verdict: "allow", payload: { reached: true } };
    };
    const other: GateHandler = () => ({ verdict: "allow", payload: { leaked: true } });
    const handlers = new Map<string, GateHandler>([
      ["guard/escaping", escaping],
      ["other/secrets", other],
    ]);
    const decision = decideToolPre({ id: "guard/tool.pre#1", how: { ref: "guard/escaping" } }, handlers);
    expect(decision.verdict).toBe("deny");
    expect(decision.facts).toEqual([
      { rowId: "guard/tool.pre#1", ref: "other/secrets", code: "requirement_escape" },
    ]);
    // The escaping handler's own response never lands: nothing was consulted.
    expect(decision.consulted).toEqual([]);
  });

  it("fails closed when a row's handler is not resolvable at decision time", () => {
    const gate = compileGateRows({
      table,
      rows: [gateRow("tool.pre", { id: "guard/tool.pre#2", how: { ref: "guard/gone" } })],
      handlers: ["guard/gone"],
      generation: 1,
    });
    const { decision } = gate.decide("tool.pre", { when: {}, value: null }, { handlers: () => undefined });
    expect(decision.verdict).toBe("deny");
    expect(decision.facts).toEqual([
      { rowId: "guard/tool.pre#2", ref: "guard/gone", code: "handler_unavailable" },
    ]);
  });
});
