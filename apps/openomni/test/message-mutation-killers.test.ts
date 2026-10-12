import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { Effect } from "effect";
import { runEffect, runSyncEffect } from "./helpers/effect";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Bus } from "./helpers/bus";
import { join } from "node:path";
import { createSurfaceKeyStore } from "@openomni/channels";
import { canonicalDigest, Gateway } from "@openomni/protocol";
import { messageFixture } from "./helpers/message-fixture";
import { sessionFilePath, type AppLedgerPlane } from "../src/composition/cluster-runtime";
import { messageMaterialization, prepareMessage } from "../src/composition/message-session";
import { commitReceivedMessage } from "../../../packages/agent/test/helpers/ingress";

import { storageDirectories } from "./helpers/storage-directories";
import { actorMessage, ungrantedActor } from "./helpers/message-scenarios";
import { testIds } from "./helpers/test-entropy";

const directories = storageDirectories(true);

/** The per-session ledger file a fixture session commits into (W5.2). */
function sessionDb(fixture: { directory: string }, sessionId: string) {
  return sessionFilePath(join(fixture.directory, "sessions"), sessionId);
}

function tree(plane: AppLedgerPlane, sessionId: string) {
  return sessionTree(sessionId, plane.sessionStore(sessionId).actions);
}

function promptActions(plane: AppLedgerPlane, sessionId: string) {
  return tree(plane, sessionId).filter((action) => action.kind === "prompt");
}

function awaitedActorFixture() {
  const fixture = messageFixture("resident", {
    deliveryRoutes: new Map([
      ["ws", async () => ({ value: "accepted" as const, externalMessageId: "platform-reply" })],
    ]),
    grants: () => [
      { id: "grant", senderId: "sender", targetActorId: "alice", operations: ["awaited"] },
    ],
    budgets: () => [
      { id: "budget", targetActorId: "alice", maxPerWindow: 10, windowMs: 1000, cooldownMs: 0 },
    ],
  });
  directories.push(fixture.directory);
  fixture.plane.stores.actors.registerIdentity({ id: "alice", kind: "human", trustTier: "owner" });
  fixture.plane.stores.actors.registerEndpoint({
    id: "ws:alice",
    actorId: "alice",
    channel: "ws",
    externalId: "alice",
  });
  return fixture;
}

function awaitedActorSend(fixture: ReturnType<typeof awaitedActorFixture>) {
  return fixture.send({
    to: { kind: "actor", actorId: "alice" },
    type: "message",
    content: "question",
    replyTo: "binding",
    deadline: 200,
  });
}

test("child actor send is blocked by a compiled B row before transport", async () => {
  const { fixture, calls } = ungrantedActor("child");
  directories.push(fixture.directory);
  const result = await fixture.send(actorMessage("outside"));
  expect(result.isError).toBe(true);
  expect(result.content).toContain("message.child.actor");
  expect(calls()).toBe(0);
});

// W5.2 L3.3b: "new child configuration and first delivery roll back together on
// an delivery insertion fault" is deleted with the single-DB delivery table. Child
// materialization is now an idempotent catalog/session-file fact applied
// before entity delivery; a failed delivery leaves the (reusable) session row
// in place by design, so the joint-rollback invariant no longer exists.

test("duplicate external event does not commit a second delivery message", async () => {
  const fixture = messageFixture();
  directories.push(fixture.directory);
  const sender = { kind: "external", surface: "ws", externalId: "owner" } as const;
  const facts = {
    eventId: "same-event",
    surface: "ws",
    channelId: "owner",
    addressees: [],
    dm: true,
    payload: {},
    render: "hello",
  };
  const first = await runEffect(fixture.gateway.ingest(sender, facts));
  const repeated = await runEffect(fixture.gateway.ingest(sender, facts));
  expect(first.status).toBe("executed");
  expect(repeated).toMatchObject({
    status: "blocked_pre",
    reasonCode: "message.external.event_id_dedupe",
  });
  if (first.status !== "executed") throw new Error("first message not executed");
  expect(promptActions(fixture.plane, first.handle.target)).toHaveLength(1);
});

