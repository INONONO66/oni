import { createHmac } from "node:crypto";
import { injectedOptions } from "./helpers/injected";
import { expect, test } from "bun:test";
import { Gateway, Outbound, type Channel } from "@openomni/protocol";
import { GitHubAdapter } from "../src/provider/github/surface";

for (const text of ["ambient event", "@owner review @bot", "@bot"]) {
  test(`GitHub authenticated webhook preserves platform facts: ${text}`, async () => {
    const payload = {
      action: "created",
      sender: { login: "sender", type: "Bot" },
      repository: { full_name: "owner/repo", owner: { login: "owner" }, name: "repo" },
      issue: { number: 7, title: "issue", user: { login: "owner", type: "User" } },
      comment: { id: 42, body: text, user: { login: "sender", type: "Bot" } },
    };
    const body = JSON.stringify(payload);
    const received: Channel.InboundMessage[] = [];
    const adapter = new GitHubAdapter("secret", {}, () => undefined, injectedOptions());
    adapter.onMessage(async (message) => {
      received.push(message);
    });
    await adapter.start("trace");
    try {
      const response = await adapter.handleWebhook(
        new Request("http://localhost/github/webhook", {
          method: "POST",
          body,
          headers: {
            "x-hub-signature-256": `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`,
            "x-github-event": "issue_comment",
            "x-github-delivery": "event-42",
          },
        }),
      );
      expect(response.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]?.sender).toEqual({
        kind: "external",
        surface: "github",
        externalId: "sender",
      });
      const facts = Gateway.IngressFacts.parse(received[0]?.facts);
      expect(facts.payload).toEqual(payload);
      expect(facts).toMatchObject({
        eventId: "event-42",
        event: "github",
        githubEvent: "issue_comment.created",
        author: { externalId: "sender", isBot: true },
        workspaceId: "owner/repo",
        channelId: "issue-7",
        dm: false,
        render: text,
      });
      expect(facts.addressees).toEqual(
        text === "ambient event"
          ? []
          : text === "@bot"
            ? [{ externalId: "bot" }]
            : [{ externalId: "owner" }, { externalId: "bot" }],
      );
      expect(facts.reply).toEqual({
        chain: [],
        threadId: "7",
        externalConversationId: "github:owner/repo:issue:7",
      });
    } finally {
      adapter.stop("trace");
    }
  });
}

for (const value of ["sent", "not_sent", "unknown"] as const) {
  test(`GitHub actor delivery reports ${value} through its real client`, async () => {
    const realFetch = globalThis.fetch;
    let posts = 0;
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "GET") return Response.json([]);
        posts += 1;
        if (value === "unknown") throw new TypeError("connection reset");
        return Response.json({ id: 99 }, { status: value === "sent" ? 201 : 403 });
      },
      { preconnect: realFetch.preconnect },
    );
    try {
      const adapter = new GitHubAdapter("secret", {}, () => undefined, injectedOptions(), "token");
      expect(await adapter.deliver("owner/repo#7", Outbound.payload("content"), "stable-key")).toEqual(
        value === "sent" ? { value, externalMessageId: "99" } : { value },
      );
      expect(posts).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}

test("GitHub reports a refused connection as not_sent, like every other driver", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET") return Response.json([]);
      throw Object.assign(new TypeError("Unable to connect"), { code: "ECONNREFUSED" });
    },
    { preconnect: realFetch.preconnect },
  );
  try {
    const adapter = new GitHubAdapter("secret", {}, () => undefined, injectedOptions(), "token");
    expect(await adapter.deliver("owner/repo#7", Outbound.payload("content"), "refused-key")).toEqual({
      value: "not_sent",
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("GitHub refuses malformed destinations and missing credentials before effects", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls += 1;
      return Response.json({});
    },
    { preconnect: realFetch.preconnect },
  );
  try {
    const adapter = new GitHubAdapter("secret", {}, () => undefined, injectedOptions());
    for (const endpoint of [
      "owner/repo#7",
      "owner/repo",
      "owner/..#7",
      "owner/repo#999999999999999999999",
    ])
      expect(await adapter.deliver(endpoint, Outbound.payload("content"), endpoint)).toEqual({ value: "not_sent" });
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
