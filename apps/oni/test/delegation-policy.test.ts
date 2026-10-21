/**
 * #1258 delegation-policy bundle: the three cap guards at `tool.pre`
 * (spawn_depth from catalog parent links, spawn_children from the parent's
 * live-children count, spend-cap refusal when unset) and the
 * `delegation.deadline` purpose (cancel the silent child, prompt the parent).
 * Exact-state assertions; connectors and guards are pure or injected-door
 * programs, so no clock is involved beyond the fired occurrence's own stamp.
 */
import { expect, test } from "bun:test";
import type { Bundle } from "@oni/agent";
import { Effect } from "effect";
import type { Core } from "@oni/agent";
import { Gateway, Delivery, type LedgerAction, LedgerSession } from "@oni/protocol";
import {
  ADMISSION_DEPTH_MAX,
  catalogDelegationReads,
  DELEGATION_DEADLINE,
  DelegationRefusal,
  delegationPolicyBundle,
  delegationPurposes,
  settleChild,
  spawnChildrenGuard,
  spawnDepthGuard,
  spendCapGuard,
  type DelegationReads,
} from "../src/bundles/delegation-policy/index";
import { SHIPPED_OWNER_POLICY } from "../src/composition/policy";
import { runEffect } from "./helpers/effect";

const NEW_SESSION = { to: { kind: "new_session", role: "child" }, message: "go" };

test("#1422 the gateway admission depth cap is the guard's maxDepth", () => {
  expect(ADMISSION_DEPTH_MAX).toBe(Gateway.DelegationCaps.maxDepth);
});
const service = () => {
  throw new Error("guards consult no services");
};
const when = { op: "send_message", sessionId: "parent" };

function reads(input: { depth?: number; children?: number }): DelegationReads {
  return {
    depth: () => input.depth,
    activeChildren: () => input.children,
  };
}

test("spawn_depth allows below the row limit and denies at it; a non-child send is skipped", () => {
  const guard = spawnDepthGuard(reads({ depth: 2 }));
  expect(guard.decide({ value: NEW_SESSION, params: { limit: 3 }, when, service })).toEqual({
    verdict: "allow",
    payload: { cap: "spawn_depth", limit: 3, observed: 2 },
  });
  const depthRefusal = { code: "delegation_refused", cap: "spawn_depth", limit: 3, observed: 3 };
  expect(spawnDepthGuard(reads({ depth: 3 })).decide({ value: NEW_SESSION, params: { limit: 3 }, when, service })).toEqual({
    verdict: "deny",
    payload: {
      cap: "spawn_depth",
      limit: 3,
      observed: 3,
      reason: JSON.stringify(depthRefusal),
    },
  });
  expect(guard.decide({ value: { to: { kind: "session", id: "s" }, message: "hi" }, params: { limit: 3 }, when, service })).toEqual({
    verdict: "allow",
    payload: { cap: "spawn_depth", skipped: true },
  });
});

test("caps fail closed: an unknown session or a missing sessionId denies child creation", () => {
  const unavailable = spawnDepthGuard(reads({}));
  expect(unavailable.decide({ value: NEW_SESSION, params: { limit: 3 }, when, service })).toEqual({
    verdict: "deny",
    payload: {
      cap: "spawn_depth",
      limit: 3,
      reason: JSON.stringify({ code: "delegation_refused", cap: "spawn_depth", limit: 3, reason: "catalog read unavailable" }),
    },
  });
  expect(
    spawnChildrenGuard(reads({ children: 1 })).decide({ value: NEW_SESSION, params: null, when: { op: "send_message" }, service }),
  ).toEqual({
    verdict: "deny",
    payload: {
      cap: "spawn_children",
      limit: Gateway.DelegationCaps.maxActiveChildren,
      reason: JSON.stringify({
        code: "delegation_refused",
        cap: "spawn_children",
        limit: Gateway.DelegationCaps.maxActiveChildren,
        reason: "catalog read unavailable",
      }),
    },
  });
});

test("spawn_children denies the fifth concurrent child under the default cap", () => {
  const atCap = spawnChildrenGuard(reads({ children: 4 }));
  const childrenRefusal = { code: "delegation_refused", cap: "spawn_children", limit: 4, observed: 4 };
  expect(atCap.decide({ value: NEW_SESSION, params: { limit: 4 }, when, service })).toEqual({
    verdict: "deny",
    payload: {
      cap: "spawn_children",
      limit: 4,
      observed: 4,
      reason: JSON.stringify(childrenRefusal),
    },
  });
  expect(spawnChildrenGuard(reads({ children: 3 })).decide({ value: NEW_SESSION, params: { limit: 4 }, when, service })).toEqual({
    verdict: "allow",
    payload: { cap: "spawn_children", limit: 4, observed: 3 },
  });
});

