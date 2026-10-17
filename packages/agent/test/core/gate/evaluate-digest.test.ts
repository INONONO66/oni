import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import * as Protocol from "@openomni/protocol";
import { compilePolicySnapshot, KERNEL_POLICY_REGISTRY } from "../../../src/core/gate/compile";
import { compileGateRows } from "../../../src/core/gate/compose";
import { fullPointTable, gateRow } from "../../helpers/gate-rows";
import { atGeneration, compaction, draft } from "../../kernel/gate/row-fixtures";
import { runTestPromise } from "../../helpers/isolated";

/** Only digests over the evaluated value carry this marker; row, payload and when digests never do. */
const SENTINEL = "digest-sentinel-7f3a";
const input = { kind: "tool", phase: "pre", op: "bash", value: { command: SENTINEL } } as const;

const digest = spyOn(Protocol, "canonicalDigest");
afterEach(() => digest.mockClear());

function valueDigests(): number {
  return digest.mock.calls.filter(([value]) => JSON.stringify(value).includes(SENTINEL)).length;
}

describe("gate input digest", () => {
  test("evaluate computes the input digest exactly once and decide reuses it", () => {
    const snapshot = compilePolicySnapshot({
      generation: 1,
      registry: KERNEL_POLICY_REGISTRY,
      rows: [atGeneration(compaction, 1), atGeneration(draft("allow", "tool", "pre", { type: "allow" }), 1)],
    });
    digest.mockClear();
    const evaluation = snapshot.evaluate(input);

    expect(evaluation.verdict).toBe("allow");
    expect(valueDigests()).toBe(1);
    expect(evaluation.inputHash).toBe(Protocol.canonicalDigest(input));
    expect(evaluation.gate?.inputHash).toBe(evaluation.inputHash);
  });

  test("every projected pass of evaluateEffect digests its input exactly once", async () => {
    const snapshot = compilePolicySnapshot({
      generation: 1,
      registry: {
        ...KERNEL_POLICY_REGISTRY,
        consultants: [
          { name: "hook/process", consult: () => Effect.succeed({ value: { command: "masked" }, payload: { step: 1 } }) },
        ],
      },
      rows: [
        atGeneration(compaction, 1),
        atGeneration(
          draft("mask", "tool", "pre", {
            type: "consult",
            ref: "hook/process",
            rewrite: true,
            config: { event: "PreToolUse", fields: ["command"] },
          }),
          1,
        ),
      ],
    });
    if (snapshot.evaluateEffect === undefined) throw new Error("effectful evaluation missing");
    digest.mockClear();
    const evaluation = await runTestPromise(snapshot.evaluateEffect(input));

    expect(evaluation.value).toEqual({ command: "masked" });
    // Two consult probes (pending, then settled) and the final evaluation: one digest each.
    expect(valueDigests()).toBe(3);
    expect(evaluation.inputHash).toBe(Protocol.canonicalDigest(input));
  });

  test("compiled gate rows digest the input only when no precomputed hash is supplied", () => {
    const gate = compileGateRows({ table: fullPointTable(), rows: [gateRow("tool.pre")], handlers: [], generation: 1 });
    const decideInput = { when: { op: "bash" }, value: { command: SENTINEL } };

    digest.mockClear();
    const own = gate.decide("tool.pre", decideInput);
    expect(valueDigests()).toBe(1);
    expect(own.decision.inputHash).toBe(
      Protocol.canonicalDigest({ point: "tool.pre", when: decideInput.when, value: decideInput.value }),
    );

    digest.mockClear();
    const reused = gate.decide("tool.pre", decideInput, { inputHash: "precomputed" });
    expect(valueDigests()).toBe(0);
    expect(reused.decision.inputHash).toBe("precomputed");
  });
});
