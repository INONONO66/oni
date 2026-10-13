import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { fakeProviders } from "./helpers/channel-providers";
import type { Channel, Provisioning } from "@openomni/protocol";
import { declaredChannelProfile } from "../src/channels";
import { testChannelDeps } from "./helpers/test-entropy";

const handler: Channel.MessageHandler = () => Promise.resolve();
const credentials = {
  telegram: { token: "tg-token" },
  github: { secret: "gh-secret", token: "gh-api", botUsername: "omni-bot" },
  discord: { token: "dc-token" },
};
const instances: Provisioning.ChannelInstance[] = Object.keys(credentials).map((provider) => ({
  id: `channel:${provider}:main`,
  provider,
  enabled: true,
  settings: {},
  credentialRef: provider,
  revision: 0,
  createdBy: "owner",
  updatedAt: 0,
}));

function profile(rows = instances) {
  const fakes = fakeProviders();
  const payloads = new Map(
    Object.entries(credentials).map(([key, value]) => [key, JSON.stringify(value)]),
  );
  const selected = declaredChannelProfile(
    rows,
    (ref) => {
      const value = payloads.get(ref);
      return value === undefined
        ? { kind: "locked", reason: "missing" }
        : { kind: "ok", plaintext: new TextEncoder().encode(value) };
    },
    testChannelDeps(),
    fakes.providers,
  );
  return { fakes, ...selected };
}

describe("declared channel composition", () => {
  test("a provisioned webhook row boots with its own credential schema, not GitHub's (H3)", async () => {
    const webhookCredential = { id: "hook-1", secretRef: "secret:hook-1" };
    const signingSecret = "hook-1-signing-secret";
    const webhookInstance: Provisioning.ChannelInstance = {
      id: "channel:webhook:main",
      provider: "webhook",
      enabled: true,
      settings: {},
      credentialRef: "webhook",
      revision: 0,
      createdBy: "owner",
      updatedAt: 0,
    };
    const vault = new Map([
      ["webhook", JSON.stringify(webhookCredential)],
      [webhookCredential.secretRef, signingSecret],
    ]);
    const { rows, statuses } = declaredChannelProfile(
      [webhookInstance],
      (ref) => {
        const value = vault.get(ref);
        return value === undefined
          ? { kind: "locked", reason: "missing" }
          : { kind: "ok", plaintext: new TextEncoder().encode(value) };
      },
      testChannelDeps(),
    );
    expect(statuses).toEqual([{ id: "channel:webhook:main", provider: "webhook", state: "ready" }]);
    expect(rows).toHaveLength(1);
    const built = rows[0]?.component.build(handler);
    expect(built?.webhookHandler).toBeDefined();
    expect(built?.deliveryRoute).toBeUndefined();
    // A GitHub-schema row would answer with GitHub's own refusal shape (invalid signature header
    // name, different JSON body) rather than the webhook provider's signed-request 401.
    const response = await built?.webhookHandler?.(new Request("https://x.test/webhook"));
    expect(response?.status).toBe(401);
    // The signing secret is resolved through the same credential reader as the
    // row: a signature over the body with that secret is accepted, and a wrong
    // one is a mismatch (not `unknown_secret`), so the vault lookup happened.
    const body = JSON.stringify({ ping: true });
    const signed = (secret: string) =>
      new Request("https://x.test/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
        body,
      });
    const mismatch = await built?.webhookHandler?.(signed("not-the-secret"));
    expect(mismatch?.status).toBe(401);
    expect(await mismatch?.json()).toEqual({ refused: { reason: "signature_mismatch" } });
    const accepted = await built?.webhookHandler?.(signed(signingSecret));
    expect(accepted?.status).toBe(200);
  });

  test("no declarations produce no rows", () => {
    expect(profile([]).rows).toEqual([]);
  });

  test("one row per declaration preserves credentials and binds the handler", async () => {
    const { fakes, rows, statuses } = profile();
    expect(rows.map((row) => row.component.id)).toEqual(["telegram", "github", "discord"]);
    expect(statuses.every((status) => status.state === "ready")).toBe(true);
    const built = rows.map((row) => row.component.build(handler));
    expect(fakes.surfaces.map((surface) => surface.handler)).toEqual([handler, handler, handler]);
    expect(fakes.surfaces.map((surface) => surface.credentials)).toEqual(
      Object.values(credentials),
    );
    expect(fakes.surfaces.map((surface) => surface.config)).toEqual([{}, {}, {}]);
    const [telegram, github, discord] = built;
    expect(telegram?.deliveryRoute).toBeDefined();
    expect(telegram?.webhookHandler).toBeUndefined();
    expect(discord?.deliveryRoute).toBeDefined();
    expect(discord?.webhookHandler).toBeUndefined();
    expect(github?.deliveryRoute).toBeUndefined();
    expect(github?.webhookHandler).toBeDefined();
    await telegram?.deliveryRoute?.("actor-1", "hello", "key-1");
    expect(fakes.delivered).toEqual([{ externalId: "actor-1", body: "hello" }]);
    expect((await github?.webhookHandler?.(new Request("https://x.test/webhook")))?.status).toBe(
      200,
    );
    expect(fakes.webhookCalls).toHaveLength(1);
  });
});