test("spend cap: a new session without a positive spend_cap is refused", () => {
  const guard = spendCapGuard();
  expect(guard.decide({ value: NEW_SESSION, params: null, when, service })).toEqual({
    verdict: "deny",
    payload: { cap: "spend_cap", reason: "new session requires spend_cap" },
  });
  expect(guard.decide({ value: { ...NEW_SESSION, spend_cap: 0 }, params: null, when, service })).toEqual({
    verdict: "deny",
    payload: { cap: "spend_cap", reason: "new session requires spend_cap" },
  });
  expect(guard.decide({ value: { ...NEW_SESSION, spend_cap: 2.5 }, params: null, when, service })).toEqual({
    verdict: "allow",
    payload: { cap: "spend_cap", granted: 2.5 },
  });
});

test("catalog reads: depth walks parent links, activeChildren counts live rows, absent session is undefined", () => {
  const rows = [
    { id: "root", parentId: null },
    { id: "mid", parentId: "root" },
    { id: "leaf", parentId: "mid" },
    { id: "leaf2", parentId: "mid" },
  ];
  const catalog = catalogDelegationReads(() => rows);
  expect(catalog.depth("root")).toBe(0);
  expect(catalog.depth("leaf")).toBe(2);
  expect(catalog.depth("ghost")).toBeUndefined();
  expect(catalog.activeChildren("mid")).toBe(2);
  expect(catalog.activeChildren("leaf")).toBe(0);
  expect(catalog.activeChildren("ghost")).toBeUndefined();
});

test("spawn_depth refuses the first spawn beyond the catalog parent-chain cap", () => {
  const rows = [
    { id: "root", parentId: null },
    { id: "child", parentId: "root" },
    { id: "grandchild", parentId: "child" },
    { id: "great-grandchild", parentId: "grandchild" },
  ];
  const guard = spawnDepthGuard(catalogDelegationReads(() => rows));
  const decide = (sessionId: string) =>
    guard.decide({
      value: NEW_SESSION,
      params: { limit: Gateway.DelegationCaps.maxDepth },
      when: { op: "send_message", sessionId },
      service,
    });
  for (const sessionId of ["root", "child", "grandchild"]) {
    expect(decide(sessionId).verdict).toBe("allow");
  }
  const denied = decide("great-grandchild");
  expect(denied.verdict).toBe("deny");
  if (denied.payload === null || typeof denied.payload !== "object" || Array.isArray(denied.payload))
    throw new Error("spawn depth refusal payload missing");
  expect(DelegationRefusal.parse(JSON.parse(String(denied.payload.reason)))).toEqual({
    code: "delegation_refused",
    cap: "spawn_depth",
    limit: Gateway.DelegationCaps.maxDepth,
    observed: Gateway.DelegationCaps.maxDepth,
  });
});

test("a finished child frees a spawn_children slot; a liveness read failure counts the child", () => {
  const rows = [
    { id: "parent", parentId: null },
    ...["a", "b", "c", "d"].map((id) => ({ id, parentId: "parent" })),
  ];
  const finished = new Set<string>();
  const catalog = catalogDelegationReads(
    () => rows,
    (childId) => {
      if (childId === "d") throw new Error("session store unreachable");
      return !finished.has(childId);
    },
  );
  const guard = spawnChildrenGuard(catalog);
  const decide = () =>
    guard.decide({ value: NEW_SESSION, params: null, when, service });
  // Four active children exhaust the cap.
  const exhausted = { code: "delegation_refused", cap: "spawn_children", limit: 4, observed: 4 };
  expect(decide()).toEqual({
    verdict: "deny",
    payload: {
      cap: "spawn_children",
      limit: 4,
      observed: 4,
      reason: JSON.stringify(exhausted),
    },
  });
  // One child finishes -> the next request succeeds (issue edge case).
  finished.add("a");
  expect(decide()).toEqual({
    verdict: "allow",
    payload: { cap: "spawn_children", limit: 4, observed: 3 },
  });
  // An unreadable child stays counted (conservative, cap stays tight).
  finished.add("b");
  finished.add("d");
  expect(decide()).toEqual({
    verdict: "allow",
    payload: { cap: "spawn_children", limit: 4, observed: 2 },
  });
});

