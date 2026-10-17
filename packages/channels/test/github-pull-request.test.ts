import { createHmac } from "node:crypto";
import { expect, test } from "bun:test";
import type { Channel } from "@openomni/protocol";
import { GitHubAdapter } from "../src/provider/github/surface";
import { injectedOptions } from "./helpers/injected";

test("GitHub pull_request opened carries sender bot fact and PR identity", async () => {
  const payload = {
    action: "opened",
    sender: { login: "ci-bot", type: "Bot" },
    repository: { full_name: "owner/repo", owner: { login: "owner" }, name: "repo" },
    pull_request: {
      number: 12,
      title: "Update dependencies",
      body: null,
      user: { login: "owner", type: "User" },
    },
  };
  const body = JSON.stringify(payload);
  const received: Channel.InboundMessage[] = [];
  const adapter = new GitHubAdapter("secret", {}, () => undefined, injectedOptions());
  adapter.onMessage(async (message) => {
    received.push(message);
  });
  await adapter.start("trace");
  const response = await adapter.handleWebhook(
    new Request("http://localhost/github/webhook", {
      method: "POST",
      body,
      headers: {
        "x-hub-signature-256": `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`,
        "x-github-event": "pull_request",
        "x-github-delivery": "event-pr-12",
      },
    }),
  );
  expect(response.status).toBe(200);
  expect(received).toHaveLength(1);
  expect(received[0]?.facts).toMatchObject({
    event: "github",
    githubEvent: "pull_request.opened",
    author: { externalId: "ci-bot", isBot: true },
    channelId: "owner/repo#12",
    render: "Update dependencies",
  });
});
