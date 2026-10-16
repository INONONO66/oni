import { createHmac } from "node:crypto";
import { expect, test } from "bun:test";
import { type Channel, Gateway, Operational } from "@openomni/protocol";
import { createWebhookProvider } from "../src/provider/webhook/provider";
import { verifyWebhook } from "../src/provider/webhook/verify";
import { injectedOptions } from "./helpers/injected";

const body = '{ "kind": "ping" }';
const signature = `sha256=${createHmac("sha256", "shared-secret").update(body).digest("hex")}`;
const credentials = { id: "hook-1", secretRef: "secret:hook-1" };
const resolver = async (ref: string) =>
  ref === credentials.secretRef ? "shared-secret" : undefined;
function request(content: string, header?: string) {
  return new Request("http://localhost/webhook", {
    method: "POST",
    body: content,
    headers: {
      "content-type": "application/json",
      ...(header === undefined ? {} : { "x-signature": header }),
    },
  });
}

test("verified raw body produces one normalized inbound message", async () => {
  const received: Channel.InboundMessage[] = [];
  const runtime = createWebhookProvider(resolver).create(
    credentials,
    {},
    () => undefined,
    injectedOptions(),
  );
  runtime.surface.onMessage(async (message) => {
    received.push(message);
  });
  await runtime.surface.start("trace");
  expect((await runtime.webhookHandler?.(request(body, signature)))?.status).toBe(200);
  expect(received).toHaveLength(1);
  expect(Gateway.IngressFacts.parse(received[0]?.facts)).toMatchObject({
    surface: "webhook",
    event: "webhook",
    secretRef: "secret:hook-1",
    channelId: "hook-1",
    author: { externalId: "secret:hook-1", isBot: true },
    // render is the raw body verbatim, never a stringify(parse()) round-trip (M3).
    render: body,
  });
  expect(runtime.deliveryRoute).toBeUndefined();
});

test("tampered bytes refuse as a typed value and return 401", async () => {
  expect(
    await verifyWebhook(
      new TextEncoder().encode("changed"),
      signature,
      credentials,
      resolver,
    ),
  ).toEqual({ refused: { reason: "signature_mismatch" } });
  const refusals: string[] = [];
  const runtime = createWebhookProvider(resolver).create(
    credentials,
    {},
    (event, data) => {
      if (event === Operational.Events.Warn) refusals.push(JSON.stringify(data));
    },
    injectedOptions(),
  );
  runtime.surface.onMessage(async () => {
    throw new Error("must not deliver");
  });
  const response = await runtime.webhookHandler?.(request("changed", signature));
  expect(response?.status).toBe(401);
  expect(await response?.json()).toEqual({ refused: { reason: "signature_mismatch" } });
  expect(refusals).toHaveLength(1);
  expect(refusals[0]).toContain("signature_mismatch");
});

test("missing header and unknown secret produce distinct refusal values", async () => {
  expect(
    await verifyWebhook(new TextEncoder().encode(body), null, credentials, resolver),
  ).toEqual({ refused: { reason: "missing_signature" } });
  expect(await verifyWebhook(new TextEncoder().encode(body), signature, { secretRef: "other" }, resolver)).toEqual(
    { refused: { reason: "unknown_secret" } },
  );
  const runtime = createWebhookProvider(resolver).create(
    credentials,
    {},
    () => undefined,
    injectedOptions(),
  );
  expect((await runtime.webhookHandler?.(request(body)))?.status).toBe(401);
  const unknown = createWebhookProvider(async () => undefined).create(
    credentials,
    {},
    () => undefined,
    injectedOptions(),
  );
  expect(await (await unknown.webhookHandler?.(request(body, signature)))?.json()).toEqual({
    refused: { reason: "unknown_secret" },
  });
});

test("a declaration carrying its secret inline verifies with it and speaks as itself; neither secret nor secretRef is refused by the schema", async () => {
  const received: Channel.InboundMessage[] = [];
  const inline = createWebhookProvider(async () => undefined).create(
    { id: "hook-2", secret: "inline-secret" },
    {},
    () => undefined,
    injectedOptions(),
  );
  inline.surface.onMessage(async (message) => {
    received.push(message);
  });
  await inline.surface.start("trace");
  const ownSignature = `sha256=${createHmac("sha256", "inline-secret").update(body).digest("hex")}`;
  expect((await inline.webhookHandler?.(request(body, signature)))?.status).toBe(401);
  expect((await inline.webhookHandler?.(request(body, ownSignature)))?.status).toBe(200);
  expect(received[0]?.sender).toEqual({ kind: "external", surface: "webhook", externalId: "webhook:hook-2" });
  expect(received[0]?.facts).toMatchObject({ author: { externalId: "webhook:hook-2", isBot: true }, channelId: "hook-2" });
  expect("secretRef" in (received[0]?.facts ?? {})).toBe(false);
  expect(createWebhookProvider(async () => undefined).credentials.safeParse({ id: "hook-3" }).success).toBe(false);
  expect(createWebhookProvider(async () => undefined).credentials.safeParse({ id: "hook-3", secret: "s", url: "ftp://x" }).success).toBe(false);
});
