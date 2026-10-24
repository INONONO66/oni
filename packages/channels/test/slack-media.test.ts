import { describe, expect, test } from "bun:test";
import type { Outbound } from "@oni/protocol";
import { createSlackProvider } from "../src/provider/slack/provider";
import { injectedOptions } from "./helpers/injected";
import { SlackBotError } from "../src/provider/slack/sdk";
import { DM_CHANNEL, fakeSlackSdk, platformError } from "./helpers/slack-sdk";

const CREDENTIALS = { botToken: "xoxb-test", appToken: "xapp-test" };

describe("Slack outbound calls through the SDK", () => {
  test("uploads bytes into the thread with the caption as the share comment", async () => {
    const fake = fakeSlackSdk();
    const runtime = createSlackProvider(fake.sdk).create(CREDENTIALS, {}, () => undefined, {
      ...injectedOptions(),
      media: async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        name: "report.pdf",
        mime: "application/pdf",
      }),
    });
    const media: Outbound.Payload = {
      kind: "message",
      parts: [{ kind: "file", ref: "/report", name: "report.pdf", caption: "read this" }],
    };
    expect(
      await runtime.deliveryRoute?.("T1:U1", media, "upload-1", {
        channelId: "C1",
        threadId: "42.0",
      }),
    ).toEqual({ value: "accepted" });
    expect(fake.client.calls).toEqual([
      {
        method: "uploadFile",
        args: ["C1", [1, 2, 3], "report.pdf", { thread_ts: "42.0", initial_comment: "read this" }],
      },
    ]);
  });

  test("uses the short emoji name in addReaction", async () => {
    const fake = fakeSlackSdk();
    const runtime = createSlackProvider(fake.sdk).create(
      CREDENTIALS,
      {},
      () => undefined,
      injectedOptions(),
    );
    expect(
      await runtime.deliveryRoute?.(
        "T1:U1",
        { kind: "react", messageId: "42.1", emoji: "👍" },
        "react-1",
        {
          channelId: "C1",
        },
      ),
    ).toEqual({ value: "accepted", externalMessageId: "42.1" });
    expect(fake.client.calls).toEqual([{ method: "addReaction", args: ["C1", "42.1", "+1"] }]);
  });

  test("a replacing reaction removes the earlier name first; already settled states are accepted", async () => {
    const fake = fakeSlackSdk({
      fail: {
        removeReaction: () => platformError("no_reaction"),
        addReaction: () => platformError("already_reacted"),
      },
    });
    const runtime = createSlackProvider(fake.sdk).create(
      CREDENTIALS,
      {},
      () => undefined,
      injectedOptions(),
    );
    expect(
      await runtime.deliveryRoute?.(
        "T1:U1",
        { kind: "react", messageId: "42.1", emoji: "✅", replaces: "👀" },
        "react-2",
        { channelId: "C1" },
      ),
    ).toEqual({ value: "accepted", externalMessageId: "42.1" });
    expect(fake.client.calls).toEqual([
      { method: "removeReaction", args: ["C1", "42.1", "eyes"] },
      { method: "addReaction", args: ["C1", "42.1", "white_check_mark"] },
    ]);
  });

  test("a platform refusal of the reaction is rejected, never accepted", async () => {
    const fake = fakeSlackSdk({ fail: { addReaction: () => platformError("invalid_name") } });
    const runtime = createSlackProvider(fake.sdk).create(
      CREDENTIALS,
      {},
      () => undefined,
      injectedOptions(),
    );
    expect(
      await runtime.deliveryRoute?.(
        "T1:U1",
        { kind: "react", messageId: "42.1", emoji: "👍" },
        "react-3",
        {
          channelId: "C1",
        },
      ),
    ).toEqual({ value: "rejected" });
  });

  test("a conversation-less upload goes into the opened direct channel, never to a bare user id", async () => {
    const fake = fakeSlackSdk();
    const runtime = createSlackProvider(fake.sdk).create(CREDENTIALS, {}, () => undefined, {
      ...injectedOptions(),
      media: async () => ({ bytes: new Uint8Array([7]), name: "pic.png", mime: "image/png" }),
    });
    const media: Outbound.Payload = { kind: "message", parts: [{ kind: "image", ref: "/pic" }] };
    expect(await runtime.deliveryRoute?.("T1:U1", media, "upload-dm")).toEqual({
      value: "accepted",
    });
    expect(fake.client.calls).toEqual([
      { method: "openDm", args: ["U1"] },
      { method: "uploadFile", args: [DM_CHANNEL, [7], "pic.png", {}] },
    ]);
  });

  test.each([
    {
      name: "a platform refusal of the upload is rejected and a second attempt is permitted",
      error: () => platformError("not_in_channel"),
      value: "rejected",
      uploads: 2,
    },
    {
      name: "a reset during the upload is unknown and never re-uploaded under the same key",
      error: () =>
        new SlackBotError(
          "A request error occurred: read ECONNRESET",
          "slack_webapi_request_error",
        ),
      value: "unknown",
      uploads: 1,
    },
    {
      name: "a missing file in the completed upload response is unknown: the share may already be visible",
      error: () => new SlackBotError("No file returned in upload response", "file_not_found"),
      value: "unknown",
      uploads: 1,
    },
  ])("$name", async ({ error, value, uploads }) => {
    const fake = fakeSlackSdk({ fail: { uploadFile: error } });
    const runtime = createSlackProvider(fake.sdk).create(CREDENTIALS, {}, () => undefined, {
      ...injectedOptions(),
      media: async () => ({ bytes: new Uint8Array([1]), name: "a.pdf", mime: "application/pdf" }),
    });
    const media: Outbound.Payload = {
      kind: "message",
      parts: [{ kind: "file", ref: "/a", name: "a.pdf" }],
    };
    expect(await runtime.deliveryRoute?.("T1:U1", media, "upload-x", { channelId: "C1" })).toEqual({
      value,
    });
    await runtime.deliveryRoute?.("T1:U1", media, "upload-x", { channelId: "C1" });
    expect(fake.client.of("uploadFile")).toHaveLength(uploads);
  });

  test("refuses an unmapped emoji before any platform call", async () => {
    const fake = fakeSlackSdk();
    const runtime = createSlackProvider(fake.sdk).create(
      CREDENTIALS,
      {},
      () => undefined,
      injectedOptions(),
    );
    expect(
      await runtime.deliveryRoute?.(
        "T1:U1",
        { kind: "react", messageId: "42.1", emoji: "🦄" },
        "react-4",
        {
          channelId: "C1",
        },
      ),
    ).toEqual({ value: "rejected" });
    expect(fake.client.calls).toEqual([]);
  });

  test("downloads an inbound file by id with the platform's name and mime", async () => {
    const fake = fakeSlackSdk();
    const runtime = createSlackProvider(fake.sdk).create(CREDENTIALS, {}, () => undefined, injectedOptions());
    expect(await runtime.attachments?.("F-9", { maxBytes: 10, signal: new AbortController().signal })).toEqual({
      bytes: new TextEncoder().encode("F-9"),
      name: "F-9.txt",
      mime: "text/plain",
    });
    expect(fake.client.calls.at(-1)?.method).toBe("downloadFile");
  });
});
