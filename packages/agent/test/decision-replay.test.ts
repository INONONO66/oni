import { describe, expect, it } from "bun:test";
import type { PolicyRow } from "@oni/protocol";
import { compileGateRows, type GateHandler } from "../src/core/gate/compose";
import {
  compilePolicySnapshot,
  createHandlerTable,
  KERNEL_POLICY_REGISTRY,
} from "../src/core/gate/compile";
import { countingHandler, fullPointTable, gateRow, guardGate, rewriteChain } from "./helpers/gate-rows";

const table = fullPointTable();

describe("decision replay (#1251)", () => {
  it("replays a recorded decision for the same input hash without re-running handlers", () => {
    const { handler, calls } = countingHandler((call) => ({ verdict: "require_approval", payload: { call } }));
    const gate = guardGate(table, "guard/count");
    const input = { when: { op: "write" }, value: { path: "/etc" } };
    const first = gate.decide("tool.pre", input, { handlers: () => handler });
    expect(first.replayed).toBe(false);
    expect(calls()).toBe(1);

    const replay = gate.decide("tool.pre", input, {
      handlers: () => handler,
      recorded: first.decision,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.decision).toEqual(first.decision);
    expect(replay.emissions).toEqual([]);
    expect(calls()).toBe(1);
  });

  it("replay restores the recorded rewrite output without re-running the rewriter (#1251 r1)", () => {
    const { handler: rewriter, calls } = countingHandler(() => ({
      value: { model: "safe-model" },
      payload: { rewrote: true },
    }));
    const gate = compileGateRows({
      table,
      rows: [gateRow("llm.pre", { do: "rewrite", how: { ref: "rewrite/model", fields: ["model"] } })],
      handlers: ["rewrite/model"],
      generation: 1,
    });
    const input = { when: {}, value: { model: "raw", temperature: 1 } };
    const first = gate.decide("llm.pre", input, { handlers: () => rewriter });
    expect(first.value).toEqual({ model: "safe-model", temperature: 1 });
    expect(first.decision.output).toEqual({ model: "safe-model", temperature: 1 });
    expect(calls()).toBe(1);

    // Replay has no handler available at all: the recorded output must carry.
    const replay = gate.decide("llm.pre", input, {
      handlers: () => undefined,
      recorded: first.decision,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.value).toEqual({ model: "safe-model", temperature: 1 });
    expect(calls()).toBe(1);
  });

  it("replay of chained rewrites restores the final folded value and untouched fields (#1251 r1)", () => {
    const { gate, handlers } = rewriteChain(table);
    const input = { when: {}, value: { model: "base", temperature: 0.2 } };
    const first = gate.decide("llm.pre", input, { handlers });
    expect(first.value).toEqual({ model: "base+a+b", temperature: 0.2 });

    const replay = gate.decide("llm.pre", input, {
      handlers: () => undefined,
      recorded: first.decision,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.value).toEqual({ model: "base+a+b", temperature: 0.2 });
    expect(replay.decision).toEqual(first.decision);
  });

  it("re-decides when the input hash differs from the recorded decision", () => {
    const { handler, calls } = countingHandler((call) => ({ verdict: "allow", payload: { call } }));
    const gate = guardGate(table, "guard/count");
    const first = gate.decide("tool.pre", { when: {}, value: { path: "/a" } }, { handlers: () => handler });
    const second = gate.decide(
      "tool.pre",
      { when: {}, value: { path: "/b" } },
      { handlers: () => handler, recorded: first.decision },
    );
    expect(second.replayed).toBe(false);
    expect(second.decision.inputHash).not.toBe(first.decision.inputHash);
    expect(calls()).toBe(2);
  });

  it("a changed matcher context is a different decision: the old record does not replay (#1251 r3)", () => {
    const gate = compileGateRows<{ block: boolean }>({
      table,
      rows: [gateRow("message.pre", { id: "guard/message.pre#7", how: { verdict: "deny" } })],
      handlers: [],
      generation: 1,
      matchers: new Map([["guard/message.pre#7", (context) => context?.block === true]]),
    });
    const first = gate.decide("message.pre", { when: {}, value: { text: "hi" }, context: { block: false } });
    expect(first.decision.verdict).toBe("allow");

    // Identical context: the recorded decision replays verbatim.
    const same = gate.decide(
      "message.pre",
      { when: {}, value: { text: "hi" }, context: { block: false } },
      { recorded: first.decision },
    );
    expect(same.replayed).toBe(true);
    expect(same.decision.verdict).toBe("allow");

    // Changed context flips the matcher: the old allow must not replay.
    const changed = gate.decide(
      "message.pre",
      { when: {}, value: { text: "hi" }, context: { block: true } },
      { recorded: first.decision },
    );
    expect(changed.replayed).toBe(false);
    expect(changed.decision.verdict).toBe("deny");
    expect(changed.decision.rowIds).toEqual(["guard/message.pre#7"]);
  });

  it("a decision recorded under another generation never replays (#1251 r4)", () => {
    const recordedBy = compileGateRows({
      table,
      rows: [gateRow("tool.pre", { id: "guard/tool.pre#1", how: { verdict: "allow" } })],
      handlers: [],
      generation: 1,
    });
    const first = recordedBy.decide("tool.pre", { when: {}, value: { text: "hi" } });
    expect(first.decision.generation).toBe(1);

    // Generation 2 adds a deny on the same point; the gen-1 allow is void.
    const gate = compileGateRows({
      table,
      rows: [
        gateRow("tool.pre", { id: "guard/tool.pre#1", how: { verdict: "allow" } }),
        gateRow("tool.pre", { id: "guard/tool.pre#2", how: { verdict: "deny" }, order: 2 }),
      ],
      handlers: [],
      generation: 2,
    });
    const outcome = gate.decide("tool.pre", { when: {}, value: { text: "hi" } }, { recorded: first.decision });
    expect(outcome.replayed).toBe(false);
    expect(outcome.decision.verdict).toBe("deny");
    expect(outcome.decision.generation).toBe(2);
  });

  it("treats an unrecorded handler response as observe-only: it cannot change the decision", () => {
    const silent: GateHandler = () => ({ verdict: "deny" });
    const gate = compileGateRows({
      table,
      rows: [gateRow("tool.pre", { id: "guard/tool.pre#9", how: { ref: "guard/silent" } })],
      handlers: ["guard/silent"],
      generation: 1,
    });
    const { decision } = gate.decide(
      "tool.pre",
      { when: {}, value: null },
      { handlers: () => silent },
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.consulted).toEqual([]);
    expect(decision.facts).toEqual([
      { rowId: "guard/tool.pre#9", ref: "guard/silent", code: "unrecorded_response" },
    ]);
  });
});

describe("production snapshot replay (#1251 r3)", () => {
  const rows = (generation: number): PolicyRow.Row[] => [
    { name: "compaction", kind: "compaction", phase: "pre" as const, generation, priority: 1_000,
      match: { encodingVersion: 1 as const, value: {} },
      verdict: { encodingVersion: 1 as const, value: { type: "allow" } } },
    { name: "mask", kind: "tool", phase: "pre" as const, generation, priority: 1,
      match: { encodingVersion: 1 as const, value: { op: "write" } },
      verdict: { encodingVersion: 1 as const,
        value: { type: "transform", ref: "demo/mask", config: { fields: ["text"] } } } },
  ];
  const input = { kind: "tool", phase: "pre" as const, op: "write", value: { text: "original" } };

  it("the evaluation carries the replayable gate decision with its consulted responses", () => {
    let calls = 0;
    const registry = createHandlerTable({ ...KERNEL_POLICY_REGISTRY, transformers: [
      ...KERNEL_POLICY_REGISTRY.transformers,
      { name: "demo/mask", apply: () => { calls += 1; return { text: "masked" }; } },
    ] });
    const snapshot = compilePolicySnapshot({ registry, generation: 1, rows: rows(1) });
    const first = snapshot.evaluate(input);
    expect(calls).toBe(1);
    expect(first.value).toEqual({ text: "masked" });
    expect(first.gate).toMatchObject({
      output: { text: "masked" },
      consulted: [{ ref: "demo/mask", digest: expect.any(String) }],
    });

    // Same input plus the recorded decision: the gate replays it verbatim
    // without invoking the handler again.
    const replayed = snapshot.evaluate({ ...input, recorded: first.gate });
    expect(replayed.replayed).toBe(true);
    expect(replayed.value).toEqual({ text: "masked" });
    expect(replayed.inputHash).toBe(first.inputHash);
    expect(calls).toBe(1);
  });

  it("replays a recorded decision even when the handler can no longer run", () => {
    const working = createHandlerTable({ ...KERNEL_POLICY_REGISTRY, transformers: [
      ...KERNEL_POLICY_REGISTRY.transformers,
      { name: "demo/mask", apply: () => ({ text: "masked" }) },
    ] });
    const recordedBy = compilePolicySnapshot({ registry: working, generation: 1, rows: rows(1) });
    const first = recordedBy.evaluate(input);

    const broken = createHandlerTable({ ...KERNEL_POLICY_REGISTRY, transformers: [
      ...KERNEL_POLICY_REGISTRY.transformers,
      { name: "demo/mask", apply: () => { throw new Error("handler must not run during replay"); } },
    ] });
    const snapshot = compilePolicySnapshot({ registry: broken, generation: 1, rows: rows(1) });
    const replayed = snapshot.evaluate({ ...input, recorded: first.gate });
    expect(replayed.replayed).toBe(true);
    expect(replayed.value).toEqual({ text: "masked" });

    // A different input never replays the stale record: the broken handler
    // surfaces instead of the recorded output.
    expect(() => snapshot.evaluate({ ...input, value: { text: "changed" }, recorded: first.gate }))
      .toThrow("handler must not run during replay");
  });

  it("a decision is bound to its policy generation: a gen-1 allow never replays under gen-2 (#1251 r4)", () => {
    const registry = createHandlerTable(KERNEL_POLICY_REGISTRY);
    const allowRows = (generation: number): PolicyRow.Row[] => [
      { name: "compaction", kind: "compaction", phase: "pre", generation, priority: 1_000,
        match: { encodingVersion: 1, value: {} },
        verdict: { encodingVersion: 1, value: { type: "allow" } } },
    ];
    const generationOne = compilePolicySnapshot({ registry, generation: 1, rows: allowRows(1) });
    const first = generationOne.evaluate(input);
    expect(first.verdict).toBe("allow");

    // Generation 2 introduces a deny for the same input.
    const generationTwo = compilePolicySnapshot({ registry, generation: 2, rows: [
      ...allowRows(2),
      { name: "freeze-writes", kind: "tool", phase: "pre", generation: 2, priority: 1,
        match: { encodingVersion: 1, value: { op: "write" } },
        verdict: { encodingVersion: 1, value: { type: "deny", reason: "frozen" } } },
    ] });
    expect(generationTwo.evaluate(input).verdict).toBe("deny");

    // The gen-1 record must not resurrect the allow under the gen-2 snapshot.
    const replayed = generationTwo.evaluate({ ...input, recorded: first.gate });
    expect(replayed.replayed).toBe(false);
    expect(replayed.verdict).toBe("deny");
    expect(replayed.generation).toBe(2);
  });
});
