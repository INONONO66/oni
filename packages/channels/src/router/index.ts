import { Effect, Semaphore } from "effect";
import { ChannelsFailure, DeliveryNotSent } from "../errors";
import { Gateway } from "@openomni/protocol";
import { advanceAutomationGroups } from "./automation/groups.js";
import { ingressInput } from "./automation/input.js";
import { inboundIdOf } from "./inbound-id.js";
import { automationReplay, recordAutomation } from "./automation/ledger.js";
import { executeMessage } from "./message-execution";
import { createExistingAgentMessaging } from "./messaging/send";
import { createReplyGrantInstances } from "./messaging/reply-grant";
import { externalMessage, replayExternal } from "./external-message";
import { filterAutomationRules } from "./automation-rules";
import { answerOwnerRequest } from "./request/owner-answer";
import type { GatewayRouter, GatewayRouterPorts } from "./message-ports";

export type { ChannelDeliveryRoute, GatewayRouter, GatewayRouterPorts } from "./message-ports";

type External = Effect.Success<ReturnType<typeof externalMessage>>;

function ingestResult(
  result: Effect.Success<ReturnType<GatewayRouterPorts["run"]>>,
  handle: Gateway.SendMessageHandle,
): Gateway.IngestResult {
  switch (result.terminal) {
    case "blocked_pre":
      return { status: "blocked_pre", reasonCode: result.reason };
    case "interrupted":
    case "outcome_unknown":
    case "blocked_post":
      return { status: "blocked_post", handle, reasonCode: result.reason };
    case "executed":
      return Gateway.IngestResult.parse(result.value);
  }
}

