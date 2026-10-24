import { expect, test } from "bun:test";
import { AttachmentRefused } from "../src/errors";
import { createTelegramProvider } from "../src/provider/telegram/provider";
import { createSlackProvider } from "../src/provider/slack/provider";
import { slackSdk } from "../src/provider/slack/sdk";
import { injectedOptions } from "./helpers/injected";
import { recordHttp } from "./helpers/http";
import { bounded } from "./helpers/bounded";

type Provider = "telegram" | "slack";

async function runtime(provider: Provider) {
  if (provider === "telegram")
    return createTelegramProvider().create({ token: "token" }, {}, () => undefined, injectedOptions());
  const sdk = slackSdk();
  const client = sdk.client();
  await client.login({ token: "xoxb-token" });
  return createSlackProvider({ ...sdk, client: () => client }).create(
    { botToken: "xoxb-token", appToken: "xapp-token" }, {}, () => undefined, injectedOptions(),
  );
}

function metadata(provider: Provider) {
  return provider === "telegram"
    ? Response.json({ ok: true, result: { file_id: "f", file_path: "photos/file_0.jpg", file_size: 2 } })
    : Response.json({ ok: true, file: {
      id: "f", name: "file_0.jpg", title: "file", mimetype: "image/jpeg", size: 2,
      url_private: "https://files.slack.com/file", created: 1, user: "u",
    } });
}

for (const provider of ["telegram", "slack"] as const) {
  test(`${provider}: authenticated attachment port forwards bounds and preserves MIME`, async () => {
    const instance = await runtime(provider);
    const controller = new AbortController();
    let calls = 0;
    const wire = recordHttp(() => {
      calls++;
      return calls === 1 ? metadata(provider) : new Response(new Uint8Array([1, 2]), {
        headers: { "content-type": "application/octet-stream" },
      });
    });
    try {
      expect(await instance.attachments?.("f", { maxBytes: 2, signal: controller.signal })).toEqual({
        bytes: new Uint8Array([1, 2]), name: "file_0.jpg", mime: "image/jpeg",
      });
      expect(wire.requests).toHaveLength(2);
      controller.abort();
      expect(wire.requests.every(request => request.signal.aborted)).toBe(true);
    } finally { wire.restore(); }
  });

  test.each(["declared", "stream"] as const)(`${provider}: %s overflow is a typed attachment refusal and cancels the body`, async (source) => {
    const instance = await runtime(provider);
    let calls = 0;
    let cancelled = 0;
    const wire = recordHttp(() => {
      calls++;
      if (calls === 1) return metadata(provider);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
        cancel() { cancelled++; },
      }), { headers: source === "declared" ? { "content-length": "3" } : {} });
    });
    try {
      const fetch = instance.attachments;
      if (!fetch) throw new Error("Missing attachment port");
      await expect(fetch("f", { maxBytes: 2, signal: new AbortController().signal }))
        .rejects.toBeInstanceOf(AttachmentRefused);
      expect(cancelled).toBe(1);
      expect(calls).toBe(2);
    } finally { wire.restore(); }
  });

  test(`${provider}: metadata cancellation refuses the attachment before download`, async () => {
    const instance = await runtime(provider);
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const wire = recordHttp(request => new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      entered.resolve();
    }));
    try {
      const fetch = instance.attachments;
      if (!fetch) throw new Error("Missing attachment port");
      const pending = fetch("f", { maxBytes: 2, signal: controller.signal }).catch(error => {
        if (!(error instanceof Error)) throw error;
        return error;
      });
      await bounded(entered.promise);
      controller.abort();
      const result = await bounded(pending);
      expect(result).toBeInstanceOf(AttachmentRefused);
      expect(result).toMatchObject({ reason: "aborted", maxBytes: 2 });
      expect(wire.requests).toHaveLength(1);
    } finally { wire.restore(); }
  });
}