test("the bundle contract carries the three tool.pre rows, their guards, and the deadline purpose", () => {
  const bundle = delegationPolicyBundle(SHIPPED_OWNER_POLICY.delegationRows);
  expect(bundle.requires.map((seam) => seam.key)).toEqual([
    "@oni/action/Action",
    "@oni/agent/capability/alarm",
    "@oni/oni/ToolCapabilitySeam",
  ]);
  expect(SHIPPED_OWNER_POLICY.delegationRows.map((row) => [row.on, row.how.ref])).toEqual([
    ["tool.pre", "delegation-policy/spawn-depth"],
    ["tool.pre", "delegation-policy/spawn-children"],
    ["tool.pre", "delegation-policy/spend-cap"],
  ]);
  expect(SHIPPED_OWNER_POLICY.delegationRows.every((row) => row.when.op === "send_message")).toBe(true);
  expect(Object.keys(bundle.handlers)).toEqual([
    "delegation-policy/spawn-depth",
    "delegation-policy/spawn-children",
    "delegation-policy/spend-cap",
  ]);
  expect(Object.keys(bundle.purposes)).toEqual([DELEGATION_DEADLINE]);
});

// ─── delegation.deadline wake ───

function fired(payload: string): Bundle.AlarmFired {
  return {
    occurrenceId: "alarm-1:1:deadline",
    purpose: DELEGATION_DEADLINE,
    alarmId: "alarm-1",
    armSeq: 1,
    sourceKey: "delegation:child-1",
    payload,
    fireAt: 5_000,
  };
}

function wakeContext(prompts: { content: string }[]): Bundle.AlarmPurposeHandler extends never
  ? never
  : Parameters<Bundle.AlarmPurposeHandler>[0]["ctx"] {
  return {
    sessionId: "parent",
    now: 5_000,
    reads: {
      latestArm: () => undefined,
      settled: () => false,
    },
    arm: () => Effect.die(new Error("deadline wake re-arms nothing")),
    prompt: (input) =>
      Effect.sync(() => {
        prompts.push({ content: input.content });
        return { seq: prompts.length };
      }),
  };
}

test("deadline fire cancels the silent child through the injected door and prompts the parent", async () => {
  const cancelled: { child: string; contact: string; occurrenceId: string }[] = [];
  const prompts: { content: string }[] = [];
  const handler = delegationPurposes({
    cancel: (input) =>
      Effect.sync(() => {
        cancelled.push(input);
        return "cancelled" as const;
      }),
  }).purposes[0]?.handler;
  if (handler === undefined) throw new Error("deadline purpose missing");
  const outcome = await runEffect(
    handler({
      fired: fired(JSON.stringify({ child: "child-1", contact: "session:child-1" })),
      ctx: wakeContext(prompts),
    }),
  );
  expect(outcome).toBe("delivered");
  // #1512: the armed contact rides to the cancel door, which routes a cli child to its pane's interrupt.
  expect(cancelled).toEqual([{ child: "child-1", contact: "session:child-1", occurrenceId: "alarm-1:1:deadline" }]);
  expect(prompts).toHaveLength(1);
  expect(JSON.parse(prompts[0]?.content ?? "")).toEqual({
    kind: DELEGATION_DEADLINE,
    contact: "session:child-1",
    child: "child-1",
    firedAt: 5_000,
    note: "deadline expired with no reply; the child was cancelled",
  });
});

test("#1512 r1 L1: a door that finds the turn already ended makes the fire a no-op — no expiry prompt, the chain lapses exhausted", async () => {
  const handler = delegationPurposes({ cancel: () => Effect.succeed("already_ended" as const) }).purposes[0]?.handler;
  if (handler === undefined) throw new Error("deadline purpose missing");
  const prompts: { content: string }[] = [];
  const outcome = await runEffect(
    handler({ fired: fired(JSON.stringify({ child: "child-1", contact: "cli:reviewer" })), ctx: wakeContext(prompts) }),
  );
  expect(outcome).toBe("exhausted");
  expect(prompts).toEqual([]);
});

test("a malformed payload or a refused cancel is the typed wake failure, never a silent success", async () => {
  const handler = delegationPurposes({
    cancel: () => Effect.fail({ reason: "entity door refused" }),
  }).purposes[0]?.handler;
  if (handler === undefined) throw new Error("deadline purpose missing");
  const prompts: { content: string }[] = [];
  await expect(
    runEffect(handler({ fired: fired("not json"), ctx: wakeContext(prompts) })),
  ).rejects.toMatchObject({ reason: "payload" });
  await expect(
    runEffect(
      handler({
        fired: fired(JSON.stringify({ child: "child-1", contact: "session:child-1" })),
        ctx: wakeContext(prompts),
      }),
    ),
  ).rejects.toMatchObject({ reason: "entity door refused" });
  expect(prompts).toEqual([]);
});

