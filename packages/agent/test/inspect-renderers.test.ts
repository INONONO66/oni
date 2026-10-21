/**
 * The nine `read` models render all 12 public journal kinds from the journal fold (an ordered fact reduction
 * over committed actions, never the observation bus), and `fold.checkpoint` stays internal: no model row ever
 * carries it. The last test drives the same projections through the entity's `read` RPC against the real
 * cluster host.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { LedgerAction } from "@oni/protocol";
import { READ_MODELS, renderReadModel, type ReadModel } from "../src/core/session/read";
import { clusterTempDir, runCluster, sendDeliver, sendRead } from "./helpers/cluster-runtime";

function node(input: {
  readonly seq: number;
  readonly id: string;
  readonly kind: string;
  readonly parentId?: string | null;
  readonly intent?: LedgerAction.Node["intent"]["value"];
  readonly effect?: LedgerAction.Node["effect"]["value"];
}): LedgerAction.Node {
  return LedgerAction.Node.parse({
    id: input.id,
    parentId: input.parentId ?? null,
    sessionId: "renderers",
    kind: input.kind,
    ordinal: input.seq,
    ts: 1_000 + input.seq,
    intent: { encodingVersion: 1, value: input.intent ?? {} },
    effect: { encodingVersion: 1, value: input.effect ?? {} },
    prevHash: "before",
    actionHash: "after",
    irreversible: true,
  });
}

/** One action per public kind (12) plus the internal fold.checkpoint row. */
const ACTIONS: readonly LedgerAction.Node[] = [
  node({
    seq: 1,
    id: "configure-1",
    kind: "session.configure",
    intent: { settings: { steering: "all", followUp: "one" } },
  }),
  node({ seq: 2, id: "prompt-1", kind: "prompt", intent: { delivery: "steer" } }),
  node({ seq: 3, id: "signal-1", kind: "signal", intent: { control: "interrupt" } }),
  node({ seq: 4, id: "turn-1", kind: "turn", intent: { phase: "intent" } }),
  node({ seq: 5, id: "llm-1", kind: "llm", intent: { phase: "intent", attempt: 1 } }),
  node({
    seq: 6,
    id: "llm-1-result",
    kind: "llm",
    parentId: "llm-1",
    intent: { phase: "result" },
    effect: {
      phase: "result",
      usageProvenance: "reported",
      evidence: { usage: { inputTokens: 3, outputTokens: 2 } },
    },
  }),
  node({ seq: 7, id: "tool-1", kind: "tool", intent: { op: "call", phase: "intent" } }),
  node({
    seq: 8,
    id: "compaction-1",
    kind: "compaction",
    intent: { op: "compact", reason: "manual", phase: "intent" },
  }),
  node({ seq: 9, id: "message-1", kind: "message", intent: { to: "channel", direction: "out" } }),
  node({
    seq: 10,
    id: "request-1",
    kind: "request",
    intent: { requestId: "req-1" },
    effect: { phase: "open" },
  }),
  node({
    seq: 11,
    id: "alarm-1",
    kind: "alarm",
    intent: { op: "fired", outcome: "stale", purpose: "retry", occurrenceId: "occ-1" },
  }),
  node({
    seq: 12,
    id: "decision-1",
    kind: "policy.decision",
    intent: {
      hook: "tool.pre",
      op: "call",
      verdict: "allow",
      gate: { consulted: [{ ref: "rule-1", digest: "d1" }] },
    },
    effect: { phase: "result", reason: "matched" },
  }),
  node({ seq: 13, id: "action-1", kind: "action", intent: { delivery: "followUp", after: 2 } }),
  node({ seq: 14, id: "checkpoint-1", kind: "fold.checkpoint", intent: { phase: "record" } }),
];

test("history renders prompt/action/turn/llm/tool/compaction rows exactly", () => {
  expect(renderReadModel("history", ACTIONS)).toEqual([
    { seq: 2, id: "prompt-1", at: 1_002, kind: "prompt", op: null, phase: null },
    { seq: 4, id: "turn-1", at: 1_004, kind: "turn", op: null, phase: "intent" },
    { seq: 5, id: "llm-1", at: 1_005, kind: "llm", op: null, phase: "intent" },
    { seq: 6, id: "llm-1-result", at: 1_006, kind: "llm", op: null, phase: "result" },
    { seq: 7, id: "tool-1", at: 1_007, kind: "tool", op: "call", phase: "intent" },
    { seq: 8, id: "compaction-1", at: 1_008, kind: "compaction", op: "compact", phase: "intent" },
    { seq: 13, id: "action-1", at: 1_013, kind: "action", op: null, phase: null },
  ]);
});

test("decisions render policy.decision with the gate's consulted rows", () => {
  expect(renderReadModel("decisions", ACTIONS)).toEqual([
    {
      seq: 12,
      id: "decision-1",
      at: 1_012,
      hook: "tool.pre",
      op: "call",
      verdict: "allow",
      reason: "matched",
      consulted: [{ ref: "rule-1", digest: "d1" }],
    },
  ]);
});

