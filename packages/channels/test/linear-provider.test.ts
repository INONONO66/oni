import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { type Channel, Gateway, Operational, Outbound } from "@openomni/protocol";
import { z } from "zod";
import type { OwnerPosture } from "../src/provider/contract";
import { LinearProvider } from "../src/provider/linear/provider";
import { LINEAR_REPLAY_WINDOW_MS } from "../src/provider/linear/surface";
import type { PublishPort } from "../src/types";
import { FIXED_NOW, injectedOptions } from "./helpers/injected";

const SECRET = "linear-signing-secret";
const OWNER = { id: "user-owner", name: "ino", displayName: "Ino" };
const DEFAULT_INTAKE: OwnerPosture = { intake: "mentions_and_dms", autoReply: false };
const ALL: OwnerPosture = { intake: "all", autoReply: false };

const arm = () => {
  const owner = LinearProvider.owner;
  if (owner === undefined) throw new Error("linear has no owner arm");
  return owner;
};

/** Every GraphQL call recorded; the viewer answered as the Owner, the rest scripted. */
function linearApi(script: { readonly comment?: () => Response; readonly lookup?: () => Response; readonly viewer?: () => Response } = {}) {
  const requests: { query: string; variables: Record<string, { id?: string; issueId?: string; body?: string } | string> }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      if (request.query.includes("viewer")) return script.viewer?.() ?? Response.json({ data: { viewer: OWNER } });
      if (request.query.includes("comment(id")) return script.lookup?.() ?? Response.json({ data: { comment: null }, errors: [{ message: "Entity not found", extensions: { code: "ENTITY_NOT_FOUND" } }] });
      return script.comment?.() ?? Response.json({ data: { commentCreate: { success: true, comment: { id: "comment-new" } } } });
    },
    { preconnect: realFetch.preconnect },
  );
  return {
    requests,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

function envelope(overrides: Record<string, object | string | number | null> = {}) {
  return {
    action: "create",
    type: "Comment",
    actor: { id: "user-1", name: "Friend", type: "user" },
    createdAt: "2026-10-17T00:00:00.000Z",
    data: { id: "comment-1", body: "@Ino please look at this", issueId: "issue-1", userId: "user-1", issue: { id: "issue-1", identifier: "ENG-42", title: "Flaky build" } },
    url: "https://linear.app/acme/issue/ENG-42#comment-comment-1",
    webhookTimestamp: FIXED_NOW,
    organizationId: "org-1",
    ...overrides,
  };
}

function signed(body: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost/linear/webhook", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "linear-signature": createHmac("sha256", SECRET).update(body).digest("hex"),
      "linear-delivery": "delivery-1",
      ...headers,
    },
  });
}

async function started(
  posture: OwnerPosture = DEFAULT_INTAKE,
  credentials: { secret: string; token?: string; ownerUserId?: string } = { secret: SECRET, token: "lin_api_key" },
  publish: PublishPort = () => undefined,
  handler?: Channel.MessageHandler,
) {
  const received: Channel.InboundMessage[] = [];
  const runtime = arm().create(credentials, posture, publish, injectedOptions());
  runtime.surface.onMessage(
    handler ??
      (async (message) => {
        received.push(message);
      }),
  );
  await runtime.surface.start("boot");
  return { runtime, received };
}

