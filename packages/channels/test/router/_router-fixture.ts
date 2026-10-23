import { policySnapshot } from "../../../agent/test/helpers/compiled-policy";
import { commitReceivedMessage, ledger, resetLedger } from "../helpers/ledger";
import { Effect } from "effect";
import { runEffect } from "../helpers/effect";
import { channelRequests } from "../helpers/channel-requests";
import { channelTransaction } from "../helpers/channel-transaction";
import { originalAction, requestPort } from "../helpers/requests";
import { messageExecutionReceipt } from "../helpers/message-execution";
import { Channel, Ingress, Gateway, type Delivery } from "@oni/protocol";
import { Core } from "@oni/agent";
import { z } from "zod";
const KERNEL_POLICY_REGISTRY = Core.KERNEL_POLICY_REGISTRY;

import { decodeChannelFailure } from "../../src/errors";
import { Bus } from "../helpers/observation";
import {
  createGatewayRouter,
  type GatewayRouter,
  type GatewayRouterPorts,
} from "../../src/router/index.js";
import type { ConversationBinding } from "../../src/router/messaging/reply";

export const ownerSender = {
  kind: "external",
  surface: "discord",
  externalId: "owner-external-id",
} as const;
export const ownerFacts: Gateway.IngressFacts = {
  eventId: "inbound-owner-dm",
  surface: "discord",
  workspaceId: "owner-workspace",
  channelId: "owner-dm",
  addressees: [],
  dm: true,
  payload: "hello resident",
  render: "hello resident",
};

/** The prompt the owner's message becomes: the `[from …]` line a reply or reaction is addressed to, then the text (#1497). */
export function ownerPrompt(
  facts: Gateway.IngressFacts = ownerFacts,
  actorId = "actor-owner",
): string {
  const threadId = facts.reply?.threadId;
  return `[from ${actorId} on ${facts.surface} · channel ${facts.channelId} · message ${facts.eventId}${threadId === undefined ? "" : ` · thread ${threadId}`}]\n\n${facts.render}`;
}

// The internal route record identity is scoped by the perimeter, not supplied by the driver.
export const ownerEvent = {
  id: "discord:owner-workspace:owner-dm:inbound-owner-dm",
  traceId: "trace-test",
  surface: "discord",
  workspace: "owner-workspace",
  channel: "owner-dm",
  userId: "owner-external-id",
  mode: "direct",
  payload: "hello resident",
  meta: { actor: { role: "user" } },
} satisfies Gateway.DeliveredEvent;

export function makeInboundEvent(
  overrides?: Partial<Gateway.DeliveredEvent>,
): Gateway.DeliveredEvent {
  return { id: "evt-1", traceId: "trace-test", surface: "test", mode: "direct", ...overrides };
}

export const commits: Delivery.Commit[] = [];
const decisions: Ingress.RoutingDecisionPayload[] = [];
let router: GatewayRouter | undefined;

export function resetStores(): void {
  resetLedger();
  Bus.reset();
}

export function resetRouterState(): void {
  resetStores();
  commits.length = 0;
  decisions.length = 0;
  router = makeRouter();
}

export function kernelRouter(): GatewayRouter {
  if (!router) throw new Error("resetRouterState() must run before kernelRouter()");
  return router;
}

export async function ownerMessageTargets(
  secondFacts: Gateway.IngressFacts = { ...ownerFacts, eventId: "second" },
) {
  const first = await runEffect(kernelRouter().ingest(ownerSender, ownerFacts));
  const second = await runEffect(kernelRouter().ingest(ownerSender, secondFacts));
  if (first.status !== "executed" || second.status !== "executed")
    throw new Error("owner fixture was not admitted");
  return [first.handle.target, second.handle.target] as const;
}

// L1/executor recording ports. Routing, identity, Request, grants and delivery remain real.
// The real compiler evaluates perimeter A rows and actor grants; app tests cover the full executor/tree.
const fixtureIds = { value: 0 };
function nextFixtureId(prefix: string): string {
  fixtureIds.value += 1;
  return `${prefix}-${fixtureIds.value}`;
}

