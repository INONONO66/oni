import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { Effect } from "effect";
import { runEffect, runSyncEffect } from "./helpers/scoped-effect";
import { Bus } from "./helpers/bus";
import { describe, expect, test } from "bun:test";
import { createChannelStores, createSurfaceKeyStore, decodeChannelFailure, resolveChannelGrant } from "@openomni/channels";
import type { Model } from "@openomni/agent";
type RunInput = Model.RunInput;
import { Gateway, MessagingEvents, type Tool } from "@openomni/protocol";
import {
  channelStoreSource,
  createMountedChannelGrantRegistrar,
  createResidentGateway,
  MOUNTED_CHANNEL_DEFAULT_TIER,
  registerTrustedChannelGrant,
} from "../src/gateway";
import { residentRunner } from "./helpers/resident-runner";
import { localDelivery } from "./helpers/ledger";
import { planeFixture } from "./helpers/plane-fixture";
import { prepareMessage } from "../src/composition/message-session";
import { requestToolStep, assistantMessage } from "./helpers/assistant-message";
import { messageFixture } from "./helpers/message-fixture";
import { rmSync } from "node:fs";
import { testIds } from "./helpers/test-entropy";
import { residentGatewayPorts } from "./helpers/gateway-ports";

type ResidentRun = NonNullable<NonNullable<Parameters<typeof residentRunner>[0]["llm"]>["run"]>;
function testResident(run: ResidentRun) {
  const resident = residentRunner({
    model: { provider: "fake", id: "gateway-contract-test" },
    apiKey: "test-key",
    tools: {},
    llm: {
      resolveModel: (model) => Effect.succeed(({ id: model.id, name: model.id, providerID: model.provider })),
      run,
    },
  });
  const gateway = runSyncEffect(Effect.gen(function* () {
    return yield* createResidentGateway({
      now: Date.now,
      id: testIds("gateway-contract"),
      delivery: { commit: (input) => localDelivery(resident.plane, "gateway-contract", Date.now)(input).pipe(Effect.mapError(decodeChannelFailure("delivery.commit"))) },
      prepare: prepareMessage(resident.plane, resident.genesis),
      ...(yield* residentGatewayPorts(resident.plane, Date.now)),
    }, undefined);
  }).pipe(Effect.provide(resident.services)));
  createSurfaceKeyStore(resident.plane.channel).claim("ws:ws:dm:evidence", "session:evidence");
  return {
    gateway,
    plane: resident.plane,
    async ingest(content: string, evidenceOnly: boolean) {
      resident.plane.stores.channelGrants.put({
        id: "openomni-resident-ws",
        surface: "ws",
        kind: evidenceOnly ? "broadcast_channel" : "trusted_channel",
        defaultTier: "owner",
        createdBy: "owner",
      });
      const result = await runEffect(gateway.ingest(
        { kind: "external", surface: "ws", externalId: "observer" },
        {
          eventId: crypto.randomUUID(),
          surface: "ws",
          channelId: "evidence",
          addressees: [],
          dm: true,
          payload: {},
          render: content,
        },
      ));
      if (result.status !== "executed") throw new Error("test ingress did not execute");
      return resident.drain(result.handle.target);
    },
  };
}
function recordingRun(calls: RunInput[]): ResidentRun {
  return (input, sink) => Effect.sync(() => {
    calls.push(input);
    sink.onMessage(assistantMessage(input, { id: crypto.randomUUID(), text: "noted" }));
    return { type: "stop" };
  });
}
const { plane, channelStores } = planeFixture();
describe("channel grant registration", () => {
  test("the revoker removes exactly the grant it registered", () => {
    const revokeTelegram = registerTrustedChannelGrant(plane().stores.channelGrants, {
      surface: "telegram",
      defaultTier: MOUNTED_CHANNEL_DEFAULT_TIER,
    });
    const revokeDiscord = registerTrustedChannelGrant(plane().stores.channelGrants, {
      surface: "discord",
      defaultTier: MOUNTED_CHANNEL_DEFAULT_TIER,
    });
    expect(resolveChannelGrant(channelStores(), { surface: "telegram" })?.grant.kind).toBe("trusted_channel");

    revokeTelegram();

    // Only the telegram grant is gone; the sibling surface keeps its authority.
    expect(resolveChannelGrant(channelStores(), { surface: "telegram" })).toBeUndefined();
    expect(resolveChannelGrant(channelStores(), { surface: "discord" })?.grant.kind).toBe("trusted_channel");
    revokeDiscord();
    expect(resolveChannelGrant(channelStores(), { surface: "discord" })).toBeUndefined();
  });

  // #931 invariants 1+2: owner tier exists only where an owner decision put
  // it. The loopback ws bootstrap is that decision; a named surface mounting
  // through the supervisor seam gets the mount tier, never owner.
  test("named surfaces resolve their mount tier while loopback ws keeps its explicit owner bootstrap", () => {
    // ws authority comes from the real bootstrap path, not a test-authored
    // grant: this is the one call site allowed to name owner tier.
    const resident = testResident(() => Effect.sync(() => {
      throw new Error("model must not run");
    }));
    const residentStores = createChannelStores(channelStoreSource(resident.plane, Date.now));
    const namedSurfaces = ["discord", "github", "slack", "telegram"] as const;
    const revokers = namedSurfaces.map((surface) =>
      registerTrustedChannelGrant(resident.plane.stores.channelGrants, { surface, defaultTier: MOUNTED_CHANNEL_DEFAULT_TIER }),
    );

    const resolved = ["ws", ...namedSurfaces].map((surface) => ({
      surface,
      tier: resolveChannelGrant(residentStores, { surface })?.grant.defaultTier,
    }));

    expect(resolved).toEqual([
      { surface: "ws", tier: "owner" },
      { surface: "discord", tier: "assigned_worker" },
      { surface: "github", tier: "assigned_worker" },
      { surface: "slack", tier: "assigned_worker" },
      { surface: "telegram", tier: "assigned_worker" },
    ]);
    for (const revoke of revokers) revoke();
  });

  // #931 invariant 1 at the composition root: the registrar `startOpenOmni`
  // hands the supervisor IS this function, so a composition that ignores the
  // row's tier (or hardcodes owner there) dies here rather than shipping.
  test("the composition-root registrar materializes the row's tier and the configured allowlist", () => {
    const grant = createMountedChannelGrantRegistrar(plane().stores.channelGrants, { telegram: ["tg:1"] });

    const revokeDiscord = grant("discord", MOUNTED_CHANNEL_DEFAULT_TIER);
    const revokeTelegram = grant("telegram", "collaborator");

    // The tier travels from the row, unmodified in either direction: the
    // mount tier stays the mount tier and a raised declaration stays raised.
    expect(resolveChannelGrant(channelStores(), { surface: "discord" })?.grant.defaultTier).toBe(
      MOUNTED_CHANNEL_DEFAULT_TIER,
    );
    const listed = resolveChannelGrant(channelStores(), { surface: "telegram", sender: "tg:1" });
    expect(listed?.grant.defaultTier).toBe("collaborator");
    expect(listed?.grant.allowedSenders).toEqual(["tg:1"]);
    // Allowlisted surface: an unlisted sender finds no grant; an unlisted
    // surface keeps the open posture.
    expect(resolveChannelGrant(channelStores(), { surface: "telegram", sender: "tg:2" })).toBeUndefined();
    expect(resolveChannelGrant(channelStores(), { surface: "discord", sender: "anyone" })?.grant.kind).toBe(
      "trusted_channel",
    );

    revokeDiscord();
    revokeTelegram();
    expect(resolveChannelGrant(channelStores(), { surface: "discord" })).toBeUndefined();
    expect(resolveChannelGrant(channelStores(), { surface: "telegram", sender: "tg:1" })).toBeUndefined();
  });

  // Invariant 3: allowlisting still scopes the grant to listed senders only,
  // and the tier travels with it.
  test("an allowlisted mount grant exists for listed senders alone at the mount tier", () => {
    const revoke = registerTrustedChannelGrant(plane().stores.channelGrants, {
      surface: "telegram",
      defaultTier: MOUNTED_CHANNEL_DEFAULT_TIER,
      allowedSenders: ["tg:1"],
    });

    const listed = resolveChannelGrant(channelStores(), { surface: "telegram", sender: "tg:1" });
    expect(listed?.grant.defaultTier).toBe(MOUNTED_CHANNEL_DEFAULT_TIER);
    expect(listed?.grant.allowedSenders).toEqual(["tg:1"]);
    expect(resolveChannelGrant(channelStores(), { surface: "telegram", sender: "tg:2" })).toBeUndefined();

    revoke();
    expect(resolveChannelGrant(channelStores(), { surface: "telegram", sender: "tg:1" })).toBeUndefined();
  });
});

