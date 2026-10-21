import { ledger } from "../helpers/ledger";
import { sessionTree } from "../../../agent/test/store/helpers/session-tree";
import { beforeEach, expect, test } from "bun:test";
import { runEffect } from "../helpers/effect";
import { Effect, } from "effect";
import { effectFailure } from "../helpers/effect-failure";
import { replaceDecisionFacts } from "../helpers/ledger";
import { endpointFacts } from "../../src/router/endpoint-facts";
import { Channel, Ingress, type Delivery, type DecisionFact } from "@oni/protocol";
import { Bus } from "../helpers/observation";
import { commits, createMappedOwnerSession, makeRouter, ownerEvent, ownerFacts, ownerSender, registerOwnerDm, resetRouterState, routingDecisions, } from "./_router-fixture";

const streamId = () => Ingress.routeStreamId(ownerEvent);
beforeEach(resetRouterState);

test("records the channel-scoped decision before delivery commit", async () => {
  registerOwnerDm();
  createMappedOwnerSession();
  const observed: Array<DecisionFact.Recorded | undefined> = [];
  const router = makeRouter({
    delivery: {
      commit: (row: Delivery.Commit) => Effect.sync(() => {
        observed.push(ledger().sessions.decisionFacts?.head(streamId()));
        return { ...row, status: "pending" as const, consumedBy: null, consumedAt: null, ordinal: 1 };
      }),
    },
  });
  await runEffect(router.ingest(ownerSender, ownerFacts));
  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({ key: streamId(), type: "route.decided" });
});

test("blocked decisions are durable before returning the receipt", async () => {
  expect(await runEffect(makeRouter().ingest(ownerSender, ownerFacts))).toMatchObject({
    status: "blocked_pre",
  });
  expect(ledger().sessions.decisionFacts?.head(streamId())).toMatchObject({
    key: streamId(),
    type: "route.decided",
    data: { outcome: "block" },
  });
});

test("equivalent redelivery uses one route fact and the same delivery id", async () => {
  registerOwnerDm();
  const mapped = createMappedOwnerSession();
  const router = makeRouter();
  await runEffect(router.ingest(ownerSender, ownerFacts));
  const before = sessionTree(mapped.id, ledger().sessions.actions);
  const recorded = ledger().sessions.decisionFacts?.head(streamId());
  await runEffect(router.ingest(ownerSender, ownerFacts));
  expect(commits).toHaveLength(1);
  expect(sessionTree(mapped.id, ledger().sessions.actions)).toEqual(before);
  expect(ledger().kernel.pendingMessages(mapped.id)).toHaveLength(1);
  expect(ledger().sessions.decisionFacts?.head(streamId())).toEqual(recorded);
});

test("historical route facts upcast on redelivery without reconstructing another route", async () => {
  registerOwnerDm();
  const mapped = createMappedOwnerSession();
  await runEffect(makeRouter().ingest(ownerSender, ownerFacts));
  const modern = Ingress.Events.RoutingDecision.schema.parse(
    ledger().sessions.decisionFacts?.head(streamId())?.data,
  );
  resetRouterState();
  registerOwnerDm();
  ledger().stores.surfaceKeys.claim(
    Channel.SurfaceKey.fromChannel({
      surface: "discord",
      namespace: "owner-workspace",
      kind: "dm",
      id: "owner-dm",
    }),
    mapped.id,
  );
  const recorded = ledger().sessions.decisionFacts?.record({
    key: streamId(),
    type: "route.decided",
    data: { ...modern, runId: "legacy", pendingInteractionId: "legacy" },
    timeCreated: 1,
  });
  expect(recorded?.kind).toBe("recorded");
  await runEffect(makeRouter().ingest(ownerSender, ownerFacts));
  expect(commits).toHaveLength(1);
  expect(ledger().sessions.decisionFacts?.head(streamId())).toEqual(recorded?.fact);
});

test("a changed decision refuses redelivery before committing or observing", async () => {
  const router = makeRouter();
  expect(await runEffect(router.ingest(ownerSender, ownerFacts))).toMatchObject({ status: "blocked_pre" });
  registerOwnerDm();
  createMappedOwnerSession();
  const count = routingDecisions().length;
  const recorded = ledger().sessions.decisionFacts?.head(streamId());
  expect(await effectFailure(router.ingest(ownerSender, ownerFacts))).toMatchObject({
    code: "route_replay_divergent",
  });
  expect(commits).toEqual([]);
  expect(routingDecisions()).toHaveLength(count);
  expect(ledger().sessions.decisionFacts?.head(streamId())).toEqual(recorded);
});

