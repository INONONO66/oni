import { afterEach, describe, expect, test } from "bun:test";
import type { Outbound } from "@openomni/protocol";
import { SlackProvider } from "../src/provider/slack/provider";
import { injectedOptions } from "./helpers/injected";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Slack outbound calls", () => {
  test("uploads bytes through the three-step external upload handshake", async () => {
    const calls: Array<{
      url: string;
      method: string;
      authorization: string | null;
      contentType: string | null;
      body: string | Uint8Array;
    }> = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          authorization: headers.get("Authorization"),
          contentType: headers.get("Content-Type"),
          body: init?.body instanceof Uint8Array ? init.body : String(init?.body),
        });
        if (String(input).endsWith("/files.getUploadURLExternal"))
          return Response.json({
            ok: true,
            upload_url: "https://upload.slack.example/one",
            file_id: "F1",
          });
        return Response.json({ ok: true });
      },
      { preconnect: originalFetch.preconnect },
    );
    const media: Outbound.Payload = {
      kind: "message",
      parts: [{ kind: "file", ref: "/report", name: "report.pdf", caption: "read this" }],
    };
    const runtime = SlackProvider.create(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      {},
      () => undefined,
      {
        ...injectedOptions(),
        media: async () => ({
          bytes: new Uint8Array([1, 2, 3]),
          name: "report.pdf",
          mime: "application/pdf",
        }),
      },
    );
    expect(
      await runtime.deliveryRoute?.("T1:U1", media, "upload-1", {
        channelId: "C1",
        threadId: "42.0",
      }),
    ).toEqual({ value: "accepted" });
    expect(calls).toEqual([
      {
        url: "https://slack.com/api/files.getUploadURLExternal",
        method: "POST",
        authorization: "Bearer xoxb-test",
        contentType: "application/json; charset=utf-8",
        body: '{"filename":"report.pdf","length":3}',
      },
      {
        url: "https://upload.slack.example/one",
        method: "POST",
        authorization: null,
        contentType: "application/pdf",
        body: new Uint8Array([1, 2, 3]),
      },
      {
        url: "https://slack.com/api/files.completeUploadExternal",
        method: "POST",
        authorization: "Bearer xoxb-test",
        contentType: "application/json; charset=utf-8",
        body: '{"files":[{"id":"F1","title":"report.pdf"}],"channel_id":"C1","thread_ts":"42.0","initial_comment":"read this"}',
      },
    ]);
  });

  test("uses the short emoji name in reactions.add", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers),
          body: String(init?.body),
        });
        return Response.json({ ok: true });
      },
      { preconnect: originalFetch.preconnect },
    );
    const runtime = SlackProvider.create(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      {},
      () => undefined,
      injectedOptions(),
    );
    expect(
      await runtime.deliveryRoute?.(
        "T1:U1",
        { kind: "react", messageId: "42.1", emoji: "👍" },
        "react-1",
        { channelId: "C1" },
      ),
    ).toEqual({ value: "accepted", externalMessageId: "42.1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://slack.com/api/reactions.add");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.get("Authorization")).toBe("Bearer xoxb-test");
    expect(calls[0]?.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      channel: "C1",
      timestamp: "42.1",
      name: "+1",
    });
    expect(
      await runtime.deliveryRoute?.(
        "T1:U1",
        { kind: "react", messageId: "42.1", emoji: "👍", remove: true },
        "react-2",
        { channelId: "C1" },
      ),
    ).toEqual({ value: "accepted", externalMessageId: "42.1" });
    expect(calls[1]?.url).toBe("https://slack.com/api/reactions.remove");
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({ channel: "C1", timestamp: "42.1", name: "+1" });
  });

  test("refuses an unmapped emoji before any platform call", async () => {
    const calls: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        calls.push(String(input));
        return Response.json({ ok: true });
      },
      { preconnect: originalFetch.preconnect },
    );
    const runtime = SlackProvider.create(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      {},
      () => undefined,
      injectedOptions(),
    );
    expect(
      await runtime.deliveryRoute?.(
        "T1:U1",
        { kind: "react", messageId: "42.1", emoji: "🦄" },
        "react-2",
        { channelId: "C1" },
      ),
    ).toEqual({ value: "rejected" });
    expect(calls).toEqual([]);
  });
});
