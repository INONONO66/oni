import { describe, expect, it } from "bun:test";
import { canonicalDigest, emittedRowKey } from "@oni/protocol";
import { compileGateRows, type GateHandler } from "../src/core/gate/compose";
import { GateComposeError } from "../src/core/gate/points";
import {
  auditObserveGate,
  commandRewriteGate,
  countingHandler,
  fullPointTable,
  gateRow,
  guardGate,
  rewriteChain,
} from "./helpers/gate-rows";

const table = fullPointTable();

describe("gate decision fold (#1251)", () => {
  it("folds deny > require_approval > allow and records every matched row id in order", () => {
    const gate = compileGateRows({
      table,
      rows: [
        gateRow("tool.pre", { id: "a/tool.pre#1", order: 1, how: { verdict: "allow" } }),
        gateRow("tool.pre", { id: "c/tool.pre#3", order: 3, how: { verdict: "deny" } }),
        gateRow("tool.pre", { id: "b/tool.pre#2", order: 2, how: { verdict: "require_approval" } }),
      ],
      handlers: [],
      generation: 7,
    });
    const { decision } = gate.decide("tool.pre", { when: {}, value: { op: "read" } });
    expect(decision.verdict).toBe("deny");
    expect(decision.rowIds).toEqual(["a/tool.pre#1", "b/tool.pre#2", "c/tool.pre#3"]);
    expect(decision.generation).toBe(7);
  });

  it("require_approval beats allow when nothing denies", () => {
    const gate = compileGateRows({
      table,
      rows: [
        gateRow("tool.pre", { how: { verdict: "require_approval" } }),
        gateRow("tool.pre", { how: { verdict: "allow" } }),
      ],
      handlers: [],
      generation: 1,
    });
    expect(gate.decide("tool.pre", { when: {}, value: null }).decision.verdict).toBe(
      "require_approval",
    );
  });

  it("matches rows on their `when` fields only", () => {
    const gate = compileGateRows({
      table,
      rows: [gateRow("tool.pre", { when: { op: "write" }, how: { verdict: "deny" } })],
      handlers: [],
      generation: 1,
    });
    expect(gate.decide("tool.pre", { when: { op: "read" }, value: null }).decision.verdict).toBe(
      "allow",
    );
    const matched = gate.decide("tool.pre", { when: { op: "write" }, value: null }).decision;
    expect(matched.verdict).toBe("deny");
    expect(matched.rowIds).toHaveLength(1);
  });

  it("records consulted handler payloads with their digests", () => {
    const payload = { risk: "low", checked: ["path"] };
    const handler: GateHandler = () => ({ verdict: "allow", payload });
    const gate = compileGateRows({
      table,
      rows: [gateRow("tool.pre", { how: { ref: "guard/scan" } })],
      handlers: ["guard/scan"],
      generation: 1,
    });
    const { decision } = gate.decide(
      "tool.pre",
      { when: {}, value: null },
      { handlers: () => handler },
    );
    expect(decision.consulted).toEqual([
      { ref: "guard/scan", digest: canonicalDigest(payload), payload },
    ]);
  });

  it("a consulted gate always calls its declared guard - a conflicting constant cannot reach the fold (#1251 r5)", () => {
    const { handler: guard, calls } = countingHandler(() => ({ verdict: "deny", payload: { blocked: true } }));
    const gate = guardGate(table, "guard/check");
    const { decision } = gate.decide(
      "tool.pre",
      { when: {}, value: {} },
      { handlers: () => guard },
    );
    expect(calls()).toBe(1);
    expect(decision.verdict).toBe("deny");
    expect(decision.consulted.map((entry) => entry.ref)).toEqual(["guard/check"]);
    // The reviewer's r5 probe row: ref plus a constant allow. It must refuse at
    // admission - it can never compile into a decidable gate that skips the guard.
    expect(() =>
      compileGateRows({
        table,
        rows: [gateRow("tool.pre", { how: { ref: "guard/check", verdict: "allow" } })],
        handlers: ["guard/check"],
        generation: 1,
      }),
    ).toThrow(GateComposeError);
    expect(calls()).toBe(1);
  });

  it("applies rewrites in row order, each over the prior output, to declared fields only", () => {
    const { gate, handlers } = rewriteChain(table, { extra: "dropped" });
    const outcome = gate.decide(
      "llm.pre",
      { when: {}, value: { model: "base", temperature: 0.2 } },
      { handlers },
    );
    expect(outcome.value).toEqual({ model: "base+a+b", temperature: 0.2 });
    expect(outcome.decision.consulted.map((entry) => entry.payload)).toEqual([
      { step: "a" },
      { step: "b" },
    ]);
  });

  it("an observe row invokes its handler once and records an audit annotation only (#1251 r1)", () => {
    // A hostile observer: its verdict and value must be ignored.
    const { handler: observer, calls } = countingHandler(() => ({
      verdict: "deny",
      value: { input: "hijacked" },
      payload: { audit: "seen" },
    }));
    const gate = auditObserveGate(table);
    const outcome = gate.decide(
      "tool.pre",
      { when: {}, value: { input: "original" } },
      { handlers: () => observer },
    );
    expect(calls()).toBe(1);
    expect(outcome.decision.verdict).toBe("allow");
    expect(outcome.value).toEqual({ input: "original" });
    expect(outcome.decision.annotations).toEqual([
      { rowId: "audit/tool.pre#1", ref: "audit/log", payload: { audit: "seen" } },
    ]);
    expect(outcome.decision.consulted).toEqual([]);
  });

  it("an observe row whose handler is unavailable at decide time records a fact and the decision stands (#1251 r5)", () => {
    const gate = auditObserveGate(table);
    const { decision } = gate.decide(
      "tool.pre",
      { when: {}, value: { op: "read" } },
      { handlers: () => undefined },
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.annotations).toEqual([]);
    expect(decision.facts).toEqual([
      { rowId: "audit/tool.pre#1", ref: "audit/log", code: "handler_unavailable" },
    ]);
  });

  it("an observe handler's unrecorded response becomes a fact, never an annotation (#1251 r5)", () => {
    const { handler: silent, calls } = countingHandler(() => ({}));
    const gate = auditObserveGate(table);
    const { decision } = gate.decide(
      "tool.pre",
      { when: {}, value: { op: "read" } },
      { handlers: () => silent },
    );
    expect(calls()).toBe(1);
    expect(decision.verdict).toBe("allow");
    expect(decision.annotations).toEqual([]);
    expect(decision.facts).toEqual([
      { rowId: "audit/tool.pre#1", ref: "audit/log", code: "unrecorded_response" },
    ]);
  });

  it("an observer's in-place mutation of the consulted value never reaches the decision (#1251 r2)", () => {
    const hostile: GateHandler = (input) => {
      const value = input.value;
      if (value !== null && typeof value === "object" && !Array.isArray(value))
        value.input = "hijacked";
      return { payload: { seen: true } };
    };
    const gate = compileGateRows({
      table,
      rows: [
        gateRow("tool.pre", { id: "audit/tool.pre#3", do: "observe", how: { ref: "audit/mutate" } }),
      ],
      handlers: ["audit/mutate"],
      generation: 1,
    });
    const outcome = gate.decide(
      "tool.pre",
      { when: {}, value: { input: "original", nested: { keep: true } } },
      { handlers: () => hostile },
    );
    expect(outcome.value).toEqual({ input: "original", nested: { keep: true } });
    expect(outcome.decision.output).toEqual({ input: "original", nested: { keep: true } });
    expect(outcome.decision.annotations).toHaveLength(1);
  });

  it("a consult handler's in-place mutation is equally isolated from the decision value", () => {
    const hostile: GateHandler = (input) => {
      const value = input.value;
      if (value !== null && typeof value === "object" && !Array.isArray(value))
        value.input = "hijacked";
      return { verdict: "allow", payload: { ok: true } };
    };
    const gate = compileGateRows({
      table,
      rows: [gateRow("tool.pre", { how: { ref: "guard/scan" } })],
      handlers: ["guard/scan"],
      generation: 1,
    });
    const outcome = gate.decide(
      "tool.pre",
      { when: {}, value: { input: "original" } },
      { handlers: () => hostile },
    );
    expect(outcome.value).toEqual({ input: "original" });
  });

  it("an observer's ordinary throw records a fact and the decision stands (#1251 r2)", () => {
    const broken: GateHandler = () => {
      throw new Error("observer broke");
    };
    const gate = compileGateRows({
      table,
      rows: [
        gateRow("tool.pre", { id: "audit/tool.pre#4", do: "observe", how: { ref: "audit/broken" } }),
      ],
      handlers: ["audit/broken"],
      generation: 1,
    });
    const outcome = gate.decide(
      "tool.pre",
      { when: {}, value: { input: "original" } },
      { handlers: () => broken },
    );
    expect(outcome.decision.verdict).toBe("allow");
    expect(outcome.value).toEqual({ input: "original" });
    expect(outcome.decision.facts).toEqual([
      { rowId: "audit/tool.pre#4", ref: "audit/broken", code: "observer_failed" },
    ]);
  });

  it("an observer's requirement escape records a fact but never fails the decision (#1251 r1)", () => {
    const escaping: GateHandler = (input) => {
      input.service("other/secrets");
      return { payload: { reached: true } };
    };
    const gate = compileGateRows({
      table,
      rows: [
        gateRow("tool.pre", { id: "audit/tool.pre#2", do: "observe", how: { ref: "audit/escape" } }),
      ],
      handlers: ["audit/escape"],
      generation: 1,
    });
    const { decision } = gate.decide(
      "tool.pre",
      { when: {}, value: null },
      { handlers: () => escaping },
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.annotations).toEqual([]);
    expect(decision.facts).toEqual([
      { rowId: "audit/tool.pre#2", ref: "other/secrets", code: "requirement_escape" },
    ]);
  });

  it("folds obligations and journals emit rows under deterministic idempotency keys", () => {
    const gate = compileGateRows({
      table,
      rows: [
        gateRow("turn.post", { how: { verdict: "allow", metric: "continuations", limit: 8 } }),
        gateRow("compaction.pre", {
          id: "janitor/compaction.pre#1",
          do: "emit",
          how: { emit: "message", intent: { body: "compacting" } },
        }),
      ],
      handlers: [],
      generation: 1,
    });
    const post = gate.decide("turn.post", { when: {}, value: null }).decision;
    expect(post.obligations).toEqual([{ metric: "continuations", limit: 8 }]);

    const outcome = gate.decide("compaction.pre", { when: {}, value: null });
    expect(outcome.emissions).toEqual([
      {
        key: emittedRowKey(outcome.decision.inputHash, "janitor/compaction.pre#1", 0),
        kind: "message",
        rowId: "janitor/compaction.pre#1",
        intent: { body: "compacting" },
      },
    ]);
  });

  it("a consulted gate row is fail-closed: a prepared response without a verdict denies with one recorded fact (#1256 r3 H-3)", () => {
    const gate = compileGateRows({
      table,
      rows: [gateRow("prompt.pre", { id: "hooks/prompt.pre#1", how: { ref: "hook/process" } })],
      handlers: ["hook/process"],
      generation: 1,
    });
    // A rewrite-shaped hook response on a command (gate) row: value + payload,
    // no verdict. "Missing verdict => allow" is forbidden.
    const prepared = new Map([
      ["hooks/prompt.pre#1", { value: { body: "zap" }, payload: { ref: "hook/process", output: "digest" } }],
    ]);
    const outcome = gate.decide(
      "prompt.pre",
      { when: {}, value: { body: "original" } },
      { handlers: () => undefined, prepared },
    );
    expect(outcome.decision.verdict).toBe("deny");
    expect(outcome.decision.facts).toEqual([
      { rowId: "hooks/prompt.pre#1", ref: "hook/process", code: "incompatible_response" },
    ]);
    // The response IS recorded (durable evidence) but rewrites nothing: a gate
    // row allows no rewrite fields.
    expect(outcome.decision.consulted).toHaveLength(1);
    expect(outcome.value).toEqual({ body: "original" });
  });

  it("a prepared observe-row result annotates with its payload; one without a payload is an unrecorded fact", () => {
    const gate = compileGateRows({
      table,
      rows: [
        gateRow("tool.post", { id: "hooks/tool.post#1", do: "observe", how: { ref: "hook/process" } }),
        gateRow("tool.post", { id: "hooks/tool.post#2", do: "observe", how: { ref: "hook/process" } }),
      ],
      handlers: ["hook/process"],
      generation: 1,
    });
    const prepared = new Map([
      ["hooks/tool.post#1", { payload: { note: "audited" } }],
      ["hooks/tool.post#2", {}],
    ]);
    const { decision } = gate.decide(
      "tool.post",
      { when: {}, value: { op: "bash" } },
      { handlers: () => undefined, prepared },
    );
    // Audit-only either way: the verdict never moves off allow.
    expect(decision.verdict).toBe("allow");
    expect(decision.annotations).toEqual([
      { rowId: "hooks/tool.post#1", ref: "hook/process", payload: { note: "audited" } },
    ]);
    expect(decision.facts).toEqual([
      { rowId: "hooks/tool.post#2", ref: "hook/process", code: "unrecorded_response" },
    ]);
  });

  it("a prepared consultant rewrite is contained to the declared fields (#1256 r4 H-2)", () => {
    const gate = commandRewriteGate(table);
    const prepared = new Map([
      [
        "hooks/tool.pre#1",
        { value: { command: "echo masked" }, payload: { ref: "hook/process", output: "digest" } },
      ],
    ]);
    const outcome = gate.decide(
      "tool.pre",
      { when: {}, value: { command: "echo sk-123", cwd: "/tmp" } },
      { handlers: () => undefined, prepared },
    );
    expect(outcome.decision.verdict).toBe("allow");
    expect(outcome.value).toEqual({ command: "echo masked", cwd: "/tmp" });
    expect(outcome.decision.facts).toEqual([]);
    expect(outcome.decision.consulted).toHaveLength(1);
  });

  it("a prepared rewrite touching an undeclared field denies fail-closed with one incompatible_response fact (#1256 r4 H-2)", () => {
    const gate = commandRewriteGate(table);
    // The consultant answers with a field OUTSIDE the declared rewrite set.
    const prepared = new Map([
      [
        "hooks/tool.pre#1",
        { value: { command: "ok", cwd: "/etc" }, payload: { ref: "hook/process", output: "digest" } },
      ],
    ]);
    const outcome = gate.decide(
      "tool.pre",
      { when: {}, value: { command: "echo hi", cwd: "/tmp" } },
      { handlers: () => undefined, prepared },
    );
    expect(outcome.decision.verdict).toBe("deny");
    expect(outcome.decision.facts).toEqual([
      { rowId: "hooks/tool.pre#1", ref: "hook/process", code: "incompatible_response" },
    ]);
    // Nothing of the contained response reaches the value.
    expect(outcome.value).toEqual({ command: "echo hi", cwd: "/tmp" });
  });

  it("a verdict-shaped consultant reply on a rewrite row is incompatible, never applied (#1256 r4 H-2)", () => {
    const gate = commandRewriteGate(table);
    const prepared = new Map([
      ["hooks/tool.pre#1", { verdict: "allow" as const, payload: { ref: "hook/process", verdict: "allow" } }],
    ]);
    const outcome = gate.decide(
      "tool.pre",
      { when: {}, value: { command: "echo hi" } },
      { handlers: () => undefined, prepared },
    );
    expect(outcome.decision.verdict).toBe("deny");
    expect(outcome.decision.facts).toEqual([
      { rowId: "hooks/tool.pre#1", ref: "hook/process", code: "incompatible_response" },
    ]);
    expect(outcome.value).toEqual({ command: "echo hi" });
  });

  it("a sync gate handler answering without a verdict is equally fail-closed", () => {
    const handler: GateHandler = () => ({ payload: { note: "observed" } });
    const gate = compileGateRows({
      table,
      rows: [gateRow("tool.pre", { id: "probe/tool.pre#1", how: { ref: "guard/mute" } })],
      handlers: ["guard/mute"],
      generation: 1,
    });
    const { decision } = gate.decide(
      "tool.pre",
      { when: {}, value: { op: "read" } },
      { handlers: () => handler },
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.facts).toEqual([
      { rowId: "probe/tool.pre#1", ref: "guard/mute", code: "incompatible_response" },
    ]);
  });
});
