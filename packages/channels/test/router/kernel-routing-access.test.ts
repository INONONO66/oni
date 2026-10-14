import { ledger } from "../helpers/ledger";
import { beforeEach, describe, expect, test } from "bun:test";
import { runEffect } from "../helpers/effect";

import { registerChannelGrant } from "../helpers/channel-grant";
import { expectEvidenceOnlyCommit } from "./_evidence-only";
import {
  commits,
  kernelRouter,
  ownerFacts,
  ownerSender,
  resetRouterState,
  routingDecisions,
} from "./_router-fixture";

beforeEach(resetRouterState);

describe("GatewayRouter access routing", () => {
  test("missing channel grant refuses before delivery commit", async () => {
    expect(await runEffect(kernelRouter().ingest(ownerSender, ownerFacts))).toMatchObject({
      status: "blocked_pre",
    });
    expect(routingDecisions()[0]).toMatchObject({ stage: "channel_ceiling", outcome: "block" });
    expect(commits).toEqual([]);
  });
  test("unknown actor on a trusted channel without a default tier is refused", async () => {
    registerChannelGrant();
    expect(await runEffect(kernelRouter().ingest(ownerSender, ownerFacts))).toMatchObject({
      status: "blocked_pre",
    });
    expect(routingDecisions()[0]).toMatchObject({ stage: "actor_identity", outcome: "block" });
    expect(commits).toEqual([]);
  });
  test("default-tier admission never registers a new endpoint", async () => {
    registerChannelGrant({ defaultTier: "owner" });
    const result = await runEffect(kernelRouter().ingest(ownerSender, ownerFacts));
    expect(result.status).toBe("executed");
    expect(routingDecisions()[0]).toMatchObject({
      stage: "surface_default",
      outcome: "route",
      trustTier: "owner",
    });
    expect(commits).toHaveLength(1);
    expect(
      ledger().stores.actors.resolveEndpoint(
        ownerSender.surface,
        ownerSender.externalId,
        ownerFacts.workspaceId,
      ),
    ).toBeUndefined();
  });
  test.each([
    undefined,
    "full_access",
  ] as const)("broadcast treatment %s remains evidence-only", async (inboundTreatment: "full_access" | undefined) => {
    registerChannelGrant({
      kind: "broadcast_channel",
      defaultTier: "observer",
      ...(inboundTreatment === undefined ? {} : { inboundTreatment }),
    });
    expect((await runEffect(kernelRouter().ingest(ownerSender, ownerFacts))).status).toBe("executed");
    expect(routingDecisions()[0]).toMatchObject({
      trustTier: "observer",
    });
    expectEvidenceOnlyCommit(ownerSender.externalId);
  });
  test("blocked channel refuses before delivery commit", async () => {
    registerChannelGrant({ kind: "blocked_channel" });
    expect(await runEffect(kernelRouter().ingest(ownerSender, ownerFacts))).toMatchObject({
      status: "blocked_pre",
    });
    expect(routingDecisions()[0]).toMatchObject({
      stage: "channel_ceiling",
      outcome: "block",
      inboundTreatment: "drop",
    });
    expect(commits).toEqual([]);
  });
});