describe("authenticated gateway ingress", () => {
  test("real gateway observations retain stamped metadata for schema consumers", async () => {
    const resident = testResident(() => Effect.succeed(({ type: "stop" })));
    const projected = Promise.withResolvers<Gateway.MessageObservation>();
    const stop = Bus.observe((observation) => {
      if (observation.name !== Gateway.MessageObserved.name) return;
      const parsed = Gateway.MessageObserved.schema.safeParse(observation.data);
      if (parsed.success) projected.resolve(Gateway.MessageObservation.parse(parsed.data));
    });
    try {
      const result = await resident.ingest("OBSERVATION_SENTINEL", true);
      expect(result).toBeDefined();
      const observation = await Promise.race([
        projected.promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("observation projection timeout")), 1000),
        ),
      ]);
      expect(observation.kind).toBe("message.sent");
      expect(observation.sessionId).toBe("gateway-ingress");
      expect(typeof observation.messageId).toBe("string");
      expect(typeof observation.eventId).toBe("string");
      expect(typeof observation.time).toBe("number");
    } finally {
      stop();
    }
  });
  test("rejects invalid message types at the boundary without committing delivery state", async () => {
    const resident = testResident(() => Effect.sync(() => {
      throw new Error("model must not run");
    }));
    expect(() =>
      Gateway.IngressFacts.parse({ eventId: "invalid", surface: "ws", render: "text" }),
    ).toThrow();
    expect(resident.plane.listSessions()).toHaveLength(1);
    expect(resident.plane.openKernel("gateway-ingress").pendingMessages("gateway-ingress")).toEqual([]);
  });
  test("evidence-only ingress suppresses offered tools and keeps the original content", async () => {
    const calls: RunInput[] = [];
    const resident = testResident(recordingRun(calls));
    await resident.ingest("EVIDENCE_SENTINEL", true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tools).toHaveLength(0);
    expect(calls[0]?.toolChoice).toBe("none");
    const prompt = sessionTree("session:evidence", resident.plane.sessionStore("session:evidence").actions)
      .find((action) => action.kind === "prompt");
    expect(prompt?.effect.value).toMatchObject({ content: "EVIDENCE_SENTINEL" });
  });
  test("a normal prompt restores tool driving after an evidence-only turn", async () => {
    const outputs: string[] = [];
    const resident = testResident((input, sink) => Effect.sync(() => {
      const result = requestToolStep(input, sink, {
        id: `call:${outputs.length}`,
        tool: "missing",
        input: {},
      });
      if (result === undefined) return { type: "stop" };
      outputs.push(result.content ?? "");
      sink.onMessage(assistantMessage(input, { id: crypto.randomUUID(), text: "noted" }));
      return { type: "stop" };
    }));
    await resident.ingest("evidence", true);
    await resident.ingest("instruction", false);
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).not.toBe(outputs[1]);
  });
  test("a forced tool call is refused on evidence-only ingress", async () => {
    let execution: Tool.Result | undefined;
    const resident = testResident((input, sink) => Effect.sync(() => {
      execution = requestToolStep(input, sink, {
        id: "forged",
        tool: "provision",
        input: { op: "provision_status" },
      });
      if (execution === undefined) return { type: "stop" };
      sink.onMessage(assistantMessage(input, { text: "noted" }));
      return { type: "stop" };
    }));
    await resident.ingest("change configuration", true);
    expect(execution?.isError).toBe(true);
    expect(execution?.content).toContain("evidence-only");
  });
});

