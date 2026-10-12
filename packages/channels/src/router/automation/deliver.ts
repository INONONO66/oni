import { Effect } from "effect";
import type { Gateway, Ingress } from "@openomni/protocol";
import type { GatewayRouterPorts } from "../message-ports.js";

export function deliverAutomation(
  ports: GatewayRouterPorts,
  sender: Extract<Gateway.IngestSender, { kind: "external" }>,
  route: { readonly target: string; readonly source: "ingress";
    readonly handlerRef: string; readonly body: Ingress.TriggerContext },
  eventId: string,
  at: number,
  actorId: string,
) {
  return Effect.gen(function* () {
    const target = route.target === "new" ? ports.id() : route.target.slice("session:".length);
    const content = JSON.stringify(route.body);
    const prepared = yield* ports.prepare(sender,
      { to: { kind: "session", id: target }, type: "message", content }, target, eventId);
    const row = yield* ports.delivery.commit({
      id: eventId, sessionId: prepared.target, kind: "action", content,
      createdAt: at, parentActionId: null,
      ...(prepared.createSession === undefined ? {} : { createSession: prepared.createSession }),
      origin: { encodingVersion: 1, value: {
        kind: "external", messageId: eventId, surface: sender.surface,
        externalId: sender.externalId, actorId,
        source: route.source, handlerRef: route.handlerRef,
      } },
    });
    ports.committed?.(row);
    return { row, target: prepared.target };
  });
}
