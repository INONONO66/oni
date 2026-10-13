import { createHmac } from "node:crypto";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Gateway, Ingress } from "@openomni/protocol";
import { match, type MatchDecision } from "../src/automation/matcher.js";
import { GitHubAdapter } from "../src/provider/github/surface.js";
import { WebhookAdapter } from "../src/provider/webhook/surface.js";
import { ingressInput } from "../src/router/automation/input.js";
import { createChannelStores } from "../src/router/stores.js";
import { openChannelStore } from "../src/store/sqlite/index.js";
import { signedWebhook } from "./helpers/github.js";
import { injectedOptions } from "./helpers/injected.js";

const webhookBody = '{ "kind": "ping" }';
const githubBody = JSON.stringify({
  action: "opened",
  sender: { login: "ci-bot", type: "Bot" },
  repository: { full_name: "owner/repo", owner: { login: "owner" }, name: "repo" },
  pull_request: {
    number: 123,
    title: "Update dependencies",
    body: null,
    user: { login: "owner", type: "User" },
  },
});

test.each([
  {
    name: "webhook",
    channelId: "hook-1",
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
    trigger: { type: "github", event: "pull_request.opened" },
    otherTrigger: { type: "github", event: "pull_request.closed" },
    adapter: () => new GitHubAdapter("secret", {}, () => undefined, injectedOptions()),
    request: () => signedWebhook(githubBody, "secret", "delivery-pr-123", "pull_request"),
  },
] as const)("$name signed driver delivery matches its automation and records the matched row", async (scenario) => {
  const db = new Database(":memory:");
  const stores = createChannelStores(openChannelStore(db, () => 0));
  const adapter = scenario.adapter();
  const decisions: MatchDecision[] = [];
  const inputs: Ingress.Input[] = [];
  try {
    for (const [id, trigger] of [["other", scenario.otherTrigger], ["selected", scenario.trigger]] as const) {
      stores.automations.add(Ingress.Automation.parse({
        id, name: id, enabled: true, createdBy: "owner", triggers: [trigger],
        conditions: { channels: [scenario.channelId] }, target: "session:worker",
      }));
    }
    adapter.onMessage(async (message) => {
      expect(message.sender.kind).toBe("external");
      if (message.sender.kind !== "external") return;
      const { input } = ingressInput(stores, message.sender, Gateway.IngressFacts.parse(message.facts), 0);
      inputs.push(input);
      const decision = match(stores.automations.list().map((entry) => entry.record), input, { now: 0 });
      decisions.push(decision);
      for (const row of decision.rows) stores.automations.record(row);
    });

    const response = await adapter.handleWebhook(scenario.request());

    expect(response.status).toBe(200);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.route).toMatchObject({
      kind: "action", target: "session:worker", handlerRef: "automation/selected",
      body: { trigger: scenario.trigger, event: { channelId: scenario.channelId } },
    });
    expect(inputs[0]).toMatchObject({ event: scenario.name, channelId: scenario.channelId });
    expect(stores.automations.decisions(inputs[0]?.eventId ?? "")).toEqual([
      expect.objectContaining({ stage: "automation", decision: "matched", by: "automation/selected" }),
    ]);
  } finally {
    adapter.stop("trace");
    db.close();
  }
});