describe("Linear as the Owner's own account (#1569 lane 9b): the linear:owner instance", () => {
  it("under mentions_and_dms a comment naming the Owner is a mention received by the Owner; one that does not, and a new issue, are not intake", async () => {
    const api = linearApi();
    try {
      const { runtime, received } = await started();
      expect(runtime.surface.id).toBe("linear:owner");
      expect(api.requests[0]?.query).toContain("viewer");
      expect((await runtime.webhookHandler?.(signed(JSON.stringify(envelope()))))?.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]?.sender).toEqual({ kind: "external", surface: "linear", externalId: "user-1" });
      expect(Gateway.IngressFacts.parse(received[0]?.facts)).toMatchObject({
        eventId: "delivery-1",
        surface: "linear",
        event: "mention",
        workspaceId: "org-1",
        channelId: "issue-1",
        author: { externalId: "user-1", isBot: false },
        addressees: [{ externalId: "user-owner" }],
        dm: false,
        receivedBy: "owner",
        reply: { chain: [], threadId: "issue-1", externalConversationId: "linear:issue-1" },
        render: "@Ino please look at this",
      });
      const byId = envelope({ data: { id: "comment-2", body: "cc user-owner", issueId: "issue-1", userId: "user-2" } });
      expect(await (await runtime.webhookHandler?.(signed(JSON.stringify(byId), { "linear-delivery": "delivery-2" })))?.text()).toBe("OK");
      const aside = envelope({ data: { id: "comment-3", body: "unrelated chatter", issueId: "issue-1", userId: "user-2" } });
      expect(await (await runtime.webhookHandler?.(signed(JSON.stringify(aside), { "linear-delivery": "delivery-3" })))?.text()).toBe("Not addressed to the Owner");
      const issue = envelope({ type: "Issue", data: { id: "issue-2", identifier: "ENG-43", title: "@Ino dark mode", description: null, creatorId: "user-2" } });
      expect(await (await runtime.webhookHandler?.(signed(JSON.stringify(issue), { "linear-delivery": "delivery-4" })))?.text()).toBe("Not addressed to the Owner");
      expect(received.map((message) => message.facts.eventId)).toEqual(["delivery-1", "delivery-2"]);
    } finally {
      api.restore();
    }
  });

  it("under all every new issue and comment is intake, nulls and all; the Owner's own actions never are; under none the door answers without reading", async () => {
    const api = linearApi();
    try {
      const { runtime, received } = await started(ALL);
      const issue = envelope({ type: "Issue", actor: null, data: { id: "issue-3", identifier: null, title: "No description", description: null, creatorId: null, teamId: null }, url: null, organizationId: null });
      expect((await runtime.webhookHandler?.(signed(JSON.stringify(issue))))?.status).toBe(200);
      expect(received[0]?.facts).toMatchObject({ event: "linear", channelId: "issue-3", author: { externalId: "linear" }, render: "No description", addressees: [], reply: { threadId: "issue-3" } });
      expect("workspaceId" in (received[0]?.facts ?? {})).toBe(false);
      const described = envelope({ type: "Issue", actor: null, data: { id: "issue-4", identifier: "ENG-44", title: "Dark mode", description: "Please add it.", creatorId: "user-2" } });
      expect((await runtime.webhookHandler?.(signed(JSON.stringify(described), { "linear-delivery": "delivery-2" })))?.status).toBe(200);
      expect(received[1]?.facts).toMatchObject({ render: "Dark mode\n\nPlease add it.", author: { externalId: "user-2" } });
      const own = envelope({ actor: { id: "user-owner" }, data: { id: "comment-9", body: "my own reply", issueId: "issue-1", userId: "user-owner" } });
      expect(await (await runtime.webhookHandler?.(signed(JSON.stringify(own), { "linear-delivery": "delivery-own" })))?.text()).toBe("Own action");
      expect(received).toHaveLength(2);
      const off = await started({ intake: "none", autoReply: false });
      expect(await (await off.runtime.webhookHandler?.(signed(JSON.stringify(envelope()))))?.text()).toBe("Intake off");
      expect(off.received).toEqual([]);
    } finally {
      api.restore();
    }
  });

  it("a missing or wrong signature, a stamp outside Linear's minute and an unreadable payload are refused before anything is read", async () => {
    const api = linearApi();
    try {
      const { runtime, received } = await started(ALL);
      const body = JSON.stringify(envelope());
      const unsigned = new Request("http://localhost/linear/webhook", { method: "POST", body });
      expect(await (await runtime.webhookHandler?.(unsigned))?.text()).toBe("Missing signature");
      const forged = signed(body, { "linear-signature": createHmac("sha256", "other").update(body).digest("hex") });
      expect(await (await runtime.webhookHandler?.(forged))?.text()).toBe("Invalid signature");
      // A header of the right character count but the wrong bytes is a refusal, never a throw.
      const odd = signed(body, { "linear-signature": `${"é".repeat(32)}${"a".repeat(0)}`.padEnd(64, "a").slice(0, 64) });
      expect((await runtime.webhookHandler?.(odd))?.status).toBe(401);
      const stale = await runtime.webhookHandler?.(signed(JSON.stringify(envelope({ webhookTimestamp: FIXED_NOW - LINEAR_REPLAY_WINDOW_MS - 1 }))));
      expect(await stale?.text()).toBe("Stale timestamp");
      expect((await runtime.webhookHandler?.(signed(JSON.stringify(envelope({ webhookTimestamp: FIXED_NOW + LINEAR_REPLAY_WINDOW_MS + 1 })))))?.status).toBe(401);
      // Within the minute, a fresh delivery is read.
      const fresh = signed(JSON.stringify(envelope({ webhookTimestamp: FIXED_NOW - 59_000 })), { "linear-delivery": "delivery-fresh" });
      expect((await runtime.webhookHandler?.(fresh))?.status).toBe(200);
      expect((await runtime.webhookHandler?.(signed("not json")))?.status).toBe(400);
      expect((await runtime.webhookHandler?.(signed(JSON.stringify({ action: "create" }))))?.status).toBe(400);
      expect(received).toHaveLength(1);
    } finally {
      api.restore();
    }
  });

  it("a repeated delivery and an unsupported event are answered without a handoff; the router's refusal is 200, a failure releases the claim and is 500", async () => {
    const api = linearApi();
    const warns: string[] = [];
    const publish: PublishPort = (event, data) => {
      if (event.name === Operational.Events.Warn.name) warns.push(z.object({ msg: z.string() }).parse(data).msg);
    };
    try {
      let attempts = 0;
      const { runtime, received } = await started(ALL, { secret: SECRET, token: "lin_api_key" }, publish, async (message) => {
        attempts += 1;
        if (attempts === 1) throw new Error("ledger closed");
        if (attempts === 2) throw Object.assign(new Error("message admission refused: message.external.grant_tier"), { name: "MessageAdmissionRefused" });
        received.push(message);
      });
      const body = JSON.stringify(envelope());
      expect((await runtime.webhookHandler?.(signed(body)))?.status).toBe(500);
      expect(await (await runtime.webhookHandler?.(signed(body)))?.text()).toBe("Not ingested");
      expect(await (await runtime.webhookHandler?.(signed(body)))?.text()).toBe("Already processed");
      expect(received).toEqual([]);
      const updated = envelope({ action: "update" });
      const observed = await runtime.webhookHandler?.(signed(JSON.stringify(updated), { "linear-delivery": "delivery-upd" }));
      expect(await observed?.json()).toEqual({ kind: "unsupported_event", type: "Comment", action: "update", reason: "unsupported_action" });
      const project = envelope({ type: "Project", data: { id: "p-1" } });
      expect(await (await runtime.webhookHandler?.(signed(JSON.stringify(project), { "linear-delivery": "delivery-prj" })))?.json()).toMatchObject({ reason: "unsupported_event" });
      const malformed = envelope({ data: { id: "comment-2" } });
      expect(await (await runtime.webhookHandler?.(signed(JSON.stringify(malformed), { "linear-delivery": "delivery-bad" })))?.json()).toMatchObject({ reason: "invalid_payload" });
      expect(warns).toEqual(["linear event not ingested", "linear event not ingested", "linear event not ingested", "linear event not ingested"]);
    } finally {
      api.restore();
    }
  });

  it("a reply lands as the Owner's comment on the issue the conversation names, once per key — a re-run finds the comment it already posted; refusals and unconfirmed answers are evidence-based receipts", async () => {
    const api = linearApi();
    try {
      const { runtime } = await started(ALL);
      const route = runtime.deliveryRoute;
      if (route === undefined) throw new Error("linear mounts no delivery route");
      expect((await route("user-1", Outbound.payload("on it"), "k-1")).value).toBe("rejected");
      expect(await route("user-1", Outbound.payload("on it"), "k-1", { channelId: "issue-1" })).toEqual({ value: "accepted", externalMessageId: "comment-new" });
      const posted = api.requests.filter((request) => request.query.includes("commentCreate"));
      expect(posted).toHaveLength(1);
      const input = posted[0]?.variables.input;
      expect(input).toMatchObject({ issueId: "issue-1", body: "on it" });
      expect(typeof input === "object" ? input.id : "").toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      // The same key in a fresh process: the lookup finds the comment, nothing is posted again.
      const found = linearApi({ lookup: () => Response.json({ data: { comment: { id: typeof input === "object" ? input.id : "" } } }) });
      try {
        const again = await started(ALL);
        expect(await again.runtime.deliveryRoute?.("user-1", Outbound.payload("on it"), "k-1", { channelId: "issue-1" })).toEqual({
          value: "accepted",
          externalMessageId: typeof input === "object" ? input.id : "",
        });
        expect(found.requests.filter((request) => request.query.includes("commentCreate"))).toEqual([]);
      } finally {
        found.restore();
      }
      const refused = linearApi({ comment: () => Response.json({ data: { commentCreate: null }, errors: [{ message: "Entity not found: Issue", extensions: { code: "ENTITY_NOT_FOUND" } }] }) });
      try {
        const { runtime: refusing } = await started(ALL);
        expect((await refusing.deliveryRoute?.("user-1", Outbound.payload("x"), "k-2", { channelId: "issue-9" }))?.value).toBe("rejected");
      } finally {
        refused.restore();
      }
      const limited = linearApi({ comment: () => Response.json({ errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }] }, { status: 400 }) });
      try {
        const { runtime: throttled } = await started(ALL);
        expect((await throttled.deliveryRoute?.("user-1", Outbound.payload("x"), "k-3", { channelId: "issue-1" }))?.value).toBe("rejected");
      } finally {
        limited.restore();
      }
      const unsure = linearApi({ comment: () => Response.json({ data: { commentCreate: null }, errors: [{ message: "Something went wrong", extensions: { code: "INTERNAL_ERROR" } }] }) });
      try {
        const { runtime: unconfirmed } = await started(ALL);
        expect((await unconfirmed.deliveryRoute?.("user-1", Outbound.payload("x"), "k-4", { channelId: "issue-1" }))?.value).toBe("unknown");
      } finally {
        unsure.restore();
      }
      const garbled = linearApi({ comment: () => new Response("not json", { status: 200 }) });
      try {
        const { runtime: unreadable } = await started(ALL);
        expect((await unreadable.deliveryRoute?.("user-1", Outbound.payload("x"), "k-5", { channelId: "issue-1" }))?.value).toBe("unknown");
        expect((await unreadable.deliveryRoute?.("user-1", { kind: "react", messageId: "comment-1", emoji: "👍" }, "k-6", { channelId: "issue-1" }))?.value).toBe("rejected");
      } finally {
        garbled.restore();
      }
    } finally {
      api.restore();
    }
  });

  it("without an API key the instance is ingress-only, a reply loudly not sent and mentions by name unread; a key that cannot name its user fails the start", async () => {
    const api = linearApi();
    const warns: string[] = [];
    const publish: PublishPort = (event, data) => {
      if (event.name === Operational.Events.Warn.name) warns.push(z.object({ msg: z.string() }).parse(data).msg);
    };
    try {
      const keyless = await started(ALL, { secret: SECRET, ownerUserId: "user-owner" }, publish);
      expect(api.requests).toEqual([]);
      expect((await keyless.runtime.deliveryRoute?.("user-1", Outbound.payload("x"), "k-1", { channelId: "issue-1" }))?.value).toBe("rejected");
      expect(warns).toEqual(["linear api key missing — reply not posted"]);
      const own = envelope({ actor: { id: "user-owner" }, data: { id: "comment-9", body: "mine", issueId: "issue-1", userId: "user-owner" } });
      expect(await (await keyless.runtime.webhookHandler?.(signed(JSON.stringify(own))))?.text()).toBe("Own action");
      // #1600 lane R3: keyless and nameless under mentions_and_dms nothing could ever name the Owner — the start refuses rather than mounting deaf; under `all` it reads everything.
      await expect(started(DEFAULT_INTAKE, { secret: SECRET })).rejects.toMatchObject({ _tag: "ChannelsFailure", operation: "linear.owner.start" });
      const everything = await started(ALL, { secret: SECRET });
      expect(await (await everything.runtime.webhookHandler?.(signed(JSON.stringify(envelope()))))?.status).toBe(200);
      expect(everything.received).toHaveLength(1);
    } finally {
      api.restore();
    }
    const mute = linearApi({ viewer: () => Response.json({ data: { viewer: null } }) });
    try {
      const runtime = arm().create({ secret: SECRET, token: "lin_api_key" }, ALL, () => undefined, injectedOptions());
      runtime.surface.onMessage(async () => undefined);
      await expect(runtime.surface.start("boot")).rejects.toMatchObject({ _tag: "ChannelsFailure", operation: "linear.owner.start" });
    } finally {
      mute.restore();
    }
  });

  it("the provider is Owner-only: the owner arm declares what the runtime exposes and admits only the Owner's shape; the bot arm refuses", () => {
    expect(LinearProvider.capabilities).toMatchObject({ deliver: true, webhook: true, react: false, typing: false, media: false });
    expect(LinearProvider.credentials.safeParse({ secret: "s" }).success).toBe(false);
    expect(() => LinearProvider.create({} as never, {}, () => undefined, injectedOptions())).toThrow("identity: owner");
    expect(arm().credentials.safeParse({ secret: "s" }).success).toBe(true);
    expect(arm().credentials.safeParse({ secret: "s", token: "t", ownerUserId: "u" }).success).toBe(true);
    expect(arm().credentials.safeParse({ token: "t" }).success).toBe(false);
    expect(arm().credentials.safeParse({ secret: "s", extra: 1 }).success).toBe(false);
    const runtime = arm().create({ secret: SECRET }, DEFAULT_INTAKE, () => undefined, injectedOptions());
    expect(runtime.surface.id).toBe("linear:owner");
    expect(runtime.deliveryRoute).toBeDefined();
    expect(runtime.webhookHandler).toBeDefined();
    expect(runtime.typingRoute).toBeUndefined();
  });
});