export function createGatewayRouter(ports: GatewayRouterPorts): GatewayRouter {
  const clock = ports.now;
  const stores = ports.stores;
  const serial = Semaphore.makeUnsafe(1);
  const observe = ports.observe ??
    ((_sender: Gateway.IngestSender, observation: Gateway.MessageObservation) =>
      ports.sink(Gateway.MessageObserved, observation));
  const messagingPorts = ports.messaging;
  const replyGrants = createReplyGrantInstances({
    stores,
    rules: messagingPorts?.replyGrantRules ?? (() => []),
    publish: ports.sink,
  });
  const messaging =
    messagingPorts === undefined
      ? undefined
      : createExistingAgentMessaging({
          stores,
          requests: ports.requests,
          transaction: ports.transaction,
          grants: () => [...messagingPorts.grants(), ...replyGrants.list(clock())],
          ...(messagingPorts.budgets === undefined ? {} : { budgets: messagingPorts.budgets }),
          publish: ports.sink,
          deliver: (message) => {
            const route = messagingPorts.deliveryRoutes.get(message.target.channel);
            if (route === undefined)
              throw new DeliveryNotSent({
                operation: "message.deliver",
                cause: `no delivery route: ${message.target.channel}`,
              });
            return route(message.target.externalId, message.body, message.idempotencyKey);
          },
        });

  function projectMessage(
    sender: Gateway.IngestSender,
    send: Gateway.SendMessage,
    prepared: Effect.Success<ReturnType<GatewayRouterPorts["prepare"]>>,
    external: External | undefined,
    startedAt: number,
  ) {
    const actorSendAllowed =
      send.to.kind !== "actor" ||
      (messaging !== undefined &&
        messaging.preflight({
          senderId: sender.kind === "session" ? sender.id : sender.externalId,
          target: {
            actorId: send.to.actorId,
            ...(send.to.surface === undefined ? {} : { surface: send.to.surface }),
          },
          operation: send.deadline === undefined ? "fire_and_forget" : "awaited",
          at: startedAt,
        }) === undefined);
    const message =
      external !== undefined
        ? {
            ...external.message,
            eventIdUnique: prepared.message.sender === "external" && prepared.message.eventIdUnique,
          }
        : prepared.message.sender === "session"
          ? { ...prepared.message, actorSendAllowed }
          : undefined;
    if (message === undefined)
      throw new ChannelsFailure({
        operation: "message.project",
        cause: "session message projection missing",
      });
    return message;
  }

  function admitReplyGrant(external: External | undefined, at: number, sourceId: string) {
    if (external === undefined) return;
    const actor = external.event.meta?.actor;
    if (actor?.actorId === undefined || actor.endpoint === undefined) return;
    replyGrants.admit({
      actorId: actor.actorId,
      endpoint: actor.endpoint,
      surface: external.event.surface,
      traceId: external.event.traceId,
      ...(external.event.workspace === undefined ? {} : { workspace: external.event.workspace }),
      ...(external.event.channel === undefined ? {} : { channel: external.event.channel }),
      at,
      sourceId,
    });
  }

  function sendFromEnvelope(external: External | undefined,
    envelope: Parameters<GatewayRouter["ingest"]>[1]): Gateway.SendMessage {
    if (external === undefined) return Gateway.SendMessage.parse(envelope);
    return {
      to: { kind: "session", id: external.target },
      type: "message",
      content: external.content,
      ...(external.route.requestExecution.kind === "request"
        ? { replyTo: external.route.requestExecution.record.requestId }
        : {}),
    } satisfies Gateway.SendMessage;
  }

  function sendTarget(send: Gateway.SendMessage): string {
    if (send.to.kind === "actor") return send.to.actorId;
    return send.to.kind === "session" ? send.to.id : ports.id();
  }

  function resolveExternal(sender: Gateway.IngestSender,
    envelope: Parameters<GatewayRouter["ingest"]>[1], at: number) {
    return Effect.gen(function* () {
      if (sender.kind !== "external") return { external: undefined, filtered: undefined };
      const facts = Gateway.IngressFacts.parse(envelope);
      if (sender.surface !== facts.surface)
        throw new ChannelsFailure({ operation: "message.ingress", cause: "authenticated surface mismatch" });
      yield* stores.automations.ready;
      const replay = automationReplay(stores, inboundIdOf(facts));
      const input = ingressInput(stores, sender, facts, at);
      if (replay !== undefined) {
        const external = yield* replayExternal(stores, sender, facts, ports, at,
          messagingPorts?.budgets?.() ?? [], input);
        return { external, filtered: external === undefined ? replay : undefined };
      }
      const filtered = filterAutomationRules(stores, input.input, ports.sink, at);
      const external = filtered === undefined
        ? yield* externalMessage(stores, sender, facts, ports, at,
            messagingPorts?.budgets?.() ?? [], stores.automations.groups().map((group) => group.pending), input)
        : undefined;
      if (external?.disposition !== undefined)
        yield* recordAutomation(stores, ports, external, sender);
      return { filtered, external };
    });
  }

  function dispatchMessage(sender: Gateway.IngestSender,
    envelope: Parameters<GatewayRouter["ingest"]>[1], external: External | undefined, startedAt: number) {
    return Effect.gen(function* () {
      const send = sendFromEnvelope(external, envelope);
      const target = sendTarget(send);
      const proposedId = external?.event.id ?? ports.id();
      const prepared = yield* ports.prepare(sender, send, target, proposedId);
      const messageId = prepared.messageId ?? proposedId;
      const handle = { messageId, target: prepared.target };
      const message = projectMessage(sender, send, prepared, external, startedAt);
      const progress: Parameters<typeof executeMessage>[1] = { commitMs: 0, committed: undefined };
      const result = yield* ports.run(sender, {
        kind: "message", op: "send_message", intent: { messageId, sender, ...send },
        effect: { type: "message", target: prepared.target }, message,
      }, (intent) => Effect.gen(function* () {
        if (external !== undefined && sender.kind === "external")
          yield* recordAutomation(stores, ports, external, sender);
        return yield* executeMessage({
          stores, sender, send, prepared, external, ports, messaging, messageId, handle,
          startedAt, clock, admitReplyGrant: () => admitReplyGrant(external, startedAt, messageId),
        }, progress, intent);
      }));
      if (result.terminal === "blocked_pre" && external !== undefined && sender.kind === "external")
        yield* recordAutomation(stores, ports, external, sender, result.reason);
      observe(sender, {
        kind: "message.sent", messageId, sender, targetKind: send.to.kind,
        type: send.type, bytes: new TextEncoder().encode(send.content).byteLength,
      });
      observe(sender, result.terminal === "blocked_pre"
        ? { kind: "message.rejected", messageId, matchedRuleIds: [...result.matchedRuleIds],
            ingestMs: clock() - startedAt, verdict: "deny" }
        : { kind: "message.admitted", messageId, matchedRuleIds: [...result.matchedRuleIds],
            ingestMs: clock() - startedAt, verdict: "allow" });
      if (progress.committed !== undefined) {
        if (external !== undefined) stores.automations.completeDelivery(external.event.id);
        observe(sender, { kind: "message.committed", messageId, commitMs: progress.commitMs });
        ports.committed?.(progress.committed);
      }
      return ingestResult(result, handle);
    });
  }

  function advance(now = clock()) {
    return advanceAutomationGroups(stores, now, ports.sink, (group, route) => Effect.gen(function* () {
      const input = ingressInput(stores, group.sender, group.facts, now);
      const external = yield* externalMessage(stores, group.sender, group.facts, ports, now,
        messagingPorts?.budgets?.() ?? [], [], input, { ...route, target: group.target });
      // A newly correlated request must not consume an old grouped event as its answer.
      if (external.route.requestExecution.kind === "request")
        return { status: "blocked_pre" as const, reasonCode: "request_correlation" };
      return yield* dispatchMessage(group.sender, group.facts, external, now);
    }));
  }

  return {
    advance: (at) => serial.withPermit(advance(at)),
    ingest: (rawSender, envelope) => Effect.gen(function* () {
      const startedAt = clock();
      const sender = Gateway.IngestSender.parse(rawSender);
      if ("kind" in envelope && envelope.kind === "request_answer")
        return yield* answerOwnerRequest(stores, ports, sender, envelope, startedAt);
      const inbound = yield* resolveExternal(sender, envelope, startedAt);
      if (inbound.filtered !== undefined) return inbound.filtered;
      const external = inbound.external;
      if (external?.disposition !== undefined) {
        return { status: "blocked_pre" as const, reasonCode: external.disposition };
      }
      return yield* dispatchMessage(sender, envelope, external, startedAt);
    }).pipe(serial.withPermit),
  };
}