// ─── #1311 typed refusal + settleChild ───

test("a cap-denied creation carries the parseable delegation_refused payload for both caps", () => {
  const denied = [
    spawnDepthGuard(reads({ depth: 3 })).decide({ value: NEW_SESSION, params: { limit: 3 }, when, service }),
    spawnChildrenGuard(reads({ children: 4 })).decide({ value: NEW_SESSION, params: { limit: 4 }, when, service }),
  ];
  const refusals = denied.map((decision) => {
    expect(decision.verdict).toBe("deny");
    const payload = decision.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("cap decision payload missing");
    // The reason string IS the refusal: the consulted-guard seam carries it
    // verbatim into the caller's ToolRefused, so the model reads it typed.
    if (typeof payload.reason !== "string") throw new Error("cap refusal reason missing");
    return DelegationRefusal.parse(JSON.parse(payload.reason));
  });
  expect(refusals).toEqual([
    { code: "delegation_refused", cap: "spawn_depth", limit: 3, observed: 3 },
    { code: "delegation_refused", cap: "spawn_children", limit: 4, observed: 4 },
  ]);
});

function childRow(parentId: string | null): LedgerSession.Row {
  return LedgerSession.Row.parse({
    id: "child-1",
    parentId,
    role: "child",
    fenceOwner: "runtime",
    fence: 1,
    revision: 3,
    state: "idle",
  });
}

const TERMINAL: LedgerAction.Append = {
  id: "terminal-1",
  parentId: null,
  sessionId: "child-1",
  kind: "turn",
  intent: { encodingVersion: 1, value: { phase: "intent" } },
  effect: { encodingVersion: 1, value: { phase: "result" } },
  ts: 500,
  irreversible: true,
};

function settlementKernel(origin: Readonly<Record<string, string>>): Core.SessionKernel {
  const row = Delivery.Row.parse({
    id: "commission",
    sessionId: "child-1",
    kind: "prompt",
    content: "work",
    origin: { encodingVersion: 1, value: origin },
    status: "pending",
    consumedBy: null,
    consumedAt: null,
    createdAt: 100,
    ordinal: 1,
  });
  const stub: Pick<Core.SessionKernel, "inputMessages"> = { inputMessages: () => [row] };
  return stub as Core.SessionKernel;
}

const PARENT_ORIGIN = {
  kind: "message",
  messageId: "commission",
  senderSessionId: "parent-1",
  sourceActionId: "commission-action",
};

test("settleChild writes nothing for waiting and interrupted seals and for parentless sessions", () => {
  const kernel = settlementKernel(PARENT_ORIGIN);
  expect(
    settleChild(kernel, childRow("parent-1"), TERMINAL, {
      kind: "waiting",
      reason: "live_wait",
      alarmIds: [],
      text: "",
    }),
  ).toBeUndefined();
  expect(
    settleChild(kernel, childRow("parent-1"), TERMINAL, { kind: "interrupted", text: "half" }),
  ).toBeUndefined();
  expect(
    settleChild(kernel, childRow(null), TERMINAL, { kind: "result", text: "done" }),
  ).toBeUndefined();
});

test("settleChild settles result and failed seals as a bounded DelegationResult with the child pointer", () => {
  const kernel = settlementKernel(PARENT_ORIGIN);
  const completed = settleChild(kernel, childRow("parent-1"), TERMINAL, {
    kind: "result",
    text: "x".repeat(5000),
  });
  if (completed === undefined) throw new Error("completed settlement missing");
  expect(completed.delivery).toBe("followUp");
  expect(completed.terminal).toBe("completed");
  expect(completed.destinationSessionId).toBe("parent-1");
  expect(completed.requestId).toBe("commission-action");
  expect(completed.replyTo).toBe("commission");
  const envelope = Gateway.DelegationResult.parse(JSON.parse(completed.content));
  expect(envelope.status).toBe("completed");
  expect(envelope.preview).toBe("x".repeat(4096));
  expect(envelope.pointer).toEqual({ session: "child-1", action: "terminal-1" });
  const failed = settleChild(kernel, childRow("parent-1"), TERMINAL, {
    kind: "error",
    text: "CHILD_FAILURE",
  });
  if (failed === undefined) throw new Error("failed settlement missing");
  expect(failed.terminal).toBe("error");
  expect(Gateway.DelegationResult.parse(JSON.parse(failed.content))).toEqual({
    status: "failed",
    preview: "CHILD_FAILURE",
    pointer: { session: "child-1", action: "terminal-1" },
  });
});