test("external ingress retry after delivery fault commits once despite a recorded route", async () => {
  const fixture = messageFixture();
  directories.push(fixture.directory);
  const sender = { kind: "external", surface: "ws", externalId: "owner" } as const;
  const facts = {
    eventId: "retry",
    surface: "ws",
    channelId: "owner",
    addressees: [],
    dm: true,
    payload: {},
    render: "hello",
  };
  // Learn the durable target first: the fault must land on that session's
  // ledger file, where W5.2 commits received messages as prompt actions.
  const probe = await runEffect(fixture.gateway.ingest(sender, { ...facts, eventId: "probe" }));
  if (probe.status !== "executed") throw new Error("probe message not executed");
  const db = new Database(sessionDb(fixture, probe.handle.target));
  try {
    db.exec(
      "CREATE TRIGGER fail_external BEFORE INSERT ON action WHEN NEW.kind = 'prompt' BEGIN SELECT RAISE(ABORT, 'delivery fault'); END",
    );
    await expect(runEffect(fixture.gateway.ingest(sender, facts))).rejects.toMatchObject({
      _tag: "ChannelsFailure",
    });
    db.exec("DROP TRIGGER fail_external");
    const result = await runEffect(fixture.gateway.ingest(sender, facts));
    expect(result.status).toBe("executed");
    if (result.status !== "executed") throw new Error("retry was not committed");
    expect(result.handle.target).toBe(probe.handle.target);
    expect(promptActions(fixture.plane, result.handle.target)).toHaveLength(2);
  } finally {
    db.close();
  }
});

test("conversation correlation cannot select the physical default session", async () => {
  const fixture = messageFixture();
  directories.push(fixture.directory);
  createSurfaceKeyStore(fixture.plane.channel).claim("ws:unrelated-conversation", fixture.sessionId);
  const result = await runEffect(
    fixture.gateway.ingest(
      { kind: "external", surface: "ws", externalId: "owner" },
      {
        eventId: "physical",
        surface: "ws",
        channelId: "physical-owner",
        addressees: [],
        dm: true,
        reply: { chain: [], externalConversationId: "ws:unrelated-conversation" },
        payload: {},
        render: "hello",
      },
    ),
  );
  expect(result.status).toBe("executed");
  if (result.status !== "executed") throw new Error("message was not committed");
  expect(result.handle.target).not.toBe(fixture.sessionId);
});

// W5.2 S6: typed failures now render their carried cause, so each corruption
// case surfaces its own refusal text; the kernel evidence seam the gateway
// consults (`policyDecisionRuleIds`) still distinguishes them durably.
test.each([
  {
    mutation: "json_set(intent, '$.matchedRuleIds', json_array(42))",
    error: "invalid message decision rule identity",
  },
  { mutation: "json_remove(intent, '$.inputHash')", error: "message pre decision is missing" },
])("corrupted persisted policy evidence is refused: %j", async ({ mutation, error }) => {
  const fixture = messageFixture();
  directories.push(fixture.directory);
  using db = new Database(sessionDb(fixture, fixture.sessionId));
  // Stash each decision's pre-corruption intent so the original inputHash
  // stays addressable after the mutation removes or breaks it.
  db.exec("CREATE TABLE corrupt_keep (id TEXT PRIMARY KEY, intent TEXT NOT NULL)");
  db.exec(
    `CREATE TRIGGER corrupt_decision AFTER INSERT ON action WHEN NEW.kind = 'policy.decision' BEGIN INSERT INTO corrupt_keep VALUES (NEW.id, NEW.intent); UPDATE action SET intent = ${mutation} WHERE id = NEW.id; END`,
  );
  const result = await fixture.send({
    to: { kind: "new_session", role: "child", runner: "native", parent: "me" },
    type: "message",
    content: "corrupt-evidence",
  });
  expect(result.isError).toBe(true);
  expect(result.content).toContain(error);
  const stashed = db
    .query("SELECT json_extract(intent, '$.inputHash') AS hash FROM corrupt_keep")
    .all() as { hash: string }[];
  expect(stashed.length).toBeGreaterThan(0);
  const kernel = fixture.plane.openKernel(fixture.sessionId);
  if (error === "invalid message decision rule identity") {
    // The corrupted evidence is still addressable and refuses on read-back.
    expect(() => kernel.policyDecisionRuleIds(fixture.sessionId, stashed[0]?.hash ?? "")).toThrow(
      "invalid message decision rule identity",
    );
  } else {
    // The evidence key is gone: every recorded decision is unaddressable,
    // which is exactly the "message pre decision is missing" refusal.
    for (const row of stashed)
      expect(kernel.policyDecisionRuleIds(fixture.sessionId, row.hash)).toBeUndefined();
  }
});

