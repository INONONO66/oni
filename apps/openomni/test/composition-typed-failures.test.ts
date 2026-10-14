import { expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import type { Core } from "@openomni/agent";
type CommitReceipt = Core.CommitReceipt;
import type { LedgerSession } from "@openomni/protocol";
import { createIngressExecutor, GATEWAY_INGRESS_SESSION } from "../src/composition/ingress-executor";
import { messageMaterialization, prepareMessage } from "../src/composition/message-session";
import type { AppLedgerPlane } from "../src/composition/cluster-runtime";
import { seedKernelPolicyRows } from "../src/composition/policy";
import { generationServices } from "./helpers/generation-services";
import { adoptTestFence, testPlane } from "./helpers/ledger";
import { runEffect, runSyncEffect, acquireSyncEffect } from "./helpers/effect";
import { testIds } from "./helpers/test-entropy";

function materialize(plane: AppLedgerPlane) {
  return (id: string, parentId: string | null, role: LedgerSession.Role, runner: string) =>
    messageMaterialization(() => plane.openKernel(id).currentPolicyGeneration(), testIds("typed-materialize"))({
      id, parentId, role, runner, tools: [], preset: "", at: 100,
    });
}

/** A materialized sender row, optionally under an adopted fence. */
function sender(plane: AppLedgerPlane, leased: boolean): void {
  const kernel = plane.openKernel("sender");
  runSyncEffect(kernel.materialize({
    id: "sender", parentId: null, role: "resident", tools: [], bundles: [],
    system: { preset: "", blocks: [] }, policyGeneration: 1,
    actionId: crypto.randomUUID(), at: 100,
  }));
  plane.catalog.indexSession({ id: "sender", parentId: null, role: "resident", createdAt: 100 });
  if (leased) runSyncEffect(adoptTestFence(kernel, "sender", "owner"));
}

test("message preparation fails in the typed admission channel without a sender lease", () => {
  const plane = testPlane();
  sender(plane, false);
  try {
    const failure = runSyncEffect(Effect.flip(prepareMessage(plane, materialize(plane))(
      { kind: "session", id: "sender" },
      { to: { kind: "session", id: "sender" }, type: "message", content: "hello" },
      "sender", "message",
    )));
    expect(failure._tag).toBe("SendAdmissionConflict");
  } finally {
    plane.close();
  }
});

test("child preparation refuses a pinned policy without admission bounds", () => {
  const plane = testPlane();
  sender(plane, true);
  try {
    const failure = runSyncEffect(Effect.flip(prepareMessage(plane, materialize(plane))(
      { kind: "session", id: "sender" },
      { to: { kind: "new_session", role: "child", runner: "child", parent: "me" }, type: "message", content: "hello" },
      "child", "message",
    )));
    expect(failure._tag).toBe("SendAdmissionConflict");
    expect(plane.listSessions().map((row: LedgerSession.Row) => row.id)).toEqual(["sender"]);
  } finally {
    plane.close();
  }
});

// W5.2: the alarm child's lifecycle tests left with the child itself — the
// entity mailbox owns wake delivery now (see the receipt for the deletions).

test("ingress admission creates and indexes the perimeter session once; a second boot reuses it", () => {
  // #1346 boundary: `createIngressExecutor` goes through `Core.createSession`
  // (genesis + catalog index in one write) and treats an existing perimeter
  // session as the idempotent outcome rather than a second materialization.
  const plane = testPlane();
  seedKernelPolicyRows(plane.catalog.policies);
  const services = acquireSyncEffect(generationServices({ clock: () => 100, plane }));
  try {
    expect(plane.catalog.sessionIndex(GATEWAY_INGRESS_SESSION)).toBeUndefined();
    runSyncEffect(createIngressExecutor(plane).pipe(Effect.provide(services)));
    const kernel = plane.openKernel(GATEWAY_INGRESS_SESSION);
    const genesis = kernel.latestAction(GATEWAY_INGRESS_SESSION);
    expect(genesis?.kind).toBe("session.configure");
    expect(kernel.row(GATEWAY_INGRESS_SESSION).revision).toBe(1);
    expect(plane.catalog.sessionIndex(GATEWAY_INGRESS_SESSION)).toMatchObject({
      id: GATEWAY_INGRESS_SESSION, parentId: null, role: "resident",
    });
    runSyncEffect(createIngressExecutor(plane).pipe(Effect.provide(services)));
    expect(kernel.row(GATEWAY_INGRESS_SESSION).revision).toBe(1);
    expect(kernel.latestAction(GATEWAY_INGRESS_SESSION)?.id).toBe(genesis?.id);
    expect(plane.listSessions().map((row) => row.id)).toEqual([GATEWAY_INGRESS_SESSION]);
  } finally {
    plane.close();
  }
});

test("ingress commit without a receipt becomes a typed corrupt-record commit failure", async () => {
  const plane = testPlane();
  seedKernelPolicyRows(plane.catalog.policies);
  const services = acquireSyncEffect(generationServices({ clock: () => 100, plane }));
  const kernel = plane.openKernel(GATEWAY_INGRESS_SESSION);
  const ingress = runSyncEffect(createIngressExecutor(plane).pipe(Effect.provide(services)));
  const commit = kernel.commit;
  const broken = spyOn(kernel, "commit").mockImplementation((input: LedgerSession.Commit) =>
    commit(input).pipe(Effect.map((receipt: CommitReceipt) => ({ ...receipt, receipts: [] }))),
  );
  try {
    const failure = await runEffect(Effect.flip(ingress(
      { kind: "external", surface: "ws", externalId: "owner" },
      { kind: "message", op: "send", intent: {}, effect: {}, message: { sender: "external", eventIdUnique: true, addressee: "bot", identity: true, grantTier: true, egressBudget: true, replyCorrelation: true } },
      () => Effect.succeed(null),
    )));
    expect(failure._tag).toBe("CommitFailed");
    if (failure._tag === "CommitFailed") expect(failure.error._tag).toBe("CorruptRecord");
  } finally {
    broken.mockRestore();
    plane.close();
  }
});
