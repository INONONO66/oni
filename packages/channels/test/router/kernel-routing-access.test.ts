import { ledger } from "../helpers/ledger";
import { beforeEach, expect, test } from "bun:test";
import { runEffect } from "../helpers/effect";
import { registerRule } from "../helpers/rule";
import { commits, kernelRouter, ownerFacts, ownerSender, resetRouterState, routingDecisions } from "./_router-fixture";

beforeEach(resetRouterState);

test("no matching rule records without delivering or minting an actor", async () => {
  expect(await runEffect(kernelRouter().ingest(ownerSender, ownerFacts))).toEqual({ status: "blocked_pre", reasonCode: "none" });
  expect(routingDecisions()[0]).toMatchObject({ stage: "automation", outcome: "record", by: "rule/none" });
  expect(commits).toEqual([]);
});

test("an explicit rule admits unknown senders without inventing trust or registering endpoints", async () => {
  registerRule();
  expect((await runEffect(kernelRouter().ingest(ownerSender, ownerFacts))).status).toBe("executed");
  expect(routingDecisions()[0]).toMatchObject({ stage: "surface_default", outcome: "route" });
  expect(routingDecisions()[0]?.trustTier).toBeUndefined();
  expect(commits).toHaveLength(1);
  expect(ledger().stores.actors.resolveEndpoint(ownerSender.surface, ownerSender.externalId, ownerFacts.workspaceId)).toBeUndefined();
});

test("disabled rules grant no delivery", async () => {
  registerRule({ enabled: false });
  expect(await runEffect(kernelRouter().ingest(ownerSender, ownerFacts))).toEqual({ status: "blocked_pre", reasonCode: "none" });
  expect(commits).toEqual([]);
});
