import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { runEffect } from "./helpers/effect";
import { expect, test } from "bun:test";
import { Gateway } from "@oni/protocol";
import { messageFixture } from "./helpers/message-fixture";
import type { AppLedgerPlane } from "../src/composition/cluster-runtime";

import { storageDirectories } from "./helpers/storage-directories";
import { actorMessage, ungrantedActor } from "./helpers/message-scenarios";

const directories = storageDirectories(true);

function registerTarget(plane: AppLedgerPlane) {
  plane.stores.actors.registerIdentity({ id: "target", kind: "human", trustTier: "owner" });
  plane.stores.actors.registerEndpoint({
    id: "ws:target",
    actorId: "target",
    channel: "ws",
    externalId: "target",
  });
}

test.each([
  "accepted",
  "rejected",
  "unknown",
] as const)("app composition preserves actor %s in the committed message terminal", async (value) => {
  const keys: string[] = [];
  const fixture = messageFixture("resident", {
    deliveryRoutes: new Map([
      [
        "ws",
        async (_id, _body, key) => {
          keys.push(key);
          return { value };
        },
      ],
    ]),
    grants: () => [
      { id: "grant", senderId: "sender", targetActorId: "target", operations: ["fire_and_forget"] },
    ],
    budgets: () => [
      { id: "budget", targetActorId: "target", maxPerWindow: 10, windowMs: 1000, cooldownMs: 0 },
    ],
  });
  directories.push(fixture.directory);
  registerTarget(fixture.plane);
  const result = await fixture.send(actorMessage("target"));
  expect(result.isError).not.toBe(true);
  const receipts = sessionTree(fixture.sessionId, fixture.plane.sessionStore(fixture.sessionId).actions).flatMap((action) => {
    const effect = action.effect.value;
    if (
      action.kind !== "message" ||
      effect === null ||
      typeof effect !== "object" ||
      Array.isArray(effect)
    )
      return [];
    const parsed = Gateway.IngestResult.safeParse(effect.result);
    return parsed.success ? [parsed.data] : [];
  });
  const receipt = receipts[0];
  if (receipt?.status !== "executed") throw new Error("expected one executed receipt");
  expect(keys).toEqual([receipt.handle.messageId]);
  expect(receipts).toEqual([{ status: "executed", handle: receipt.handle, delivery: { kind: "actor", value } }]);
  // #1600 lane R3: the tool's word follows the delivery — the handle for an accepted letter, the contact outcome for one the platform rejected or lost.
  const content = JSON.parse(String(result.content));
  if (value === "accepted") expect(Gateway.SendMessageHandle.parse(content)).toEqual(receipt.handle);
  else expect(content).toEqual({ contact: "target", status: value === "rejected" ? "not_sent" : "unknown", reason: expect.any(String) });
});

test("ungranted app actor send is a compiled pre-denial, never an executed delivery", async () => {
  const { fixture, calls } = ungrantedActor("resident");
  directories.push(fixture.directory);
  registerTarget(fixture.plane);
  const result = await fixture.send(actorMessage("target"));
  expect(result.isError).toBe(true);
  expect(result.content).toContain("message.resident.actor_grant");
  expect(calls()).toBe(0);
  const senderTree = () =>
    sessionTree(fixture.sessionId, fixture.plane.sessionStore(fixture.sessionId).actions);
  expect(senderTree().filter((action) => action.kind === "message")).toEqual([]);
  expect(senderTree().some((action) => action.kind === "policy.decision")).toBe(true);
});

test("app ingress applies the channel default tier as policy facts, not top-level authority", async () => {
  const fixture = messageFixture();
  directories.push(fixture.directory);
  fixture.plane.stores.channelGrants.put({
    id: "observer",
    surface: "discord",
    kind: "trusted_channel",
    defaultTier: "observer",
    createdBy: "owner",
  });
  expect(
    await runEffect(fixture.gateway.ingest(
      { kind: "external", surface: "discord", externalId: "guest" },
      {
        eventId: "guest",
        surface: "discord",
        channelId: "public",
        addressees: [],
        dm: false,
        payload: "instruction",
        render: "instruction",
      },
    )),
  ).toEqual({ status: "blocked_pre", reasonCode: "message.external.grant_tier" });
  expect(
    fixture.plane
      .listSessions()
      .flatMap((row) =>
        sessionTree(row.id, fixture.plane.sessionStore(row.id).actions).filter(
          (action) => action.kind === "prompt",
        ),
      ),
  ).toEqual([]);
});

test("#1600: a surface's declared default tier admits a stranger at that tier — the grant_tier row passes manager", async () => {
  const fixture = messageFixture();
  directories.push(fixture.directory);
  fixture.plane.stores.channelGrants.put({
    id: "manager",
    surface: "discord",
    kind: "trusted_channel",
    defaultTier: "manager",
    createdBy: "owner",
  });
  expect(
    (await runEffect(fixture.gateway.ingest(
      { kind: "external", surface: "discord", externalId: "guest" },
      { eventId: "guest-2", surface: "discord", channelId: "public", addressees: [], dm: false, payload: "instruction", render: "instruction" },
    ))).status,
  ).toBe("executed");
  expect(
    fixture.plane
      .listSessions()
      .flatMap((row) => sessionTree(row.id, fixture.plane.sessionStore(row.id).actions).filter((action) => action.kind === "prompt")),
  ).toHaveLength(1);
});
