import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { runEffect } from "./helpers/effect";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Bus } from "./helpers/bus";
import { createChannelStores } from "@oni/channels";
import { Gateway, L0Observation } from "@oni/protocol";
import { join } from "node:path";
import { channelStoreSource } from "../src/gateway";
import { sessionFilePath, type AppLedgerPlane } from "../src/composition/cluster-runtime";
import { messageFixture } from "./helpers/message-fixture";

import { storageDirectories } from "./helpers/storage-directories";
import { actorPolicy } from "./helpers/message-scenarios";
import { testClock } from "./helpers/test-entropy";

const directories = storageDirectories(true);

function registerPeer(plane: AppLedgerPlane) {
  plane.stores.actors.registerIdentity({ id: "peer", kind: "human", trustTier: "owner" });
  plane.stores.actors.registerEndpoint({
    id: "ws:peer",
    actorId: "peer",
    channel: "ws",
    externalId: "peer",
  });
}
const sessionDb = (fixture: { directory: string }, sessionId: string) =>
  sessionFilePath(join(fixture.directory, "sessions"), sessionId);
/** Received-message evidence: prompt actions in the target's chain (W5.2). */
function promptContents(plane: AppLedgerPlane, sessionId: string): string[] {
  return sessionTree(sessionId, plane.sessionStore(sessionId).actions)
    .filter((action) => action.kind === "prompt")
    .map((action) => (action.effect.value as { content?: string }).content ?? "");
}
const sender = { kind: "external", surface: "ws", externalId: "peer" } as const;
const facts = {
  eventId: "answer",
  surface: "ws",
  channelId: "peer",
  dm: true,
  addressees: [],
  payload: {},
  render: "ANSWER",
};

for (const mode of ["ancestor", "nearer", "ambiguous"] as const) {
  test(`complete reply chain selects ${mode} through the compiled gateway`, async () => {
    let sequence = 0;
    const fixture = messageFixture("resident", {
      deliveryRoutes: new Map([
        [
          "ws",
          async () => ({
            value: "accepted" as const,
            externalMessageId: `platform-${mode === "ambiguous" ? 1 : ++sequence}`,
          }),
        ],
      ]),
      ...actorPolicy("peer", 20),
    });
    directories.push(fixture.directory);
    registerPeer(fixture.plane);
    for (let index = 0; index < 2; index++)
      expect(
        (
          await fixture.send({
            to: { kind: "actor", actorId: "peer" },
            type: "message",
            content: `Q${index}`,
            deadline: 1000,
          })
        ).isError,
      ).not.toBe(true);
    const receipt = await runEffect(fixture.gateway.ingest(sender, {
      ...facts,
      reply: {
        replyToMessageId: "unrelated-immediate",
        chain: ["unrelated-immediate", ...(mode === "nearer" ? ["platform-2"] : []), "platform-1"],
      },
    }));
    if (mode === "ambiguous") {
      expect(receipt.status).toBe("blocked_pre");
      expect(promptContents(fixture.plane, "sender").includes("ANSWER")).toBe(false);
      return;
    }
    expect(receipt).toMatchObject({ status: "executed", handle: { target: "sender" } });
    expect(promptContents(fixture.plane, "sender").at(-1)).toBe("ANSWER");
    const resolved = fixture.plane.openKernel("sender").requestRows("sender").filter(
      (request) => request.state === "resolved",
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.correlation.replyToMessageId).toBe(
      mode === "nearer" ? "platform-2" : "platform-1",
    );
  });
}