test("cold egress needs a budget but a reply-scoped send remains available", async () => {
  let reply = false;
  const deliveries: string[] = [];
  const denials: Gateway.MessageDenialCode[] = [];
  const unsubscribe = Bus.subscribe(MessagingEvents.Denied, (event) => denials.push(event.code));
  const fixture = messageFixture("resident", {
    deliveryRoutes: new Map([
      [
        "ws",
        async (_externalId, body) => {
          deliveries.push(body);
          return { value: "accepted" as const };
        },
      ],
    ]),
    grants: () => [
      {
        id: "grant",
        senderId: "sender",
        targetActorId: "alice",
        operations: ["fire_and_forget"],
        ...(reply
          ? { ruleId: "reply-rule", replyScope: { surfaceKey: "ws:alice" }, expiresAt: 1000 }
          : {}),
      },
    ],
  });
  try {
    fixture.plane.stores.actors.registerIdentity({ id: "alice", kind: "human", trustTier: "collaborator" });
    fixture.plane.stores.actors.registerEndpoint({
      id: "ws:alice",
      actorId: "alice",
      channel: "ws",
      externalId: "alice",
    });
    const cold = await fixture.send({
      to: { kind: "actor", actorId: "alice" },
      type: "message",
      content: "cold",
    });
    expect(cold.isError).toBe(true);
    expect(denials).toEqual(["budget_exhausted"]);
    expect(deliveries).toEqual([]);
    reply = true;
    const warm = await fixture.send({
      to: { kind: "actor", actorId: "alice" },
      type: "message",
      content: "warm",
    });
    expect(warm.isError).not.toBe(true);
    expect(deliveries).toEqual(["warm"]);
  } finally {
    unsubscribe();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