/** The origin a channel prompt was committed with; the fixture's stand-in for the app's own fold. */
const CommittedOrigin = z
  .object({
    kind: z.literal("external"),
    surface: z.string().min(1),
    externalId: z.string().min(1),
    actorId: z.string(),
    receivedBy: z.enum(["bot", "owner"]).optional(),
    conversation: z
      .object({
        channelId: z.string().min(1),
        messageId: z.string().min(1),
        dm: z.boolean(),
        workspaceId: z.string().min(1).optional(),
        threadId: z.string().min(1).optional(),
      })
      .strict(),
  })
  .loose();

/**
 * The reply door's binding (#1569) as the composing app folds it: the
 * conversation the named prompt was delivered from, read off the sender's own
 * commits — a prompt another session received binds nothing.
 */
function originBinding(
  sender: Gateway.IngestSender,
  send: Gateway.SendMessage,
): ConversationBinding | undefined {
  if (sender.kind !== "session" || send.to.kind !== "origin") return undefined;
  const inReplyTo = send.to.inReplyTo;
  const prompt = commits.find(
    (commit) => commit.id === inReplyTo && commit.sessionId === sender.id,
  );
  const origin = CommittedOrigin.safeParse(prompt?.origin.value);
  if (!origin.success) return undefined;
  const { surface, externalId, actorId, conversation, receivedBy } = origin.data;
  return {
    surface,
    externalId,
    actorId,
    channelId: conversation.channelId,
    messageId: conversation.messageId,
    dm: conversation.dm,
    ...(receivedBy === undefined ? {} : { receivedBy }),
    ...(conversation.workspaceId === undefined ? {} : { workspaceId: conversation.workspaceId }),
    ...(conversation.threadId === undefined ? {} : { threadId: conversation.threadId }),
  };
}

const sessionDenial = (id: string, targetKind: "actor" | "origin", check: "actor_send" | "identity" | "reply_auto" = "actor_send") => ({
  generation: 1,
  name: id,
  kind: "message" as const,
  phase: "pre" as const,
  priority: 1000,
  match: {
    encodingVersion: 1 as const,
    value: {
      message: Gateway.RuleTableB.parse({
        id,
        table: "B",
        sender: "session",
        senderRole: "resident",
        targetKind,
        check: { kind: check },
        effect: "deny",
      }),
    },
  },
  verdict: { encodingVersion: 1 as const, value: { type: "deny" as const, reason: id } },
});

