import { describe, expect, test } from "bun:test";
import { CHILD, PARENT, useForkFixture } from "../helpers/fork-fixture";
import * as SessionHandleStore from "../../../src/core/store/fence";
import { FORK_ASIDE_REF, forkAncestryOf, forkAside } from "../../../src/inspect/tree";
import { forkAsideTransformer } from "../../helpers/fork-aside";
import { foldSessionHistory } from "../../../src/inspect/history";
import {
  compilePolicySnapshot,
  createHandlerTable,
  KERNEL_POLICY_REGISTRY,
  SEEDED_POLICY_ROWS,
} from "../../../src/core/gate/compile";
import type { NamedTransformer } from "../../../src/core/gate/registry";
import type { PolicyRow } from "@oni/protocol";

/** One compiled generation: seeded kernel rows plus the given prompt.pre rows. */
function compiledWith(
  transformer: NamedTransformer,
  rows: readonly Omit<PolicyRow.Row, "generation">[],
) {
  return compilePolicySnapshot({
    registry: createHandlerTable({
      transformers: [...KERNEL_POLICY_REGISTRY.transformers, transformer],
      obligations: [...KERNEL_POLICY_REGISTRY.obligations],
    }),
    generation: 1,
    rows: [...SEEDED_POLICY_ROWS, ...rows].map((row) => ({ ...row, generation: 1 })),
  });
}

/** The explicit opt-in row: promote the fork aside at the prompt.pre point. */
const FORK_ASIDE_ROW: Omit<PolicyRow.Row, "generation"> = {
  name: "fork-aside",
  kind: "prompt",
  phase: "pre",
  priority: 500,
  match: { encodingVersion: 1, value: {} },
  verdict: {
    encodingVersion: 1,
    value: { type: "transform", ref: FORK_ASIDE_REF, config: { fields: ["body"] } },
  },
};

const { stores, child, fixture } = useForkFixture();

describe("inspect aside (#1257)", () => {
  test("the aside is an inspect projection, never model context or compaction input", () => {
    const parent = fixture.buildParent();
    fixture.forked(parent.hashOf("turn-1:terminal"));
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);
    const ancestry = forkAncestryOf(childKernel, CHILD);
    if (ancestry === null) throw new Error("child ancestry missing");
    const aside = forkAside(ancestry);
    expect(aside).toContain(PARENT);
    expect(aside).toContain(ancestry.anchor);

    // Model context: the canonical history fold over the child chain carries
    // the copied conversation but never the aside text; compaction folds over
    // this same history, so the aside cannot leak there either.
    const actions = childKernel.historyPage(CHILD, { afterRevision: 0, limit: 50 }).actions;
    const messages = foldSessionHistory(CHILD, actions);
    const rendered = JSON.stringify(messages);
    expect(rendered).toContain("first");
    expect(rendered).toContain("done");
    // Structural exclusion by ancestry identity: none of the pin's facts —
    // the anchor hash, the pinned parent head, the projected aside itself —
    // appear anywhere in the folded model context.
    expect(rendered).not.toContain(ancestry.anchor);
    expect(rendered).not.toContain(ancestry.parentHead);
    expect(rendered).not.toContain(JSON.stringify(aside).slice(1, -1));
  });

  test("a REGISTERED prompt.pre transform row promotes the aside through the compiled gate", () => {
    const parent = fixture.buildParent();
    fixture.forked(parent.hashOf("turn-1:terminal"));
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);
    const ancestry = forkAncestryOf(childKernel, CHILD);
    if (ancestry === null) throw new Error("child ancestry missing");
    const aside = forkAside(ancestry);
    const transformer = forkAsideTransformer((id) => (id === CHILD ? ancestry : null), CHILD);

    // The composed gate: handler table registration + the explicit policy row.
    const snapshot = compiledWith(transformer, [FORK_ASIDE_ROW]);
    const evaluation = snapshot.evaluate({
      kind: "prompt",
      phase: "pre",
      value: { body: "hello" },
    });
    expect(evaluation.matchedRuleIds).toContain("fork-aside");
    expect(evaluation.value).toEqual({ body: `${aside}\n\nhello` });

    // A prompt value without a text body passes through the same registered row.
    expect(snapshot.evaluate({ kind: "prompt", phase: "pre", value: { body: 7 } }).value)
      .toEqual({ body: 7 });
    // A root session (no ancestry) passes through even with the row present.
    const rootSnapshot = compiledWith(forkAsideTransformer(() => null, PARENT), [FORK_ASIDE_ROW]);
    expect(rootSnapshot.evaluate({ kind: "prompt", phase: "pre", value: { body: "hello" } }).value)
      .toEqual({ body: "hello" });
    // Without the opt-in row the registered handler is inert: nothing promotes.
    const unregistered = compiledWith(transformer, []);
    expect(unregistered.evaluate({ kind: "prompt", phase: "pre", value: { body: "hello" } }).value)
      .toEqual({ body: "hello" });
  });
});
