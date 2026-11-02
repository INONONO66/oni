import { createHmac } from "node:crypto";
import { beforeEach, expect, test } from "bun:test";
import { type Channel, Gateway, Ingress } from "@oni/protocol";
import { GitHubAdapter } from "../src/provider/github/surface.js";
import { WebhookAdapter } from "../src/provider/webhook/surface.js";
import { inboundIdOf } from "../src/router/inbound-id.js";
import { runEffect } from "./helpers/effect.js";
import { signedWebhook } from "./helpers/github.js";
import { injectedOptions } from "./helpers/injected.js";
import { ledger } from "./helpers/ledger.js";
import { commits, makeRouter, resetRouterState, routingDecisions } from "./router/_router-fixture.js";

// Signed drivers and the real router share the same instance rule contract.

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
    channelId: "owner/repo#123",
    sender: { surface: "github", externalId: "maintainer", workspace: "owner/repo" },
    adapter: () => new GitHubAdapter("secret", {}, () => undefined, injectedOptions()),
    request: () => signedWebhook(githubBody, "secret", "delivery-pr-123", "pull_request"),
  },
] as const;

type Scenario = (typeof scenarios)[number];

beforeEach(resetRouterState);

function addRules(scenario: Scenario): void {
  for (const [position, id] of ["other", "selected"].entries()) {
    ledger().stores.rules.add(Ingress.Rule.parse({
      id, position, enabled: true, createdBy: "owner",
      when: { instance: id === "selected" ? "channel:test:main" : "other", channel: scenario.channelId, from: [scenario.sender.externalId] },
      outcome: { kind: "deliver", target: "session:worker", deliveryKind: "action", reply: "none" },
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
  "$name signed delivery from an identified sender matches its instance rule through the router",
  async (scenario) => {
    identifySender(scenario);
    addRules(scenario);

    const { facts, result, inboundId } = await deliver(scenario);

    expect(facts).toMatchObject({ event: scenario.name, channelId: scenario.channelId });
    expect(result).toMatchObject({ status: "executed", handle: { target: "worker" } });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ sessionId: "worker", kind: "action" });
    expect(commits[0]?.origin.value).toMatchObject({ source: "ingress", handlerRef: "rule/selected" });
    expect(routingDecisions()).toContainEqual(expect.objectContaining({
      outcome: "route", stage: "surface_default", actorId: "observer",
      factsUsed: expect.arrayContaining(["rule:selected"]),
    }));
    expect(ledger().stores.rules.decisions(inboundId)).toEqual([
      expect.objectContaining({ stage: "automation", decision: "matched", by: "rule/selected" }),
    ]);
  },
);

test.each([...scenarios])(
  "$name signed delivery records only when its rule does not match",
  async (scenario) => {
    addRules(scenario);
    ledger().stores.rules.disable("selected");

    const { result, inboundId } = await deliver(scenario);

    expect(result).toMatchObject({ status: "blocked_pre", reasonCode: "none" });
    expect(commits).toHaveLength(0);
    expect(routingDecisions()).toContainEqual(expect.objectContaining({
      outcome: "record", stage: "automation", by: "rule/none",
    }));
    expect(ledger().stores.rules.decisions(inboundId)).toEqual([expect.objectContaining({ by: "rule/none" })]);
  },
);
