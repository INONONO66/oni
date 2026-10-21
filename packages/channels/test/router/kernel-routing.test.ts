import { ledger } from "../helpers/ledger";
import { effectFailure } from "../helpers/effect-failure";
import { runEffect } from "../helpers/effect";
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Ingress, type BusEvent } from "@oni/protocol";
import { Bus } from "../helpers/observation";
import {
  createMappedOwnerSession,
  commits,
  kernelRouter,
  ownerEvent,
  ownerFacts,
  ownerMessageTargets,
  ownerPrompt,
  ownerSender,
  registerOwnerDm,
  resetRouterState,
  routingDecisions,
} from "./_router-fixture";

describe("GatewayRouter kernel routing", () => {
  beforeEach(resetRouterState);
  test("mapped Owner DM commits once and returns a session receipt", async () => {
    registerOwnerDm();
    const mapped = createMappedOwnerSession();
    const result = await runEffect(kernelRouter().ingest(ownerSender, ownerFacts));
    expect(result).toEqual({
      status: "executed",
      handle: { messageId: ownerEvent.id, target: mapped.id },
      delivery: { kind: "session" },
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      sessionId: mapped.id,
      kind: "prompt",
      content: ownerPrompt(),
    });
  });
  test("publishes one canonical route decision", async () => {
    registerOwnerDm();
    const mapped = createMappedOwnerSession();
    await runEffect(kernelRouter().ingest(ownerSender, ownerFacts));
    expect(routingDecisions()).toHaveLength(2);
    expect(routingDecisions()[1]).toMatchObject({
      stage: "automation", decision: "superseded", target: `session:${mapped.id}`,
    });
    // The stored row is what the desktop ledger explorer links from (#1458).
    expect(ledger().stores.automations.ledger({ limit: 20 })).toEqual([
      expect.objectContaining({ stage: "automation", decision: "superseded", target: `session:${mapped.id}` }),
    ]);
    expect(routingDecisions()[0]).toMatchObject({
      inboundId: ownerEvent.id,
      stage: "surface_default",
      outcome: "route",
      sessionId: mapped.id,
      actorId: "actor-owner",
      trustTier: "owner",
      inboundTreatment: "full_access",
    });
  });
  test("routing publication failure does not invoke delivery commit", async () => {
    registerOwnerDm();
    createMappedOwnerSession();
    const publish = Bus.publish;
    const publicationFault = new Error("routing publish failed");
    const spy = spyOn(Bus, "publish").mockImplementation(<T>(event: BusEvent.Descriptor<T>, data: T) => {
      if (event === Ingress.Events.RoutingDecision) throw publicationFault;
      publish(event, data);
    });
    try {
      expect(await effectFailure(kernelRouter().ingest(ownerSender, ownerFacts))).toBe(publicationFault);
      expect(commits).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
  test("reads blacklist and channel facts for routing and the granted-direct record", async () => {
    registerOwnerDm();
    createMappedOwnerSession();
    const blacklist = spyOn(ledger().stores.blacklist, "list");
    const channels = spyOn(ledger().stores.channelGrants, "list");
    try {
      await runEffect(kernelRouter().ingest(ownerSender, ownerFacts));
      expect(blacklist).toHaveBeenCalledTimes(1);
      expect(channels).toHaveBeenCalledTimes(1);
    } finally {
      blacklist.mockRestore();
      channels.mockRestore();
    }
  });
  test("first admission claims the physical surface for the next event", async () => {
    registerOwnerDm();
    const [first, second] = await ownerMessageTargets();
    expect(first).toBe(second);
    expect(commits).toHaveLength(2);
    expect(commits[0]?.sessionId).toBe(commits[1]?.sessionId);
  });
});