export function makeRouter(overrides: Partial<GatewayRouterPorts> = {}): GatewayRouter {
  const now = overrides.now ?? (() => 1);
  const policy = policySnapshot({
    registry: KERNEL_POLICY_REGISTRY,
    generation: 1,
    rows: [
      sessionDenial("message.resident.actor_grant", "actor"),
      // #1569: `as: owner` needs an Owner-origin turn and an outbound-granted Owner instance.
      sessionDenial("message.resident.identity_not_granted", "actor", "identity"),
      // #1569: the reply door's preflight (binding owned, route mounted) rides the same check.
      sessionDenial("message.resident.reply_unbound", "origin"),
      // #1569 lane 7: a surface reached only through an Owner account that does not auto-reply.
      sessionDenial("message.resident.reply_draft", "origin", "reply_auto"),
      {
        generation: 1,
        name: "compaction",
        kind: "compaction",
        phase: "pre",
        priority: 1000,
        match: { encodingVersion: 1, value: { op: "compact" } },
        verdict: { encodingVersion: 1, value: { type: "allow" } },
      },
      ...Gateway.RuleTableA.shape.check.options.map(
        (
          check:
            | "identity"
            | "grant_tier"
            | "egress_budget"
            | "event_id_dedupe"
            | "reply_correlation",
        ) => ({
          generation: 1,
          name: `message.external.${check}`,
          kind: "message",
          phase: "pre" as const,
          priority: 1000,
          match: {
            encodingVersion: 1 as const,
            value: {
              message: Gateway.RuleTableA.parse({
                id: `message.external.${check}`,
                table: "A",
                sender: "external",
                check,
                effect: "deny",
              }),
            },
          },
          verdict: {
            encodingVersion: 1 as const,
            value: { type: "deny", reason: `message.external.${check}` },
          },
        }),
      ),
    ],
  });
  router = createGatewayRouter({
    stores: ledger().stores,
    transaction: channelTransaction,
    now,
    id: () => nextFixtureId("fixture-id"),
    requests: channelRequests(
      requestPort(now, (sessionIds: readonly string[]) => {
        for (const sessionId of sessionIds) {
          for (const row of ledger().kernel.pendingMessages(sessionId)) {
            if (commits.some((existing: Delivery.Commit) => existing.id === row.id)) continue;
            commits.push({ ...row, parentActionId: null });
            overrides.committed?.(row);
          }
        }
      }),
    ),
    sink: <T>(event: import("@oni/protocol").BusEvent.Descriptor<T>, data: T) => {
      if (event.name === Ingress.Events.RoutingDecision.name) {
        decisions.push(Ingress.Events.RoutingDecision.schema.parse(data));
      }
      Bus.publish(event, data);
    },
    delivery: {
      commit: (row: Delivery.Commit) =>
        Effect.gen(function* () {
          yield* ledger().kernel.materialize({
            id: row.sessionId,
            parentId: null,
            role: "resident",
            tools: [],
            system: { preset: "", blocks: [] },
            policyGeneration: 0,
            actionId: `${row.sessionId}:configure`,
            at: 0,
          });
          const existed = ledger()
            .kernel.pendingMessages(row.sessionId)
            .some((input: Delivery.Row) => input.id === row.id);
          const received = yield* commitReceivedMessage(row);
          if (!existed) commits.push(row);
          return received.row;
        }).pipe(Effect.mapError(decodeChannelFailure("fixture.delivery"))),
    },
    prepare: (sender: Gateway.IngestSender, send: Gateway.SendMessage, target: string) => {
      const binding = originBinding(sender, send);
      return Effect.succeed({
        target,
        ...(binding === undefined ? {} : { binding }),
        message:
          sender.kind === "external"
            ? {
                sender: "external",
                addressee: "bot",
                identity: true,
                grantTier: true,
                egressBudget: true,
                eventIdUnique: true,
                replyCorrelation: true,
              }
            : {
                sender: "session",
                senderRole: "resident",
                targetKind: send.to.kind,
                type: send.type,
                parentChild: true,
                fanout: 0,
                depth: 1,
                withinParentDeadline: true,
              },
      });
    },
    run: (
      sender: Gateway.IngestSender,
      request: Parameters<GatewayRouterPorts["run"]>[1],
      body: Parameters<GatewayRouterPorts["run"]>[2],
    ) =>
      Effect.gen(function* () {
        const decision = policy.evaluate({
          kind: "message",
          phase: "pre",
          op: request.op,
          value: request.intent,
          message: request.message,
        });
        if (decision.verdict === "deny")
          return {
            terminal: "blocked_pre",
            matchedRuleIds: decision.matchedRuleIds,
            reason: decision.reason ?? "denied",
          };
        const actionId = nextFixtureId("action");
        if (sender.kind === "session") originalAction(actionId, sender.id, request.intent);
        return {
          terminal: "executed",
          matchedRuleIds: decision.matchedRuleIds,
          value: yield* body(
            messageExecutionReceipt(
              actionId,
              sender.kind === "session" ? sender.id : "ingress",
              request.intent,
            ),
          ),
        };
      }),
    ...overrides,
  });
  return router;
}

export function registerOwnerDm(): void {
  ledger().stores.actors.registerIdentity({ id: "actor-owner", kind: "human", trustTier: "owner" });
  ledger().stores.actors.registerEndpoint({
    id: "endpoint-owner-dm",
    actorId: "actor-owner",
    channel: ownerSender.surface,
    externalId: ownerSender.externalId,
    workspace: ownerFacts.workspaceId,
  });
  ledger().stores.channelGrants.put({
    id: "grant-owner-dm",
    surface: ownerFacts.surface,
    workspace: ownerFacts.workspaceId,
    channel: ownerFacts.channelId,
    kind: "trusted_channel",
    createdBy: "actor-owner",
  });
}

export function createMappedOwnerSession(): { readonly id: string } {
  const id = nextFixtureId("mapped-session");
  ledger().stores.surfaceKeys.claim(
    Channel.SurfaceKey.fromChannel({
      surface: ownerFacts.surface,
      namespace: "owner-workspace",
      kind: "dm",
      id: ownerFacts.channelId,
    }),
    id,
  );
  return { id };
}

export function routingDecisions(): readonly Ingress.RoutingDecisionPayload[] {
  return decisions;
}
