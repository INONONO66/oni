import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { Effect } from "effect";
import { runEffect, runSyncEffect } from "./helpers/scoped-effect";
import { Bus } from "./helpers/bus";
import { describe, expect, test } from "bun:test";
import { createRuleStore, createSurfaceKeyStore, decodeChannelFailure } from "@oni/channels";
import type { Core } from "@oni/agent";
type RunInput = Core.RunInput;
import { Ingress, Gateway, MessagingEvents, type Outbound } from "@oni/protocol";
import {
  createResidentGateway,
} from "../src/gateway";
import { residentRunner } from "./helpers/resident-runner";
import { localDelivery } from "./helpers/ledger";
import { prepareMessage } from "../src/composition/message-session";
import { assistantMessage } from "./helpers/assistant-message";
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
  createSurfaceKeyStore(resident.plane.channel).claim("ws:dm:observer", "session:evidence");
  return {
    gateway,
    plane: resident.plane,
    async ingest(content: string) {
      createRuleStore(resident.plane.channel).add({ id: "ws", position: 0, enabled: true, createdBy: "owner",
        when: { instance: "ws" }, outcome: { kind: "deliver", target: "conversation", deliveryKind: "prompt", reply: "auto" } });
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
      const result = await resident.ingest("OBSERVATION_SENTINEL");
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
      Ingress.Message.parse({ eventId: "invalid", surface: "ws", render: "text" }),
    ).toThrow();
    expect(resident.plane.listSessions()).toHaveLength(1);
    expect(resident.plane.openKernel("gateway-ingress").pendingMessages("gateway-ingress")).toEqual([]);
  });
  test("rule-routed ingress keeps the original content", async () => {
    const calls: RunInput[] = [];
    const resident = testResident(recordingRun(calls));
    await resident.ingest("EVIDENCE_SENTINEL");
    expect(calls).toHaveLength(1);
    const prompt = sessionTree("session:evidence", resident.plane.sessionStore("session:evidence").actions)
      .find((action) => action.kind === "prompt");
    expect(prompt?.effect.value).toMatchObject({ content: [{ kind: "text", text: "EVIDENCE_SENTINEL" }] });
  });
});

test("cold egress without a budget is the Owner's to approve: the compiled consent row denies it before any delivery (#1569 lane 8)", async () => {
  const deliveries: Outbound.Payload[] = [];
  const denials: Gateway.MessageDenialCode[] = [];
  const unsubscribe = Bus.subscribe(MessagingEvents.Denied, (event) => denials.push(event.code));
  const fixture = messageFixture("resident", {
    deliveryRoutes: new Map([
      [
        "ws",
        { platform: "ws", identity: "bot", deliver: async (_externalId, body) => {
          deliveries.push(body);
          return { value: "accepted" as const };
        } },
      ],
    ]),
    grants: () => [
      {
        id: "grant",
        senderId: "sender",
        targetActorId: "alice",
        operations: ["fire_and_forget"],
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
    expect(cold.content).toContain("message.resident.approval_required");
    // The preflight verdict is the policy row's; the send kernel is never entered.
    expect(denials).toEqual([]);
    expect(deliveries).toEqual([]);
  } finally {
    unsubscribe();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
