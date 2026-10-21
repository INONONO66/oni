import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { canonicalDigest, type PlainValue, RowVerdict, RowVerdictRead, PolicyRow, type Storage } from "@oni/protocol";
import { compilePolicySnapshot, createHandlerTable, KERNEL_POLICY_REGISTRY, HandlerTableError, SEEDED_POLICY_ROWS, type ConsultInput } from "../../../src/core/gate/compile";
import { atGeneration, compaction, draft, withPolicyRows, type PolicyRowDraft } from "./row-fixtures";
import { runTestPromise } from "../../helpers/isolated";
import type { GateHandlerResult } from "../../../src/core/gate/compose";

const input = {
  kind: "tool",
  phase: "pre",
  op: "bash",
  value: { secret: "original", keep: true },
} as const;

describe("immutable named policy registry", () => {
  test("transactional derivation emits refs while retaining historical generation bytes", () => withPolicyRows((source: Storage.PolicyRowSubAdapter) => {
    source.appendGeneration(() => [
      atGeneration(compaction, 1),
      atGeneration(
        draft("redact", "tool", "pre", { type: "transform", name: "redact", paths: ["secret"] }),
        1,
      ),
    ]);
    const bytes = JSON.stringify(source.rows(1));
    const before = compilePolicySnapshot({ rows: source.rows(1), generation: 1, registry: KERNEL_POLICY_REGISTRY });
    const generation = source.appendGeneration((current: readonly PolicyRow.Row[]) => current.map((row: PolicyRow.Row) => ({
      ...row, verdict: { ...row.verdict, value: RowVerdictRead.parse(row.verdict.value) },
    })));
    expect(generation).toBe(2);
    expect(source.rows(2).find((row: PolicyRow.Row) => row.name === "redact")?.verdict.value).toEqual({
      type: "transform",
      ref: "kernel/redact",
      config: { paths: ["secret"] },
    });
    expect(JSON.stringify(source.rows(1))).toBe(bytes);
    const after = compilePolicySnapshot({ rows: source.rows(2), generation: 2, registry: KERNEL_POLICY_REGISTRY });
    expect(after.evaluate(input).value).toEqual(before.evaluate(input).value);
    expect(after.contentHash).not.toBe(before.contentHash);
  }));

  test.each([
    "transform",
    "obligation",
    // An unregistered CONSULT ref refuses the generation too.
    "consult",
  ] as const)("missing %s refs fail typed before execution", (type: "transform" | "obligation" | "consult") => {
    const verdict: PlainValue =
      type === "obligation"
        ? { type, ref: "demo/missing", metric: "fanout", limit: 2 }
        : { type, ref: "demo/missing" };
    expect(() =>
      compilePolicySnapshot({
        generation: 7,
        registry: KERNEL_POLICY_REGISTRY,
        rows: [
          atGeneration(compaction, 7),
          atGeneration(draft("missing", "tool", "pre", verdict), 7),
        ],
      }),
    ).toThrow(expect.objectContaining({
      data: expect.objectContaining({
        code: "unknown_ref",
        generation: 7,
        ruleName: "missing",
        ref: "demo/missing",
      }),
    }));
  });

  test("a consult{rewrite} row projects the consulted rewrite: evaluateEffect applies the consultant's fields (#1256 r4 H-2)", async () => {
    const registry = {
      ...KERNEL_POLICY_REGISTRY,
      consultants: [
        {
          name: "hook/process",
          consult: () =>
            Effect.succeed({
              value: { secret: "masked" },
              payload: { ref: "hook/process", output: "digest" },
            }),
        },
      ],
    };
    const snapshot = compilePolicySnapshot({
      generation: 7,
      registry,
      rows: [
        atGeneration(compaction, 7),
        atGeneration(
          draft("mask", "tool", "pre", {
            type: "consult",
            ref: "hook/process",
            rewrite: true,
            config: { event: "PreToolUse", fields: ["secret"] },
          }),
          7,
        ),
      ],
    });
    if (snapshot.evaluateEffect === undefined) throw new Error("effectful evaluation missing");
    const evaluation = await runTestPromise(snapshot.evaluateEffect(input));
    // The executor-bound value carries the consultant's rewrite of ONLY the
    // declared field; the untouched field survives.
    expect(evaluation.verdict).toBe("allow");
    expect(evaluation.value).toEqual({ secret: "masked", keep: true });
    expect(evaluation.gate?.consulted.map((entry) => entry.ref)).toEqual(["hook/process"]);
    // The SYNC path has no prepared consultant result: fail-closed deny.
    expect(snapshot.evaluate(input).verdict).toBe("deny");
    expect(snapshot.evaluate(input).reason).toBe("handler_unavailable");
    // Without the rewrite flag the same ref projects the plain consulted
    // GATE row: the consultant's payload is recorded, the value untouched.
    const gateRegistry = {
      ...KERNEL_POLICY_REGISTRY,
      consultants: [
        {
          name: "hook/process",
          consult: () =>
            Effect.succeed({ verdict: "allow" as const, payload: { ref: "hook/process" } }),
        },
      ],
    };
    const gated = compilePolicySnapshot({
      generation: 8,
      registry: gateRegistry,
      rows: [
        atGeneration(compaction, 8),
        atGeneration(
          draft("gate", "tool", "pre", {
            type: "consult",
            ref: "hook/process",
            config: { event: "PreToolUse" },
          }),
          8,
        ),
      ],
    });
    if (gated.evaluateEffect === undefined) throw new Error("effectful evaluation missing");
    const gateEvaluation = await runTestPromise(gated.evaluateEffect(input));
    expect(gateEvaluation.verdict).toBe("allow");
    expect(gateEvaluation.value).toEqual(input.value);
  });

  test("a sync guard reads `when` beside an async consultant on the same point: both evaluate and the evaluateEffect probe fold carry the real when (#1258)", async () => {
    const registry = {
      ...KERNEL_POLICY_REGISTRY,
      consultants: [
        {
          name: "hook/process",
          consult: () =>
            Effect.succeed({ verdict: "allow" as const, payload: { ref: "hook/process" } }),
        },
      ],
      guards: [
        {
          name: "demo/op-guard",
          decide: ({ when }: { when: Readonly<Record<string, PlainValue>> }): GateHandlerResult => {
            const verdict = when.op === "bash" ? ("deny" as const) : ("allow" as const);
            return { verdict, payload: { decided: verdict, op: when.op ?? null } };
          },
        },
      ],
    };
    const snapshot = compilePolicySnapshot({
      generation: 9,
      registry,
      rows: [
        atGeneration(compaction, 9),
        atGeneration(draft("async-gate", "tool", "pre", { type: "consult", ref: "hook/process" }), 9),
        atGeneration(draft("sync-guard", "tool", "pre", { type: "consult", ref: "demo/op-guard" }), 9),
      ],
    });
    if (snapshot.evaluateEffect === undefined) throw new Error("effectful evaluation missing");
    // Probe path: the guard folds inline while the consultant is
    // awaited; with the REAL when (op=bash) it denies. Dropping `when` on the
    // probe path would fold allow+allow here and break this assertion.
    const denied = await runTestPromise(snapshot.evaluateEffect(input));
    expect(denied.verdict).toBe("deny");
    expect(denied.gate?.consulted.find((entry) => entry.ref === "demo/op-guard")?.payload).toEqual({
      decided: "deny",
      op: "bash",
    });
    const allowed = await runTestPromise(snapshot.evaluateEffect({ ...input, op: "ls" }));
    expect(allowed.verdict).toBe("allow");
    expect(allowed.gate?.consulted.find((entry) => entry.ref === "demo/op-guard")?.payload).toEqual({
      decided: "allow",
      op: "ls",
    });
    // Sync path: the un-prepared async consult row fail-closes to deny either
    // way, but the guard's recorded payload proves `evaluate` handed the real
    // when to the sync handler too.
    const sync = snapshot.evaluate(input);
    expect(sync.verdict).toBe("deny");
    expect(sync.gate?.consulted.find((entry) => entry.ref === "demo/op-guard")?.payload).toEqual({
      decided: "deny",
      op: "bash",
    });
    expect(
      snapshot.evaluate({ ...input, op: "ls" }).gate?.consulted.find((entry) => entry.ref === "demo/op-guard")?.payload,
    ).toEqual({ decided: "allow", op: "ls" });
  });

  test("consult{rewrite} misdeclarations refuse the generation: observe+rewrite and missing fields (#1256 r4 H-2)", () => {
    const registry = {
      ...KERNEL_POLICY_REGISTRY,
      consultants: [
        { name: "hook/process", consult: () => Effect.succeed({ payload: null }) },
      ],
    };
    const compile = (verdict: PlainValue) =>
      compilePolicySnapshot({
        generation: 7,
        registry,
        rows: [atGeneration(compaction, 7), atGeneration(draft("bad", "tool", "pre", verdict), 7)],
      });
    expect(() =>
      compile({ type: "consult", ref: "hook/process", rewrite: true, observe: true, config: { fields: ["secret"] } }),
    ).toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ code: "compose_rejected", composeCode: "bad_action" }),
      }),
    );
    expect(() =>
      compile({ type: "consult", ref: "hook/process", rewrite: true, config: { event: "PreToolUse" } }),
    ).toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ code: "compose_rejected", composeCode: "bad_field" }),
      }),
    );
  });

  test("a later async guard receives the earlier async rewrite's value, and the deny reaches the executor (#1256 r5 H-1)", async () => {
    const guardSaw: PlainValue[] = [];
    const registry = {
      ...KERNEL_POLICY_REGISTRY,
      consultants: [
        {
          name: "demo/rewriter",
          consult: () =>
            Effect.succeed({
              value: { command: "forbidden" },
              payload: { ref: "demo/rewriter", output: "digest" },
            }),
        },
        {
          name: "demo/guard",
          consult: (consultInput: ConsultInput) =>
            Effect.sync((): GateHandlerResult => {
              guardSaw.push(consultInput.value);
              const command =
                consultInput.value !== null &&
                typeof consultInput.value === "object" &&
                !Array.isArray(consultInput.value)
                  ? consultInput.value.command
                  : undefined;
              return command === "forbidden"
                ? { verdict: "deny" as const, payload: { ref: "demo/guard", reason: "forbidden_command" } }
                : { verdict: "allow" as const, payload: { ref: "demo/guard" } };
            }),
        },
      ],
    };
    const snapshot = compilePolicySnapshot({
      generation: 9,
      registry,
      rows: [
        atGeneration(compaction, 9),
        atGeneration(
          draft(
            "rewrite-first",
            "tool",
            "pre",
            { type: "consult", ref: "demo/rewriter", rewrite: true, config: { event: "PreToolUse", fields: ["command"] } },
            { priority: 20 },
          ),
          9,
        ),
        atGeneration(
          draft(
            "guard-second",
            "tool",
            "pre",
            { type: "consult", ref: "demo/guard", config: { event: "PreToolUse" } },
            { priority: 10 },
          ),
          9,
        ),
      ],
    });
    if (snapshot.evaluateEffect === undefined) throw new Error("effectful evaluation missing");
    const guarded = { kind: "tool", phase: "pre", op: "bash", value: { command: "safe" } } as const;
    const evaluation = await runTestPromise(snapshot.evaluateEffect(guarded));
    // The r4 reviewer reproduction: the guard MUST judge the rewritten value,
    // so the forbidden rewrite is denied before it reaches the executor.
    expect(guardSaw).toEqual([{ command: "forbidden" }]);
    expect(evaluation.verdict).toBe("deny");
    expect(evaluation.reason).toBe("forbidden_command");
    // Replay identity is the INPUT's, untouched by the ordered consultation.
    expect(evaluation.inputHash).toBe(snapshot.evaluate(guarded).inputHash);
  });

  test("mixed sync/async rows fold in one ordered pipeline: every consultant sees its position's value (#1256 r5 H-1)", async () => {
    const seen: Record<string, PlainValue[]> = { mark: [], guard: [] };
    const commandOf = (value: PlainValue): string => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("record expected");
      if (typeof value.command !== "string") throw new Error("command expected");
      return value.command;
    };
    const registry = createHandlerTable({
      transformers: [
        {
          name: "demo/stamp",
          apply: (args: PlainValue, config: PlainValue): PlainValue => {
            const tag =
              config !== null && typeof config === "object" && !Array.isArray(config) && typeof config.tag === "string"
                ? config.tag
                : "?";
            return { command: `${commandOf(args)}.${tag}` };
          },
        },
      ],
      obligations: [],
      consultants: [
        {
          name: "demo/mark",
          consult: (consultInput: ConsultInput) =>
            Effect.sync(() => {
              seen.mark?.push(consultInput.value);
              return {
                value: { command: `${commandOf(consultInput.value)}.h1` },
                payload: { ref: "demo/mark", output: "digest" },
              };
            }),
        },
        {
          name: "demo/guard",
          consult: (consultInput: ConsultInput) =>
            Effect.sync(() => {
              seen.guard?.push(consultInput.value);
              return { verdict: "allow" as const, payload: { ref: "demo/guard" } };
            }),
        },
      ],
    });
    const snapshot = compilePolicySnapshot({
      generation: 10,
      registry,
      rows: [
        atGeneration(compaction, 10),
        atGeneration(
          draft("s1", "tool", "pre", { type: "transform", ref: "demo/stamp", config: { fields: ["command"], tag: "s1" } }, { priority: 40 }),
          10,
        ),
        atGeneration(
          draft(
            "h1",
            "tool",
            "pre",
            { type: "consult", ref: "demo/mark", rewrite: true, config: { event: "PreToolUse", fields: ["command"] } },
            { priority: 30 },
          ),
          10,
        ),
        atGeneration(
          draft("s2", "tool", "pre", { type: "transform", ref: "demo/stamp", config: { fields: ["command"], tag: "s2" } }, { priority: 20 }),
          10,
        ),
        atGeneration(
          draft("g", "tool", "pre", { type: "consult", ref: "demo/guard", config: { event: "PreToolUse" } }, { priority: 10 }),
          10,
        ),
      ],
    });
    if (snapshot.evaluateEffect === undefined) throw new Error("effectful evaluation missing");
    const evaluation = await runTestPromise(
      snapshot.evaluateEffect({ kind: "tool", phase: "pre", op: "bash", value: { command: "a", keep: true } }),
    );
    // Each consultant ran ONCE and saw exactly the fold at its position; the
    // executor admission carries the fully folded value.
    expect(seen.mark).toEqual([{ command: "a.s1", keep: true }]);
    expect(seen.guard).toEqual([{ command: "a.s1.h1.s2", keep: true }]);
    expect(evaluation.verdict).toBe("transform");
    expect(evaluation.value).toEqual({ command: "a.s1.h1.s2", keep: true });
    expect(evaluation.gate?.consulted.map((entry) => entry.ref)).toEqual([
      "demo/stamp",
      "demo/mark",
      "demo/stamp",
      "demo/guard",
    ]);
  });

  test("ordered transforms capture copied implementations and deeply immutable configuration", () => {
    const transformer = {
      name: "demo/wrap",
      apply: (args: PlainValue, config: PlainValue): PlainValue => ({ args, config }),
    };
    const transformers = [transformer];
    const registry = createHandlerTable({ transformers, obligations: [] });
    const config = { fields: ["args", "config"], nested: ["first"] };
    const rows = [
      atGeneration(compaction, 1),
      atGeneration(
        draft(
          "a",
          "tool",
          "pre",
          { type: "transform", ref: transformer.name, config },
          { priority: 20 },
        ),
        1,
      ),
      atGeneration(
        draft(
          "b",
          "tool",
          "pre",
          { type: "transform", ref: transformer.name, config: { fields: ["args", "config"] } },
          { priority: 10 },
        ),
        1,
      ),
    ];
    const snapshot = compilePolicySnapshot({ generation: 1, registry, rows });
    const reverse = compilePolicySnapshot({ generation: 1, registry, rows: [...rows].reverse() });
    transformer.apply = () => "wrong";
    transformers.length = 0;
    config.nested[0] = "changed";
    const evaluation = snapshot.evaluate(input);
    const afterA = {
      ...input.value,
      args: input.value,
      config: { fields: ["args", "config"], nested: ["first"] },
    };
    expect(evaluation.value).toEqual({
      ...input.value,
      args: afterA,
      config: { fields: ["args", "config"] },
    });
    expect(evaluation.transforms).toEqual([
      { ruleId: "a", ref: "demo/wrap" },
      { ruleId: "b", ref: "demo/wrap" },
    ]);
    expect(evaluation).not.toHaveProperty("ref");
    expect(reverse.contentHash).toBe(snapshot.contentHash);
    expect(reverse.evaluate(input)).toEqual(evaluation);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.transformers)).toBe(true);
    expect(Object.isFrozen(registry.transformers[0])).toBe(true);
  });

  test("historic bytes hash unchanged and reopen executes the sole kernel redactor", () => {
    const rows = [
      atGeneration(compaction, 1),
      atGeneration(
        draft("redact", "tool", "pre", { type: "transform", name: "redact", paths: ["secret"] }),
        1,
      ),
    ];
    const bytes = JSON.stringify(rows);
    const snapshot = compilePolicySnapshot({
      generation: 1,
      registry: KERNEL_POLICY_REGISTRY,
      rows,
    });
    const identity = rows
      .map(({ generation: _generation, ...row }: PolicyRow.Row) => row)
      .sort((a: PolicyRowDraft, b: PolicyRowDraft) => a.name.localeCompare(b.name));
    expect(snapshot.contentHash).toBe(canonicalDigest(identity));
    expect(snapshot.evaluate(input)).toMatchObject({
      ref: "kernel/redact",
      transforms: [{ ruleId: "redact", ref: "kernel/redact" }],
      value: { keep: true },
    });
    expect(
      compilePolicySnapshot({
        generation: 1,
        registry: KERNEL_POLICY_REGISTRY,
        rows: PolicyRow.Row.array().parse(JSON.parse(bytes)),
      }).evaluate(input),
    ).toEqual(snapshot.evaluate(input));
    expect(JSON.stringify(rows)).toBe(bytes);
    expect(input.value.secret).toBe("original");
  });

  test("registry rejects duplicate and invalid names without freezing caller data", () => {
    const transformer = { name: "demo/id", apply: (args: PlainValue) => args };
    expect(() =>
      createHandlerTable({ transformers: [transformer, transformer], obligations: [] }),
    ).toThrow(HandlerTableError);
    expect(() =>
      createHandlerTable({
        transformers: [{ ...transformer, name: "invalid" }],
        obligations: [],
      }),
    ).toThrow(HandlerTableError);
    expect(() =>
      createHandlerTable({
        transformers: [],
        obligations: [{ name: "demo/cap" }, { name: "demo/cap" }],
      }),
    ).toThrow(HandlerTableError);
    expect(Object.isFrozen(transformer)).toBe(false);
  });

  test("transform implementations receive frozen captured config rather than caller-owned objects", () => {
    const frozen: boolean[] = [];
    const registry = createHandlerTable({
      transformers: [
        {
          name: "demo/observe",
          apply: (args: PlainValue, config: PlainValue) => {
            frozen.push(Object.isFrozen(config));
            if (config !== null && typeof config === "object" && !Array.isArray(config))
              frozen.push(Object.isFrozen(config.nested));
            return args;
          },
        },
      ],
      obligations: [],
    });
    const config = { nested: [1], fields: ["keep"] };
    const snapshot = compilePolicySnapshot({
      generation: 1,
      registry,
      rows: [
        atGeneration(compaction, 1),
        atGeneration(
          draft("freeze", "tool", "pre", { type: "transform", ref: "demo/observe", config }),
          1,
        ),
      ],
    });
    snapshot.evaluate(input);
    expect(frozen).toEqual([true, true]);
    expect(Object.isFrozen(config)).toBe(false);
    expect(Object.isFrozen(config.nested)).toBe(false);
  });

  test("historical seeded budgets reopen with identical named obligations", () => {
    const historical = SEEDED_POLICY_ROWS.map((row: PolicyRowDraft) => {
      const verdict = RowVerdict.parse(row.verdict.value);
      if (verdict.type !== "obligation") return atGeneration(row, 1);
      return atGeneration(
        {
          ...row,
          verdict: {
            encodingVersion: 1,
            value: {
              type: "obligation",
              name: "budget_clamp",
              metric: verdict.metric,
              limit: verdict.limit,
            },
          },
        },
        1,
      );
    });
    const bytes = JSON.stringify(historical);
    const snapshot = compilePolicySnapshot({
      generation: 1,
      registry: KERNEL_POLICY_REGISTRY,
      rows: PolicyRow.Row.array().parse(JSON.parse(bytes)),
    });
    expect(
      snapshot.evaluate({ ...input, kind: "turn", phase: "post", op: "continue" }).obligations,
    ).toEqual([{ ref: "kernel/budget-clamp", metric: "continuation", limit: 8 }]);
    expect(snapshot.evaluate({ ...input, op: "send_message" }).obligations).toEqual([
      { ref: "kernel/budget-clamp", metric: "fanout", limit: 8 },
    ]);
    expect(JSON.stringify(historical)).toBe(bytes);
  });
});