test("requests render lifecycle phases", () => {
  expect(renderReadModel("requests", ACTIONS)).toEqual([
    { seq: 10, id: "request-1", at: 1_010, requestId: "req-1", phase: "open" },
  ]);
});

test("alarms render arm/fired with purpose, occurrence and outcome", () => {
  expect(renderReadModel("alarms", ACTIONS)).toEqual([
    {
      seq: 11,
      id: "alarm-1",
      at: 1_011,
      op: "fired",
      purpose: "retry",
      occurrenceId: "occ-1",
      outcome: "stale",
    },
  ]);
  const armed = node({
    seq: 15,
    id: "alarm-2",
    kind: "alarm",
    intent: { op: "arm", purpose: "deadline" },
  });
  expect(renderReadModel("alarms", [armed])).toEqual([
    {
      seq: 15,
      id: "alarm-2",
      at: 1_015,
      op: "arm",
      purpose: "deadline",
      occurrenceId: null,
      outcome: null,
    },
  ]);
});

test("generations render session.configure settings data", () => {
  expect(renderReadModel("generations", ACTIONS)).toEqual([
    { seq: 1, id: "configure-1", at: 1_001, settings: { steering: "all", followUp: "one" } },
  ]);
});

test("tree renders session.configure lineage", () => {
  expect(renderReadModel("tree", ACTIONS)).toEqual([
    { seq: 1, id: "configure-1", at: 1_001, parentId: null },
  ]);
  const child = node({
    seq: 16,
    id: "configure-2",
    kind: "session.configure",
    parentId: "configure-1",
  });
  expect(renderReadModel("tree", [child])).toEqual([
    { seq: 16, id: "configure-2", at: 1_016, parentId: "configure-1" },
  ]);
});

test("metrics render turn rows plus llm attempt usage", () => {
  expect(renderReadModel("metrics", ACTIONS)).toEqual({
    usage: [{ attemptId: "llm-1", provenance: "reported", inputTokens: 3, outputTokens: 2 }],
    usageByPurpose: [{
      purpose: null,
      usage: [{ attemptId: "llm-1", provenance: "reported", inputTokens: 3, outputTokens: 2 }],
    }],
    turns: [{ seq: 4, id: "turn-1", at: 1_004 }],
  });
});

test("control renders signal rows", () => {
  expect(renderReadModel("control", ACTIONS)).toEqual([
    { seq: 3, id: "signal-1", at: 1_003, control: "interrupt" },
  ]);
});

test("outbound renders message rows", () => {
  expect(renderReadModel("outbound", ACTIONS)).toEqual([
    { seq: 9, id: "message-1", at: 1_009, to: "channel", direction: "out" },
  ]);
});

test("fold.checkpoint is excluded from every model", () => {
  const checkpoint = ACTIONS.filter((action) => action.kind === "fold.checkpoint");
  expect(checkpoint).toHaveLength(1);
  for (const model of READ_MODELS) {
    const page = renderReadModel(model, checkpoint);
    expect(Array.isArray(page) ? page : [...page.usage, ...page.turns]).toEqual([]);
  }
});

test("every public kind lands in exactly its owning models; none is dropped", () => {
  const rendered = new Set<string>();
  for (const model of READ_MODELS) {
    const page = renderReadModel(model, ACTIONS);
    const rows = Array.isArray(page) ? page : [...page.usage, ...page.turns];
    for (const row of rows) {
      const id = "id" in row ? row.id : row.attemptId;
      const action = ACTIONS.find((candidate) => candidate.id === id);
      if (action !== undefined) rendered.add(action.kind);
    }
  }
  expect([...rendered].sort()).toEqual([
    "action",
    "alarm",
    "compaction",
    "llm",
    "message",
    "policy.decision",
    "prompt",
    "request",
    "session.configure",
    "signal",
    "tool",
    "turn",
  ]);
});

const { dir, sessionsDir, catalogFile } = clusterTempDir("w52-inspect-read-");
const options = { sessionsDir, catalogFile };

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("read{model, cursor} pages the rendered projection over the live chain", async () => {
  const sessionId = "read-rpc";
  await runCluster(
    options,
    sendDeliver(sessionId, { kind: "prompt", idempotencyKey: "rp-1", content: "hello" }),
  );
  const models: readonly ReadModel[] = ["history", "metrics", "generations"];
  const pages: { body: string; nextCursor: number | null }[] = [];
  for (const model of models) {
    pages.push(await runCluster(options, sendRead(sessionId, { model, cursor: 0 })));
  }
  const [history, metrics, generations] = pages;
  if (history === undefined || metrics === undefined || generations === undefined)
    throw new Error("missing read pages");
  expect(history.nextCursor).toBeNull();
  const historyRows = JSON.parse(history.body) as { id: string }[];
  expect(Array.isArray(historyRows)).toBe(true);
  expect(historyRows.some((row) => row.id === "rp-1")).toBe(true);
  const metricsPage = JSON.parse(metrics.body) as { turns: { id: string }[] };
  expect(metricsPage.turns.length).toBeGreaterThan(0);
  const generationRows = JSON.parse(generations.body) as { id: string }[];
  expect(generationRows.length).toBeGreaterThan(0);
});
