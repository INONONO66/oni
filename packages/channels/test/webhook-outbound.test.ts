import { describe, expect, test } from "bun:test";
import { Operational } from "@openomni/protocol";
import { z } from "zod";
import { verifyHmacSignature } from "../src/authn/github-signature";
import {
  createWebhookSender,
  signWebhookBody,
  WEBHOOK_RESPONSE_LIMIT,
  type WebhookFetch,
} from "../src/provider/webhook/outbound";
import type { PublishPort } from "../src/types";
import { injectedOptions } from "./helpers/injected";

const body = new TextEncoder().encode('{"message":"hello"}');
const post = { url: "https://hooks.example/in", secret: "shared-secret", idempotencyKey: "k-1", body };

interface Answer {
  readonly status: number;
  readonly type?: string;
  readonly body?: string;
}

/** A scripted target: every call recorded, the answer (or the thrown failure) scripted per call. */
function answering(answer: (call: number) => Answer | Error) {
  const calls: { url: string; headers: Record<string, string>; body: string; redirect: string }[] = [];
  const fetch: WebhookFetch = async (url, init) => {
    calls.push({ url, headers: { ...init.headers }, body: new TextDecoder().decode(init.body), redirect: init.redirect });
    const next = answer(calls.length);
    if (next instanceof Error) throw next;
    const bytes = new TextEncoder().encode(next.body ?? "");
    return {
      status: next.status,
      headers: new Headers(next.type === undefined ? {} : { "content-type": next.type }),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  return { calls, fetch };
}

function sender(fetch: WebhookFetch, publish: PublishPort = () => undefined, timeoutMs?: number) {
  return createWebhookSender({ fetch, publish, ...injectedOptions(), ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

const coded = (code: string) => Object.assign(new TypeError(code), { code });

describe("the webhook provider's outbound side (#1569 lane 9)", () => {
  test("the body is signed the way the inbound side verifies it", async () => {
    const signature = signWebhookBody(body, "shared-secret");
    expect(signature.startsWith("sha256=")).toBe(true);
    expect(await verifyHmacSignature(body, signature, "shared-secret")).toBe(true);
    expect(await verifyHmacSignature(body, signature, "other-secret")).toBe(false);
  });

  test("one signed POST per key, never followed anywhere: 2xx is sent with a textual answer carried back, cut at the byte bound", async () => {
    // Two bytes per character: the bound cuts the answer at half as many characters, on a character edge.
    const { calls, fetch } = answering(() => ({ status: 200, type: "text/plain; charset=utf-8", body: "é".repeat(WEBHOOK_RESPONSE_LIMIT) }));
    const posting = sender(fetch);
    const first = await posting.post(post);
    expect(first.receipt).toEqual({ value: "sent" });
    expect(first.response).toBe("é".repeat(WEBHOOK_RESPONSE_LIMIT / 2));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      url: post.url,
      headers: {
        "content-type": "application/json",
        "x-signature": signWebhookBody(body, "shared-secret"),
        "x-openomni-delivery": "k-1",
      },
      body: '{"message":"hello"}',
      redirect: "manual",
    });
    // The same key again is the same attempt, never a second POST.
    expect((await posting.post(post)).receipt).toEqual({ value: "sent" });
    expect(calls).toHaveLength(1);
    expect((await posting.post({ ...post, idempotencyKey: "k-2" })).receipt).toEqual({ value: "sent" });
    expect(calls).toHaveLength(2);
  });

  test("only a textual answer comes back: json does, bytes and an unnamed body do not", async () => {
    const json = await sender(answering(() => ({ status: 200, type: "application/json", body: '{"ok":true}' })).fetch).post(post);
    expect(json).toEqual({ receipt: { value: "sent" }, response: '{"ok":true}' });
    const bytes = await sender(answering(() => ({ status: 200, type: "application/octet-stream", body: "\u0000\u0001" })).fetch).post(post);
    expect(bytes).toEqual({ receipt: { value: "sent" } });
    const unnamed = await sender(answering(() => ({ status: 204, body: "" })).fetch).post(post);
    expect(unnamed).toEqual({ receipt: { value: "sent" } });
  });

  test("the target's refusal and a redirect are not_sent with the status; a 5xx and a lost answer are unknown, surfaced once; a request that never left is not_sent", async () => {
    const warns: string[] = [];
    const publish: PublishPort = (event, data) => {
      if (event.name === Operational.Events.Warn.name) warns.push(z.object({ msg: z.string() }).parse(data).msg);
    };
    expect(await sender(answering(() => ({ status: 404 })).fetch, publish).post(post)).toEqual({ receipt: { value: "not_sent" }, reason: "HTTP 404" });
    expect(await sender(answering(() => ({ status: 429 })).fetch, publish).post(post)).toEqual({ receipt: { value: "not_sent" }, reason: "HTTP 429" });
    const redirected = answering(() => ({ status: 307 }));
    expect(await sender(redirected.fetch, publish).post(post)).toEqual({ receipt: { value: "not_sent" }, reason: "HTTP 307" });
    expect(redirected.calls).toHaveLength(1);
    for (const code of ["ConnectionRefused", "ENOTFOUND", "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", "ERR_TLS_CERT_ALTNAME_INVALID"]) {
      expect(await sender(answering(() => coded(code)).fetch, publish).post(post)).toEqual({ receipt: { value: "not_sent" } });
    }
    expect(warns).toEqual([]);
    // The target had the request before it failed: it may have acted.
    expect(await sender(answering(() => ({ status: 503 })).fetch, publish).post(post)).toEqual({ receipt: { value: "unknown" }, reason: "HTTP 503" });
    const { calls, fetch } = answering(() => Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }));
    const timedOut = sender(fetch, publish);
    expect(await timedOut.post(post)).toEqual({ receipt: { value: "unknown" } });
    expect(await timedOut.post(post)).toEqual({ receipt: { value: "unknown" } });
    expect(calls).toHaveLength(1);
    expect(warns).toEqual([
      "delivery outcome unknown; uncertain send will not be retried",
      "delivery outcome unknown; uncertain send will not be retried",
    ]);
  });

  test("the request is bounded by the sender's timeout", async () => {
    let signal: AbortSignal | undefined;
    const fetch: WebhookFetch = async (_url, init) => {
      signal = init.signal;
      return { status: 204, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
    };
    expect(await sender(fetch, () => undefined, 1).post(post)).toEqual({ receipt: { value: "sent" } });
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});