test("message observations carry the committed compiled policy rule identity", async () => {
  const fixture = messageFixture("child");
  directories.push(fixture.directory);
  const observed = Promise.withResolvers<Gateway.MessageObservation>();
  const unsubscribe = Bus.subscribe(Gateway.MessageObserved, (event) => {
    if (event.kind === "message.rejected") observed.resolve(event);
  });
  try {
    await fixture.send({
      to: { kind: "actor", actorId: "outside" },
      type: "message",
      content: "hello",
    });
    expect(await observed.promise).toMatchObject({
      kind: "message.rejected",
      matchedRuleIds: ["message.child.actor"],
    });
    expect(
      tree(fixture.plane, fixture.sessionId).some(
        (action) => action.kind === "policy.decision",
      ),
    ).toBe(true);
  } finally {
    unsubscribe();
  }
});

test("an actor answer preserves platform correlation and wins its durable message deadline", async () => {
  const fixture = awaitedActorFixture();
  const sent = await awaitedActorSend(fixture);
  expect(sent.isError).not.toBe(true);
  // W5.2: the durable deadline fact is the open request's own bound; the
  // alarm-row plane it once mirrored is gone.
  const senderKernel = fixture.plane.openKernel(fixture.sessionId);
  const armed = senderKernel
    .requestRows(fixture.sessionId)
    .filter((row) => row.state === "open" && row.deadline !== null && row.deadline <= 200);
  expect(armed).toHaveLength(1);
  const reply = await runEffect(
    fixture.gateway.ingest(
      { kind: "external", surface: "ws", externalId: "alice" },
      {
        eventId: "answer",
        surface: "ws",
        channelId: "alice",
        addressees: [],
        dm: true,
        reply: { replyToMessageId: "platform-reply", chain: ["platform-reply"] },
        payload: {},
        render: "answer",
      },
    ),
  );
  expect(reply.status).toBe("executed");
  expect(promptActions(fixture.plane, fixture.sessionId).at(-1)?.intent.value).toMatchObject({
    kind: "external_reply",
  });
  for (const request of senderKernel
    .requestRows(fixture.sessionId)
    .filter((row) => row.deadline !== null && row.deadline <= 200)) {
    fixture.requests.timeout(request.requestId, 200);
  }
  expect(senderKernel.requestRows(fixture.sessionId)[0]?.state).toBe("resolved");
});

function materialize(
  plane: AppLedgerPlane,
  id: string,
  parentId: string | null = null,
  role: "resident" | "child" = "resident",
) {
  const kernel = plane.openKernel(id);
  runSyncEffect(
    kernel.materialize({
      id,
      parentId,
      role,
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: kernel.currentPolicyGeneration(),
      actionId: `${id}:config`,
      at: 100,
    }),
  );
  plane.catalog.indexSession({ id, parentId, role, createdAt: 100 });
}