test.each([
  "actorId",
  "trustTier",
  "inboundTreatment",
] as const)("mutated %s authority refuses redelivery without leaking the authority", async (field: "actorId" | "trustTier" | "inboundTreatment") => {
  registerOwnerDm();
  createMappedOwnerSession();
  const router = makeRouter();
  await runEffect(router.ingest(ownerSender, ownerFacts));
  const count = routingDecisions().length;
  if (field === "actorId") {
    ledger().stores.actors.registerIdentity({ id: "replacement", kind: "human", trustTier: "owner" });
    ledger().stores.actors.registerEndpoint({
      id: "endpoint-owner-dm",
      actorId: "replacement",
      channel: ownerSender.surface,
      externalId: ownerSender.externalId,
      workspace: ownerFacts.workspaceId,
    });
  } else if (field === "trustTier") {
    ledger().stores.actors.registerIdentity({ id: "actor-owner", kind: "human", trustTier: "manager" });
  } else {
    ledger().stores.channelGrants.put({
      id: "grant-owner-dm",
      surface: "discord",
      workspace: "owner-workspace",
      channel: "owner-dm",
      kind: "trusted_channel",
      inboundTreatment: "evidence_only",
      createdBy: "owner",
    });
  }
  const caught: Error = await effectFailure(router.ingest(ownerSender, ownerFacts));
  expect(caught).toMatchObject({ _tag: "IngressRoutingError", code: "route_replay_divergent" });
  for (const value of ["actor-owner", "replacement", "manager", "evidence_only"])
    expect(String(caught)).not.toContain(value);
  expect(commits).toHaveLength(1);
  expect(routingDecisions()).toHaveLength(count);
});

test("reply endpoint changes reject an otherwise equivalent route replay", async () => {
  registerOwnerDm();
  createMappedOwnerSession();
  const router = makeRouter();
  await runEffect(router.ingest(ownerSender, ownerFacts));
  const observed = [...routingDecisions()];
  const fact = ledger().sessions.decisionFacts?.head(streamId());
  if (fact === undefined) throw new Error("route fact missing");
  const original = Ingress.Events.RoutingDecision.schema.parse(fact.data);
  const priorEndpoint: readonly string[] = endpointFacts({
    channel: ownerSender.surface,
    externalId: ownerSender.externalId,
  });
  const changed = {
    ...original,
    factsUsed: [
      ...original.factsUsed.filter((value: string) => !priorEndpoint.includes(value)),
      ...endpointFacts({ channel: ownerSender.surface, externalId: "another-endpoint" }),
    ],
  };
  expect(Ingress.routeDecisionsEquivalent(original, changed)).toBe(true);
  replaceDecisionFacts((facts: import("@oni/protocol").Storage.DecisionFactSubAdapter) => ({
    ...facts,
    record: (input: { key: string; type: string; data: import("@oni/protocol").PlainObject; timeCreated: number; }) =>
      input.key === streamId()
        ? { kind: "exists", fact: { ...fact, data: changed } }
        : facts.record(input),
  }));
  expect(await effectFailure(router.ingest(ownerSender, ownerFacts))).toMatchObject({
    code: "route_replay_divergent",
  });
  expect(commits).toHaveLength(1);
  expect(routingDecisions()).toEqual(observed);
});

test("equivalent blocked redelivery returns a refusal without another route fact", async () => {
  const router = makeRouter();
  expect(await runEffect(router.ingest(ownerSender, ownerFacts))).toMatchObject({ status: "blocked_pre" });
  const recorded = ledger().sessions.decisionFacts?.head(streamId());
  expect(await runEffect(router.ingest(ownerSender, ownerFacts))).toMatchObject({ status: "blocked_pre" });
  expect(ledger().sessions.decisionFacts?.head(streamId())).toEqual(recorded);
});

test.each([
  "record_failure",
  "absent",
  "wrong_type",
  "corrupt_fact",
] as const)("decision facts %s refuses before delivery commit or projection", async (fault: "record_failure" | "absent" | "wrong_type" | "corrupt_fact") => {
  registerOwnerDm();
  createMappedOwnerSession();
  replaceDecisionFacts((facts: import("@oni/protocol").Storage.DecisionFactSubAdapter) =>
    fault === "absent"
      ? undefined
      : {
          ...facts,
          record: () => {
            if (fault === "record_failure") throw new Error("decision facts unavailable");
            return {
              kind: "exists",
              fact: {
                key: streamId(),
                type: fault === "wrong_type" ? "other.fact" : "route.decided",
                data: { invalid: true },
                timeCreated: 1,
                rowHash: "0".repeat(64),
              },
            };
          },
        },
  );
  expect(await effectFailure(makeRouter().ingest(ownerSender, ownerFacts))).toMatchObject({
    code: "route_record_failed",
  });
  expect(commits).toEqual([]);
  expect(routingDecisions()).toEqual([]);
});

test("unconfigured actor delivery refuses without delivery commit", async () => {
  expect(
    await runEffect(makeRouter().ingest(
      { kind: "session", id: "sender" },
      { to: { kind: "actor", actorId: "target" }, type: "message", content: "hello" },
    )),
  ).toMatchObject({ status: "blocked_pre", reasonCode: "message.resident.actor_grant" });
  expect(commits).toEqual([]);
});

test("forged observations cannot choose a session", async () => {
  registerOwnerDm();
  const mapped = createMappedOwnerSession();
  Bus.publish(Ingress.Events.RoutingDecision, {
    inboundId: ownerEvent.id,
    surface: ownerEvent.surface,
    stage: "surface_default",
    outcome: "route",
    sessionId: "forged",
    traceId: "trace",
    time: 1,
    reason: "forged",
    mode: "direct",
    factsUsed: [],
    target: "resident",
  });
  await runEffect(makeRouter().ingest(ownerSender, ownerFacts));
  expect(commits).toHaveLength(1);
  expect(commits[0]?.sessionId).toBe(mapped.id);
  expect(ledger().sessions.decisionFacts?.head(streamId())).toMatchObject({
    key: streamId(),
    data: { sessionId: mapped.id },
  });
});
