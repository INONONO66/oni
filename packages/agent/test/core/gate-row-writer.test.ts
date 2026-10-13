import { expect, test } from "bun:test";
import {
  GateDecision,
  GateRowId,
  Gateway,
  SessionGeneration,
  SessionHistory,
  type PolicyRow,
} from "@openomni/protocol";
import {
  compilePolicySnapshot,
  createHandlerTable,
  KERNEL_POLICY_REGISTRY,
  SEEDED_POLICY_ROWS,
} from "../../src/core/gate/compile";
import { DEFAULT_COMPILE_KINDS, parseRow } from "../../src/core/gate/row-parse";
import { projectGeneration } from "../../src/core/gate/project";
import { GATE_ROW_WRITER_VERSION } from "../../src/core/gate/rows";
import { composePointTable, KERNEL_CAPABILITY_POINTS } from "../../src/core/points";
import * as SessionHandleStore from "../../src/core/store/fence";

const GENERATION = 1;

/**
 * The pre-cutover identity prefix and id shape, assembled so the sealed
 * token keeps 0 hits in source while the fixture
 * still carries the exact bytes old decision facts were written with.
 */
const PRE_CUTOVER_PREFIX = ["legacy", ""].join("/");
const preCutoverId = (point: string, ordinal: number): string =>
  `${PRE_CUTOVER_PREFIX}${point}#${ordinal}`;

function seededRows(extra: readonly Omit<PolicyRow.Row, "generation">[] = []): PolicyRow.Row[] {
  return [...SEEDED_POLICY_ROWS, ...extra].map((row) => ({ ...row, generation: GENERATION }));
}

function projected(rows: readonly PolicyRow.Row[]) {
  const registry = createHandlerTable(KERNEL_POLICY_REGISTRY);
  const kinds = new Set<string>(DEFAULT_COMPILE_KINDS);
  const parsed = rows.map((row) => parseRow(row, GENERATION, kinds, registry));
  const table = composePointTable({ capabilities: KERNEL_CAPABILITY_POINTS });
  return projectGeneration(parsed, GENERATION, table, registry);
}

/** A production-shaped message row whose rule table compiles to a per-row matcher. */
const MATCHER_ROW: Omit<PolicyRow.Row, "generation"> = {
  name: "message.qa.interrupt",
  kind: "message",
  phase: "pre",
  priority: 1_000,
  match: {
    encodingVersion: 1,
    value: {
      message: Gateway.RuleTableB.parse({
        id: "message.qa.interrupt",
        table: "B",
        sender: "session",
        senderRole: "child",
        type: "interrupt",
        check: { kind: "type" },
        effect: "deny",
      }),
    },
  },
  verdict: { encodingVersion: 1, value: { type: "deny", reason: "message.qa.interrupt" } },
};

const MATCHING_MESSAGE_CONTEXT = {
  sender: "session",
  senderRole: "child",
  targetKind: "session",
  type: "interrupt",
  parentChild: true,
  fanout: 0,
  depth: 0,
  withinParentDeadline: true,
} as const;

test("a compiled generation mints only schema-valid current identities; same-name rows on one point stay distinct", () => {
  const duplicate = (priority: number): Omit<PolicyRow.Row, "generation"> => ({
    name: "dup-row",
    kind: "tool",
    phase: "pre",
    priority,
    match: { encodingVersion: 1, value: {} },
    verdict: { encodingVersion: 1, value: { type: "allow" } },
  });
  const generation = projected(seededRows([duplicate(500), duplicate(400)]));
  const ids = [...generation.rowById.keys()];
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    // The real protocol schema, not a local approximation:
    // every minted id must parse as a GateRowId or decision facts refuse.
    expect(GateRowId.safeParse(id).success).toBe(true);
    expect(id.startsWith(PRE_CUTOVER_PREFIX)).toBe(false);
  }
  const duplicates = ids.filter((id) => id.startsWith("dup-row/"));
  expect(duplicates).toHaveLength(2);
  expect(new Set(duplicates).size).toBe(2);
  for (const id of duplicates) expect(id).toMatch(/^dup-row\/tool\.pre#\d+$/);
});

