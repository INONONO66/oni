import { expect, test } from "bun:test";
import { Delivery, type LedgerAction, type LedgerSession } from "@oni/protocol";
import { liveDelegationRead, settleEndingLeases } from "../src/composition/delegation-leases";
import { materializeDeliveryTarget, messageMaterialization } from "../src/composition/message-session";
import { runEffect } from "./helpers/effect";
import { localDelivery, testPlane } from "./helpers/ledger";
import { testIds } from "./helpers/test-entropy";

const origin = {
  encodingVersion: 1,
  value: { kind: "message", messageId: "source-message", senderSessionId: "source", sourceActionId: "source-action" },
} as const;

function commit(id: string, createSession: LedgerSession.Materialize): Delivery.Commit {
  return Delivery.Commit.parse({
    id: `${id}:message`, sessionId: id, kind: "prompt", content: [{ kind: "text", text: "hello" }],
    origin, createdAt: 100, parentActionId: null, createSession,
    ...(createSession.row.parentId === null ? {} : { limits: { fanout: 4, depth: 2 } }),
  });
}

test("a delegation is live only as a catalogued child row with work in flight (#1841)", async () => {
  const plane = testPlane();
  const materialize = messageMaterialization(() => 1, testIds("materialize"));
  const session = (id: string, parentId: string | null, at: number): LedgerSession.Materialize =>
    materialize({ id, parentId, role: parentId === null ? "resident" : "child", tools: [], preset: "", runner: parentId === null ? "resident" : "child", at });
  const live = liveDelegationRead(plane.read);
  try {
    await runEffect(localDelivery(plane)(commit("parent", session("parent", null, 100))));
    await runEffect(materializeDeliveryTarget(plane, commit("idle-child", session("idle-child", "parent", 101)), () => 101));
    await runEffect(localDelivery(plane)(commit("busy-child", session("busy-child", "parent", 102))));
    expect(live("missing")).toBe(false);
    expect(live("parent")).toBe(false);
    expect(live("idle-child")).toBe(false);
    expect(live("busy-child")).toBe(true);
  } finally {
    plane.close();
  }
});

test("a settling delegation ends its leases before the settlement fold runs, every time it is folded", () => {
  const ended: string[] = [];
  const folded: string[] = [];
  const settle = settleEndingLeases(
    (_kernel, row, terminal, result) => { folded.push(`${row.id}:${terminal.id}:${result.kind}`); return undefined; },
    (delegationId) => { ended.push(delegationId); },
  );
  const row = { id: "child-1", parentId: "parent" } as LedgerSession.Row;
  const kernel = {} as Parameters<typeof settle>[0];
  const terminal = { id: "terminal-1" } as LedgerAction.Append;
  expect(settle(kernel, row, terminal, { kind: "result", text: "" })).toBeUndefined();
  expect(settle(kernel, row, terminal, { kind: "error", text: "boom" })).toBeUndefined();
  expect(ended).toEqual(["child-1", "child-1"]);
  expect(folded).toEqual(["child-1:terminal-1:result", "child-1:terminal-1:error"]);
});
