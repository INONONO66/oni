import { expect, test } from "bun:test";
import { Vault, type WebhookSender } from "@openomni/channels";
import { Operational } from "@openomni/protocol";
import { z } from "zod";
import { vaultCredentialReader } from "../src/bundles/provision/declared";
import { webhookContacts } from "../src/composition/webhook-contacts";
import { putChannelCredential } from "./helpers/channel-credential";
import { runEffect } from "./helpers/effect";
import { testPlane } from "./helpers/ledger";

const KEY = new Uint8Array(32).fill(7);

/** A plane with one declared webhook target, its credential and its signing secret sealed. */
function declared(
  overrides: {
    readonly enabled?: boolean;
    readonly url?: string;
    readonly credential?: boolean | "garbled" | "inline";
    readonly provider?: string;
  } = {},
) {
  const plane = testPlane();
  putChannelCredential(plane.stores.secrets, "secret:hook-1", "shared-secret", KEY, 1);
  const payload =
    overrides.credential === "inline"
      ? { id: "hook-1", secret: "inline-secret", ...(overrides.url === undefined ? {} : { url: overrides.url }) }
      : { id: "hook-1", secretRef: "secret:hook-1", ...(overrides.url === undefined ? {} : { url: overrides.url }) };
  if (overrides.credential !== false)
    putChannelCredential(
      plane.stores.secrets,
      "secret:channel-webhook-hook-1",
      overrides.credential === "garbled" ? "not json" : JSON.stringify(payload),
      KEY,
      1,
    );
  plane.stores.instances.put({
    id: "channel:webhook:hook-1",
    provider: overrides.provider ?? "webhook",
    identity: "bot",
    enabled: overrides.enabled ?? true,
    settings: {},
    ...(overrides.credential === false ? {} : { credentialRef: "secret:channel-webhook-hook-1" }),
    revision: 0,
    createdBy: "owner",
    updatedAt: 1,
  });
  return plane;
}

/** A scripted sender: every post recorded, the receipt scripted. */
function sender(receipt: { value: "sent" | "not_sent" | "unknown" }, response?: string) {
  const posts: Parameters<WebhookSender["post"]>[0][] = [];
  const port: WebhookSender = {
    post: async (input) => {
      posts.push(input);
      return response === undefined ? { receipt } : { receipt, response };
    },
  };
  return { posts, port };
}

const letter = { id: "hook-1", idempotencyKey: "sender:call-1", sender: "sender", message: "hello there", replyTo: "m-0" };

/** The port over a plane, with the Owner's observations recorded. */
function contactsOver(plane: ReturnType<typeof declared>, port: WebhookSender, reader?: ReturnType<typeof vaultCredentialReader>) {
  const warns: { msg: string; context?: Record<string, string> }[] = [];
  const contacts = webhookContacts({
    instances: plane.stores.instances,
    readCredential: reader ?? vaultCredentialReader({ kind: "ok", kek: Vault.kekOf(KEY) }, (ref) => plane.stores.secrets.get(ref)),
    sender: port,
    publish: (event, data) => {
      if (event.name === Operational.Events.Warn.name)
        warns.push(z.object({ msg: z.string(), context: z.record(z.string(), z.string()).optional() }).parse(data));
    },
    now: () => 1_700_000_000_000,
    id: () => "trace-1",
  });
  return { contacts, warns };
}

test("a declared target's letter is posted to its url, signed with the vault's secret, as one JSON body per tool call; the answer rides back", async () => {
  const plane = declared({ url: "https://hooks.example/in" });
  const { posts, port } = sender({ value: "sent" }, "thanks");
  const { contacts, warns } = contactsOver(plane, port);
  expect(await runEffect(contacts.post(letter))).toEqual({ status: "sent", response: "thanks" });
  expect(warns).toEqual([]);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ url: "https://hooks.example/in", secret: "shared-secret", idempotencyKey: "sender:call-1" });
  expect(JSON.parse(new TextDecoder().decode(posts[0]?.body))).toEqual({
    id: "sender:call-1",
    contact: "webhook:hook-1",
    from: "session:sender",
    message: "hello there",
    replyTo: "m-0",
    sentAt: 1_700_000_000_000,
  });
  // The receipt's value is the outcome, with the target's own word on a refusal; a silent 2xx carries no answer.
  expect(await runEffect(contactsOver(plane, sender({ value: "unknown" }).port).contacts.post(letter))).toEqual({ status: "unknown" });
  const refusing: WebhookSender = { post: async () => ({ receipt: { value: "not_sent" }, reason: "HTTP 404" }) };
  expect(await runEffect(contactsOver(plane, refusing).contacts.post(letter))).toEqual({ status: "not_sent", reason: "HTTP 404" });
  // A declaration carrying its secret inline signs with it.
  const inline = declared({ url: "https://hooks.example/in", credential: "inline" });
  const signed = sender({ value: "sent" });
  expect(await runEffect(contactsOver(inline, signed.port).contacts.post(letter))).toEqual({ status: "sent" });
  expect(signed.posts[0]).toMatchObject({ secret: "inline-secret" });
});

test("no declaration, another provider's row, a disabled one, one without a credential or a url, an unreadable credential or a locked vault is the sender's not_sent reason; nothing is posted, the detail goes to the Owner", async () => {
  const cases: [ReturnType<typeof declared>, ReturnType<typeof vaultCredentialReader> | undefined, string, string, string | undefined][] = [
    [declared({ url: "https://hooks.example/in" }), undefined, "hook-2", "no webhook target hook-2 is declared", undefined],
    [declared({ url: "https://hooks.example/in", provider: "slack" }), undefined, "hook-1", "no webhook target hook-1 is declared", undefined],
    [declared({ url: "https://hooks.example/in", enabled: false }), undefined, "hook-1", "webhook target hook-1 is disabled", undefined],
    [declared({ credential: false }), undefined, "hook-1", "webhook target hook-1 has no credential", undefined],
    [declared({ credential: "garbled" }), undefined, "hook-1", "webhook target hook-1: its credential is unavailable", "the credential payload is invalid"],
    [declared(), undefined, "hook-1", "webhook target hook-1 declares no url", undefined],
    [
      declared({ url: "https://hooks.example/in" }),
      vaultCredentialReader({ kind: "locked", reason: "no vault key" }, () => undefined),
      "hook-1",
      "webhook target hook-1: its credential is unavailable",
      "no vault key",
    ],
  ];
  for (const [plane, locked, id, reason, detail] of cases) {
    const { posts, port } = sender({ value: "sent" });
    const { contacts, warns } = contactsOver(plane, port, locked);
    expect(await runEffect(contacts.post({ ...letter, id }))).toEqual({ status: "not_sent", reason });
    expect(posts).toEqual([]);
    expect(warns).toEqual(detail === undefined ? [] : [{ msg: "webhook target unavailable", context: { target: id, detail } }]);
  }
});
