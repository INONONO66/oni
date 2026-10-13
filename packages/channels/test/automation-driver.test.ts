import { createHmac } from "node:crypto";
import { beforeEach, expect, test } from "bun:test";
import { type Channel, Gateway, Ingress } from "@openomni/protocol";
import { GitHubAdapter } from "../src/provider/github/surface.js";
import { WebhookAdapter } from "../src/provider/webhook/surface.js";
import { inboundIdOf } from "../src/router/inbound-id.js";
import { runEffect } from "./helpers/effect.js";
import { signedWebhook } from "./helpers/github.js";
import { injectedOptions } from "./helpers/injected.js";
import { ledger } from "./helpers/ledger.js";
import { commits, makeRouter, resetRouterState, routingDecisions } from "./router/_router-fixture.js";

// Both deliveries pass through the real signed driver and the real GatewayRouter.ingest.
// On the pre-#1457 matcher the drivers emit `event: "message"` and the trigger selector
// compares `channelId`, so no automation matches: the identified sender is blocked at
// `message.external.grant_tier` with no `matched` row and no commit (the negative branch
// below is what the positive branch looked like before the fix).

const webhookBody = '{ "kind": "ping" }';
const githubBody = JSON.stringify({
  action: "opened",
  sender: { login: "maintainer", type: "User" },
  repository: { full_name: "owner/repo", owner: { login: "owner" }, name: "repo" },
  pull_request: {
    number: 123,
    title: "Update dependencies",
    body: null,
    user: { login: "owner", type: "User" },
  },
});

const scenarios = [
  {
    name: "webhook",
    channelId: "hook-1",
    sender: { surface: "webhook", externalId: "secret:hook-1", workspace: undefined },
    trigger: { type: "webhook", secretRef: "secret:hook-1" },
    otherTrigger: { type: "webhook", secretRef: "hook-1" },
    adapter: () => new WebhookAdapter(
      { id: "hook-1", secretRef: "secret:hook-1" },
      {},
      () => undefined,
      injectedOptions(),
      async (ref) => ref === "secret:hook-1" ? "shared-secret" : undefined,
    ),
    request: () => new Request("http://localhost/webhook", {
      method: "POST",
      body: webhookBody,
      headers: {
        "content-type": "application/json",
        "x-signature": `sha256=${createHmac("sha256", "shared-secret").update(webhookBody).digest("hex")}`,
      },
    }),
  },
  {
    name: "github",
    channelId: "pr-123",
    sender: { surface: "github", externalId: "maintainer", workspace: "owner/repo" },
    trigger: { type: "github", event: "pull_request.opened" },
    otherTrigger: { type: "github", event: "pull_request.closed" },
    adapter: () => new GitHubAdapter("secret", {}, () => undefined, injectedOptions()),
    request: () => signedWebhook(githubBody, "secret", "delivery-pr-123", "pull_request"),
  },
] as const;

type Scenario = (typeof scenarios)[number];

beforeEach(resetRouterState);

function addAutomations(scenario: Scenario): void {
  for (const [id, trigger] of [["other", scenario.otherTrigger], ["selected", scenario.trigger]] as const) {
    ledger().stores.automations.add(Ingress.Automation.parse({
      id, name: id, enabled: true, createdBy: "owner", triggers: [trigger],
      conditions: { channels: [scenario.channelId] }, target: "session:worker",
    }));
  }
}

function identifySender(scenario: Scenario): void {
  ledger().stores.actors.registerIdentity({ id: "observer", kind: "human", trustTier: "observer" });
  ledger().stores.actors.registerEndpoint({
    id: "observer-endpoint", actorId: "observer", channel: scenario.sender.surface,
    externalId: scenario.sender.externalId,
    ...(scenario.sender.workspace === undefined ? {} : { workspace: scenario.sender.workspace }),
  });
}

async function deliver(scenario: Scenario) {
  const adapter = scenario.adapter();
  const router = makeRouter();
  const received: { facts: Gateway.IngressFacts; result: Gateway.IngestResult }[] = [];
  try {
    adapter.onMessage(async (message: Channel.InboundMessage) => {
      const facts = Gateway.IngressFacts.parse(message.facts);
      received.push({ facts, result: await runEffect(router.ingest(message.sender, facts)) });
    });
    const response = await adapter.handleWebhook(scenario.request());
    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    const delivery = received[0];
    if (delivery === undefined) throw new Error("expected one delivery");
    return { ...delivery, inboundId: inboundIdOf(delivery.facts) };
  } finally {
    adapter.stop("trace");
  }
}

test.each([...scenarios])(
  "$name signed delivery from an identified sender matches its trigger through the router",
  async (scenario) => {
    identifySender(scenario);
    addAutomations(scenario);

    const { facts, result, inboundId } = await deliver(scenario);

    expect(facts).toMatchObject({ event: scenario.name, channelId: scenario.channelId });
    expect(result).toMatchObject({ status: "executed", handle: { target: "worker" } });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ sessionId: "worker", kind: "action" });
    expect(commits[0]?.origin.value).toMatchObject({ source: "ingress", handlerRef: "automation/selected" });
    expect(routingDecisions()).toContainEqual(expect.objectContaining({
      outcome: "route", stage: "surface_default", actorId: "observer",
      factsUsed: expect.arrayContaining(["automation:selected"]),
    }));
    expect(ledger().stores.automations.decisions(inboundId)).toEqual([
      expect.objectContaining({ stage: "automation", decision: "matched", by: "automation/selected" }),
    ]);
  },
);

test.each([...scenarios])(
  "$name signed delivery from an unidentified sender stays blocked at the channel ceiling",
  async (scenario) => {
    addAutomations(scenario);

    const { result, inboundId } = await deliver(scenario);

    expect(result).toMatchObject({ status: "blocked_pre", reasonCode: "message.external.grant_tier" });
    expect(commits).toHaveLength(0);
    expect(routingDecisions()).toContainEqual(expect.objectContaining({
      outcome: "block", stage: "channel_ceiling",
    }));
    expect(ledger().stores.automations.decisions(inboundId)).toEqual([]);
  },
);
