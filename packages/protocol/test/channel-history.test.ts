import { expect, test } from "bun:test";
import { Channel } from "../src";

const attachment = { kind: "audio", ref: "opaque:file/α", name: "voice.ogg", mime: "audio/ogg", bytes: 0, voice: true } as const;
const message = {
  chatId: "chat:-1", messageId: "msg:3", senderId: "sender:2", outgoing: false,
  text: "hello", timestampMs: 0, attachments: [attachment],
  replyToMessageId: "msg:1", threadId: "topic:9",
};
const request = { type: "channel_history" as const, requestId: "req:1", instanceId: "telegram:owner", chatId: "chat:-1", before: "opaque:cursor/-2", limit: 50 };

test("history wire accepts opaque identities, cursors, and media metadata", () => {
  expect(Channel.HistoryRequest.parse(request)).toEqual(request);
  const response = { type: "channel_history_page" as const, requestId: request.requestId, instanceId: request.instanceId, page: { messages: [message], before: "opaque:cursor/-3" } };
  expect(Channel.HistoryResponse.parse(response)).toEqual(response);
  expect(Channel.HistoryResponse.parse({ type: "channel_history_refused", requestId: "req:1", reason: "owner_auth_required", detail: "denied" })).toMatchObject({ reason: "owner_auth_required" });
  for (const reason of Channel.HistoryRefusalReason.options) {
    expect(Channel.HistoryRefused.safeParse({ type: "channel_history_refused", requestId: "req:1", reason, detail: "refused" }).success).toBe(true);
  }
});

test("history refuses unknown fields, empty and long ids, and invalid page metadata", () => {
  expect(Channel.HistoryRequest.safeParse({ ...request, caller: "owner" }).success).toBe(false);
  for (const id of ["", "x".repeat(513), 3]) {
    expect(Channel.HistoryRequest.safeParse({ ...request, requestId: id }).success).toBe(false);
    expect(Channel.HistoryRequest.safeParse({ ...request, instanceId: id }).success).toBe(false);
    expect(Channel.HistoryRequest.safeParse({ ...request, chatId: id }).success).toBe(false);
    expect(Channel.HistoryRequest.safeParse({ ...request, before: id }).success).toBe(false);
    expect(Channel.HistoryPage.safeParse({ messages: [{ ...message, messageId: id }] }).success).toBe(false);
    expect(Channel.HistoryPage.safeParse({ messages: [{ ...message, attachments: [{ ...attachment, ref: id }] }] }).success).toBe(false);
  }
  expect(Channel.HistoryPage.safeParse({ messages: [], before: "older" }).success).toBe(false);
  expect(Channel.HistoryPage.parse({ messages: [] })).toEqual({ messages: [] });
  expect(Channel.HistoryPage.safeParse({ messages: [message], unexpected: true }).success).toBe(false);
  expect(Channel.HistoryPage.safeParse({ messages: [{ ...message, attachments: [{ ...attachment, leaked: 1 }] }] }).success).toBe(false);
  expect(Channel.HistoryPage.safeParse({ messages: [{ ...message, timestampMs: -1 }] }).success).toBe(false);
  expect(Channel.HistoryPage.safeParse({ messages: [{ ...message, attachments: [{ ...attachment, bytes: 1.5 }] }] }).success).toBe(false);
  expect(Channel.HistoryPage.safeParse({ messages: new Array(101).fill(message) }).success).toBe(false);
  expect(Channel.HistoryResponse.safeParse({ type: "channel_history_refused", requestId: "r", reason: "made_up", detail: "" }).success).toBe(false);
});

test.each([0, 101, 1.5])("history query refuses limit %p", (limit) => {
  expect(Channel.HistoryRequest.safeParse({ ...request, limit }).success).toBe(false);
});