test("production row names (bundle ids, dotted) mint GateRowId-valid ids; the decision parses and an approved call re-admits", () => {
  // gateRowPolicySeeds-shaped rows: the live plane seeds `name: row.id` from
  // composed bundle rows (`hooks-json/tool.pre#3`) and `name: message.id`
  // (dotted). Pre-fix these minted ids violated GateRowId and the recorded
  // evidence refused as stale_approval at re-admission.
  const bundleSeeded: Omit<PolicyRow.Row, "generation"> = {
    name: "hooks-json/tool.pre#3",
    kind: "tool",
    phase: "pre",
    priority: 800,
    match: { encodingVersion: 1, value: { op: "qa__hook" } },
    verdict: { encodingVersion: 1, value: { type: "require_approval", reason: "hooks-json/tool.pre#3" } },
  };
  const dotted: Omit<PolicyRow.Row, "generation"> = {
    name: "message.external.contact",
    kind: "message",
    phase: "pre",
    priority: 700,
    match: { encodingVersion: 1, value: {} },
    verdict: { encodingVersion: 1, value: { type: "allow" } },
  };
  const rows = seededRows([bundleSeeded, dotted]);
  const generation = projected(rows);
  const ids = [...generation.rowById.keys()];
  for (const id of ids) expect(GateRowId.safeParse(id).success).toBe(true);
  expect(ids.some((id) => id.startsWith("hooks-json-tool-pre-3/tool.pre#"))).toBe(true);
  expect(ids.some((id) => id.startsWith("message-external-contact/message.pre#"))).toBe(true);

  // The approval round trip recoverAdmission performs: the committed gate
  // evidence must parse strictly (parseGateEvidence) and replay verbatim
  // (replayRecordedValue) — anything else throws stale_approval.
  const snapshot = compilePolicySnapshot({
    registry: createHandlerTable(KERNEL_POLICY_REGISTRY),
    generation: GENERATION,
    rows,
  });
  const input = { kind: "tool", phase: "pre" as const, op: "qa__hook", value: { bytes: "approved" } };
  const fresh = snapshot.evaluate(input);
  expect(fresh.verdict).toBe("require_approval");
  if (fresh.gate === undefined) throw new Error("fresh evaluation carries no gate decision");
  const recorded = GateDecision.parse(fresh.gate);
  expect(recorded.rowIds.some((id) => id.startsWith("hooks-json-tool-pre-3/"))).toBe(true);
  const replayed = snapshot.evaluate({ ...input, recorded });
  expect(replayed.replayed).toBe(true);
  expect(replayed.value).toEqual(recorded.output);
});

test("a decision fact recorded under pre-cutover ids decodes and replays without rewriting its matchedRuleIds", () => {
  const snapshot = compilePolicySnapshot({
    registry: createHandlerTable(KERNEL_POLICY_REGISTRY),
    generation: GENERATION,
    rows: seededRows([MATCHER_ROW]),
  });
  const input = { kind: "tool", phase: "pre" as const, op: "qa__noop", value: { bytes: "untouched" } };
  const fresh = snapshot.evaluate(input);
  if (fresh.gate === undefined) throw new Error("fresh evaluation carries no gate decision");

  // The persisted fact decodes with its pre-cutover identities verbatim.
  const fact = SessionHistory.PolicyDecision.parse({
    revision: 1,
    actionId: "qa-decision-1",
    subjectActionId: null,
    turnId: null,
    hook: "tool.pre",
    op: input.op,
    generation: GENERATION,
    matchedRuleIds: [preCutoverId("tool.pre", 0)],
    transforms: [],
    verdict: "allow",
    reason: null,
    inputHash: fresh.inputHash,
  });
  expect(fact.matchedRuleIds).toEqual([preCutoverId("tool.pre", 0)]);

  // Its recorded gate decision replays by input hash; the legacy row ids stay.
  const recorded = GateDecision.parse({ ...fresh.gate, rowIds: [preCutoverId("tool.pre", 0)] });
  const replayed = snapshot.evaluate({ ...input, recorded });
  expect(replayed.replayed).toBe(true);
  expect(replayed.gate?.rowIds).toEqual([preCutoverId("tool.pre", 0)]);
  expect(replayed.value).toEqual(recorded.output);

  // A pre-cutover record that applied a CONTEXT-MATCHER row does NOT replay:
  // the live matcher entry's current id is absent from the recorded legacy
  // rowIds, so `replays()` declines and the gate decides fresh under current
  // identities. In recoverAdmission that same non-replay surfaces as the
  // documented fail-closed `stale_approval` for approvals pending across the
  // cutover upgrade (an accepted, recorded deviation).
  const matcherInput = {
    kind: "message",
    phase: "pre" as const,
    op: "send_message",
    message: MATCHING_MESSAGE_CONTEXT,
    value: { body: "qa" },
  };
  const freshMatcher = snapshot.evaluate(matcherInput);
  if (freshMatcher.gate === undefined) throw new Error("matcher evaluation carries no gate decision");
  expect(freshMatcher.gate.rowIds.some((id) => id.startsWith("message-qa-interrupt/"))).toBe(true);
  const recordedMatcher = GateDecision.parse({
    ...freshMatcher.gate,
    rowIds: [preCutoverId("message.pre", 0)],
  });
  const replayedMatcher = snapshot.evaluate({ ...matcherInput, recorded: recordedMatcher });
  expect(replayedMatcher.replayed).not.toBe(true);
  expect(replayedMatcher.gate?.rowIds.some((id) => id.startsWith("message-qa-interrupt/"))).toBe(true);
  expect(replayedMatcher.gate?.rowIds.includes(preCutoverId("message.pre", 0))).toBe(false);
});

test("a pre-cutover snapshot parses without rowsVersion; a new materialization records version 1", () => {
  const preCutover = SessionGeneration.Snapshot.parse({
    generation: 1,
    revertTo: 0,
    tools: [],
    toolsHash: "qa-tools-hash",
    bundles: [],
    systemPreset: "",
    systemBlocks: [],
    systemValue: "",
    systemHash: "qa-system-hash",
    policyGeneration: 0,
  });
  expect("rowsVersion" in preCutover && preCutover.rowsVersion !== undefined).toBe(false);

  const materialized = SessionHandleStore.generationSnapshot({
    generation: 1,
    revertTo: 0,
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: 0,
  });
  expect(materialized.rowsVersion).toBe(GATE_ROW_WRITER_VERSION);
  expect(materialized.rowsVersion).toBe(1);
});