for (const refuse of [false, true]) {
  test(`actor deadline and send admission ${refuse ? "roll back together" : "commit before delivery"}`, async () => {
    const paths = { ingress: "", sender: "" };
    let deliveries = 0;
    const fixture = messageFixture("resident", {
      deliveryRoutes: new Map([
        [
          "ws",
          async () => {
            deliveries += 1;
            // W5.2: the admission facts live in two session files; both must be
            // durable before any physical delivery runs.
            using ingress = new Database(paths.ingress, { readonly: true });
            using senderFile = new Database(paths.sender, { readonly: true });
            expect(
              ingress
                .query<{ n: number }, []>(
                  "SELECT COUNT(*) AS n FROM decision_fact WHERE key LIKE 'gateway_send:%'",
                )
                .get()?.n,
            ).toBe(1);
            expect(
              senderFile
                .query<{ n: number }, []>(
                  "SELECT COUNT(*) AS n FROM action WHERE kind = 'request' AND json_extract(effect, '$.resolution') = 'opened'",
                )
                .get()?.n,
            ).toBe(1);
            return { value: "accepted" as const };
          },
        ],
      ]),
      ...actorPolicy("peer", 10),
    });
    directories.push(fixture.directory);
    paths.ingress = sessionDb(fixture, "gateway-ingress");
    paths.sender = sessionDb(fixture, fixture.sessionId);
    registerPeer(fixture.plane);
    using db = new Database(paths.ingress);
    if (refuse)
      db.exec(
        "CREATE TRIGGER refuse_admission BEFORE INSERT ON decision_fact BEGIN SELECT RAISE(ABORT, 'admission fault'); END",
      );
    const result = await fixture.send({
      to: { kind: "actor", actorId: "peer" },
      type: "message",
      content: "question",
      deadline: 200,
    });
    expect(result.isError === true).toBe(refuse);
    expect(deliveries).toBe(refuse ? 0 : 1);
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM decision_fact WHERE key LIKE 'gateway_send:%'",
        )
        .get()?.n,
    ).toBe(refuse ? 0 : 1);
    const senderKernel = fixture.plane.openKernel(fixture.sessionId);
    expect(senderKernel.requestRows(fixture.sessionId)).toHaveLength(refuse ? 0 : 1);
    if (!refuse) {
      // The deadline rides the request row itself now; no separate alarm fact.
      expect(senderKernel.requestRows(fixture.sessionId)[0]?.deadline).toBe(200);
    }
    using catalogDb = new Database(join(fixture.directory, "catalog.sqlite"), { readonly: true });
    // W5.2 accepted seam: the egress debit is a catalog write on its own
    // connection, claimed before the admission fact, so a refused admission
    // leaves the (idempotent, messageId-keyed) debit behind.
    expect(catalogDb.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM egress_debit").get()?.n).toBe(1);
  });
}

test("child admission observations see the deadline before the child's delivery commit", async () => {
  const fixture = messageFixture();
  directories.push(fixture.directory);
  const visible: Array<{ deadline: number | null | undefined }> = [];
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind !== "prompt" || event.sessionId === "sender") return;
    // W5.2: by the time the child's prompt commits in its own session file,
    // the sender's deadline-bearing request must already be durable.
    visible.push({
      deadline: fixture.plane
        .openKernel("sender")
        .requestRows("sender")
        .find((request) => request.state === "open")?.deadline,
    });
  });
  try {
    expect(
      (
        await fixture.send({
          to: { kind: "new_session", role: "child", runner: "native", parent: "me" },
          type: "message",
          content: "work",
          deadline: 200,
        })
      ).isError,
    ).not.toBe(true);
    expect(visible).toEqual([{ deadline: 200 }]);
  } finally {
    unsubscribe();
  }
});

for (const restriction of ["dnc", "zero", "spent", "allowed"] as const) {
  test(`Table A projects live ${restriction} budget without debiting ingress`, async () => {
    let reads = 0;
    const fixture = messageFixture("resident", {
      deliveryRoutes: new Map(),
      grants: () => [],
      budgets: () => {
        reads += 1;
        return [
          {
            id: "budget",
            targetActorId: "peer",
            maxPerWindow: restriction === "zero" ? 0 : 1,
            windowMs: 1000,
            cooldownMs: 0,
            doNotContact: restriction === "dnc",
          },
        ];
      },
    });
    directories.push(fixture.directory);
    registerPeer(fixture.plane);
    const observations: Gateway.MessageObservation[] = [];
    const unsubscribe = Bus.subscribe(Gateway.MessageObserved, (event) => observations.push(event));
    try {
      const initial = await runEffect(fixture.gateway.ingest(sender, { ...facts, eventId: "first" }));
      let receipt = initial;
      if (restriction === "spent") {
        if (initial.status !== "executed") throw new Error("initial admission refused");
        createChannelStores(channelStoreSource(fixture.plane, testClock())).egressBudgets.claim(
          {
            id: "spent",
            senderId: initial.handle.target,
            targetActorId: "peer",
            class: "converse",
            at: 100,
          },
          0,
          () => "allow",
        );
        receipt = await runEffect(fixture.gateway.ingest(sender, { ...facts, eventId: "second" }));
      }
      expect(reads).toBeGreaterThan(0);
      expect(receipt.status).toBe(restriction === "allowed" ? "executed" : "blocked_pre");
      if (restriction !== "allowed")
        expect(observations).toContainEqual(
          expect.objectContaining({
            kind: "message.rejected",
            matchedRuleIds: ["message.external.egress_budget"],
          }),
        );
      using db = new Database(join(fixture.directory, "catalog.sqlite"));
      expect(
        db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM egress_debit").get()?.count,
      ).toBe(restriction === "spent" ? 1 : 0);
    } finally {
      unsubscribe();
    }
  });
}
