import { Core } from "@openomni/agent";
import { createChannelStores } from "@openomni/channels";
import { Gateway, Ingress } from "@openomni/protocol";
import { Effect } from "effect";
import { runAppEffect, channelStoreSource } from "../../src/gateway";
import type { ResidentSuite } from "./resident-suite";
import { fakeProviderModel } from "./resident-suite";
import { assistantMessage } from "./assistant-message";
import { planeOf } from "./ledger";
import { nextResidentTurn } from "./resident-turn";
import { nextFrame } from "./ws";

const automationSender = { kind: "external", surface: "discord", externalId: "source" } as const;
export const automationFacts = Gateway.IngressFacts.parse({
  eventId: "event", surface: "discord", channelId: "room", dm: false, addressees: [],
  author: { externalId: "source", isBot: false }, payload: {}, render: "BUILD_SENTINEL",
});

export function automationRecord(changes: Partial<Ingress.Automation> = {}) {
  return Ingress.Automation.parse({
    id: "build", name: "Build", enabled: true, createdBy: "owner",
    triggers: [{ type: "message", surface: "discord", event: "message" }],
    target: "new", kind: "action", ...changes,
  });
}

export async function automationFixture(suite: ResidentSuite, judgeText = "yes") {
  const time = { now: 1000 };
  const app = await suite.boot({
    config: suite.config("automation-1341-", {
      compactionSummarizer: false, wsToken: "owner-token",
      model: { provider: "fake", id: "primary", fastId: "fast", apiKey: "test" },
    }),
    sessionRuntime: { clock: () => time.now },
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        sink.onMessage(assistantMessage(input, { text: input.model.id === "fast" ? judgeText : "done", createdAt: time.now }));
        return { type: "stop" as const };
      }),
    },
  });
  const plane = await planeOf(app.runtime);
  const stores = createChannelStores(channelStoreSource(plane, () => time.now));
  stores.actors.registerIdentity({ id: "source", kind: "human", trustTier: "observer" });
  stores.actors.registerEndpoint({ id: "discord:source", actorId: "source", channel: "discord", externalId: "source" });
  return {
    app, plane, stores, time,
    ingest: (facts: Parameters<typeof app.gateway.ingest>[1] = automationFacts) =>
      runAppEffect(app.runtime, app.gateway.ingest(automationSender, facts)),
    async target() {
      const settled = nextResidentTurn(plane);
      const result = await runAppEffect(app.runtime, app.gateway.ingest(
        { kind: "external", surface: "ws", externalId: "owner" },
        { ...automationFacts, eventId: "seed", surface: "ws", dm: true },
      ));
      await settled;
      if (result.status !== "executed") throw new Error("seed session not delivered");
      return result.handle.target;
    },
    async client() {
      return runAppEffect(app.runtime, Effect.scoped(Core.SessionEntity.client));
    },
    async socket() {
      stores.actors.registerIdentity({ id: "automation-owner", kind: "human", trustTier: "owner" });
      stores.actors.registerEndpoint({
        id: "ws:automation-owner", actorId: "automation-owner", channel: "ws", externalId: "automation-owner",
      });
      return suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=automation-owner`, ["auth", "owner-token"]);
    },
  };
}

export async function automationRequest(socket: WebSocket, request: Ingress.AutomationRequest) {
  const response = nextFrame(socket, (frame) => frame.requestId === request.requestId);
  socket.send(JSON.stringify(request));
  return Ingress.AutomationResponse.parse(await response);
}