for (const check of ["parent", "fanout", "depth", "deadline"] as const) {
  test(`real compiled B ${check} refuses the violating session request`, async () => {
    const f = messageFixture();
    directories.push(f.directory);
    using db = new Database(sessionDb(f, f.sessionId));
    let send: Gateway.SendMessage;
    if (check === "parent") {
      materialize(f.plane, "unrelated");
      send = { to: { kind: "session", id: "unrelated" }, type: "message", content: "NO" };
    } else if (check === "fanout") {
      for (let i = 0; i < 8; i++) materialize(f.plane, `child-${i}`, f.sessionId, "child");
      send = {
        to: { kind: "new_session", role: "child", runner: "native", parent: "me" },
        type: "message",
        content: "NO",
      };
    } else if (check === "depth") {
      for (let i = 0; i < 3; i++)
        materialize(f.plane, `ancestor-${i}`, i === 0 ? null : `ancestor-${i - 1}`);
      db.query("UPDATE session SET parent_id = ? WHERE id = ?").run("ancestor-2", f.sessionId);
      send = {
        to: { kind: "new_session", role: "child", runner: "native", parent: "me" },
        type: "message",
        content: "NO",
      };
    } else {
      materialize(f.plane, "parent");
      db.query("UPDATE session SET parent_id = ? WHERE id = ?").run("parent", f.sessionId);
      const action = f.plane.sessionStore("parent").actions.append(
        {
          id: "parent:request",
          parentId: "parent:config",
          sessionId: "parent",
          kind: "message",
          intent: {
            encodingVersion: 1,
            value: {
              phase: "intent",
              value: { messageId: "bound-request" },
              effectHash: canonicalDigest({}),
            },
          },
          effect: { encodingVersion: 1, value: { phase: "pending" } },
          ts: 100,
          irreversible: true,
        },
        f.plane.openKernel("parent").row("parent").revision,
      );
      if (action === undefined) throw new Error("parent request intent missing");
      await runEffect(
        f.requests.open({
          requestId: action.action.id,
          sessionId: "parent",
          expectedResponders: [f.sessionId],
          correlation: {},
          allowedActions: ["report_result"],
          resolution: "first",
          threshold: 1,
          deadline: 150,
          at: 100,
        }),
      );
      send = {
        to: { kind: "session", id: "parent" },
        type: "message",
        content: "NO",
        deadline: 151,
      };
    }
    // W5.2: pre-turn backlog drains into the turn before the model runs, so
    // the inherited deadline only binds a message still pending mid-turn. The
    // bound request arrives inside the running turn (riding the live
    // owner+fence — an out-of-band fence adoption would revoke the handle).
    const midTurn =
      check === "deadline"
        ? commitReceivedMessage(f.plane.openKernel(f.sessionId), {
            id: "bound-request",
            sessionId: f.sessionId,
            kind: "prompt",
            content: "work",
            createdAt: 100,
            parentActionId: null,
            origin: {
              encodingVersion: 1,
              value: {
                kind: "message",
                messageId: "bound-request",
                senderSessionId: "parent",
                sourceActionId: "parent:request",
                deadline: 150,
              },
            },
          }).pipe(Effect.asVoid, Effect.orDie)
        : undefined;
    const result = await f.send(send, midTurn);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(`message.resident.${check}`);
  });
}

test("real compiled B child cannot interrupt its parent", async () => {
  const f = messageFixture("child");
  directories.push(f.directory);
  materialize(f.plane, "parent");
  using db = new Database(sessionDb(f, f.sessionId));
  db.query("UPDATE session SET parent_id = ? WHERE id = ?").run("parent", f.sessionId);
  const result = await f.send({
    to: { kind: "session", id: "parent" },
    type: "interrupt",
    content: "NO",
  });
  expect(result.isError).toBe(true);
  expect(result.content).toContain("message.child.interrupt_parent");
  expect(promptActions(f.plane, "parent")).toEqual([]);
});

test("an external reply to an awaited message admits with the correlated reply origin", async () => {
  const fixture = awaitedActorFixture();
  const sent = await awaitedActorSend(fixture);
  expect(sent.isError).not.toBe(true);
  const db = new Database(sessionDb(fixture, fixture.sessionId));
  const correlated = db
    .query(
      `SELECT id, json_extract(intent, '$.value.messageId') AS messageId FROM action
       WHERE session_id = ? AND kind = 'message'
       AND json_extract(intent, '$.value.messageId') IS NOT NULL ORDER BY ordinal LIMIT 1`,
    )
    .get(fixture.sessionId) as { id: string; messageId: string } | null;
  db.close();
  if (correlated === null) throw new Error("missing correlatable message action");
  const messageId = correlated.messageId;
  const prepare = prepareMessage(fixture.plane, (id, parentId, childRole, runner) =>
    messageMaterialization(() => fixture.plane.openKernel(id).currentPolicyGeneration(), testIds("mutation-materialize"))({
      id,
      parentId,
      role: childRole,
      runner,
      tools: [],
      preset: "",
      at: 100,
    }),
  );
  const prepared = runSyncEffect(
    prepare(
      { kind: "external", surface: "ws", externalId: "alice" },
      {
        to: { kind: "session", id: fixture.sessionId },
        type: "message",
        content: "answer",
        replyTo: messageId,
      },
      fixture.sessionId,
      "correlated-answer",
    ),
  );
  expect(prepared.createSession).toBeUndefined();
  expect(prepared.message).toEqual({ sender: "external", eventIdUnique: true });
  expect(prepared.origin).toMatchObject({
    kind: "external_reply",
    messageId,
    sourceActionId: correlated.id,
    replyTo: messageId,
  });
});
