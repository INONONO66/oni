import { type ChannelInstanceStore, WebhookCredentials, type WebhookSender } from "@openomni/channels";
import { Operational, type PlainValue } from "@openomni/protocol";
import { Effect } from "effect";
import type { WebhookContactPort, WebhookPostOutcome } from "../bundles/messaging/send-message/index";
import type { ChannelRuntimeDeps, CredentialReader } from "../channels";

interface WebhookTarget {
  readonly url: string;
  readonly secret: string;
}

/** Why a target cannot be used: the word for the sender's fact, and the detail that goes to the Owner, never to the model. */
interface Withheld {
  readonly reason: string;
  readonly detail?: string;
}

function parseJson(plaintext: Uint8Array): PlainValue | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return undefined;
  }
}

const unavailable = (id: string, detail: string): Withheld => ({
  reason: `webhook target ${id}: its credential is unavailable`,
  detail,
});

/** The declared target behind `webhook:<id>`, or why there is none. */
function resolveTarget(deps: Pick<WebhookContactDeps, "instances" | "readCredential">, id: string): WebhookTarget | Withheld {
  const row = deps.instances.get(`channel:webhook:${id}`);
  if (row === undefined || row.provider !== "webhook") return { reason: `no webhook target ${id} is declared` };
  if (!row.enabled) return { reason: `webhook target ${id} is disabled` };
  if (row.credentialRef === undefined) return { reason: `webhook target ${id} has no credential` };
  const credential = deps.readCredential(row.credentialRef);
  if (credential.kind === "locked") return unavailable(id, credential.reason);
  const parsed = WebhookCredentials.safeParse(parseJson(credential.plaintext));
  if (!parsed.success) return unavailable(id, "the credential payload is invalid");
  if (parsed.data.url === undefined) return { reason: `webhook target ${id} declares no url` };
  if (parsed.data.secret !== undefined) return { url: parsed.data.url, secret: parsed.data.secret };
  if (parsed.data.secretRef === undefined) return unavailable(id, "the credential names no secret");
  const secret = deps.readCredential(parsed.data.secretRef);
  if (secret.kind === "locked") return unavailable(id, secret.reason);
  return { url: parsed.data.url, secret: new TextDecoder().decode(secret.plaintext) };
}

export interface WebhookContactDeps {
  readonly instances: Pick<ChannelInstanceStore, "get">;
  readonly readCredential: CredentialReader;
  readonly sender: WebhookSender;
  readonly publish: ChannelRuntimeDeps["publish"];
  readonly now: () => number;
  readonly id: () => string;
}

/**
 * The `webhook:` contact (#1569 lane 9): a declared `channel:webhook:<id>`
 * instance whose sealed credential names a `url` is a target the Resident
 * may post a letter to — signed with the target's secret (inline in the
 * credential, or behind its `secretRef`), one physical attempt per tool
 * call, a textual answer carried back as the sender's prompt. The target
 * and its secret are read from the vault at send time, so nothing about a
 * target lives outside its declaration; what withholds a target reaches the
 * model as a plain word and the Owner as the observation with the detail.
 */
export function webhookContacts(deps: WebhookContactDeps): WebhookContactPort {
  return {
    post: (input) =>
      Effect.promise(async (): Promise<WebhookPostOutcome> => {
        const target = resolveTarget(deps, input.id);
        if ("reason" in target) {
          if (target.detail !== undefined)
            deps.publish(Operational.Events.Warn, {
              traceId: deps.id(),
              time: deps.now(),
              component: "server",
              msg: "webhook target unavailable",
              context: { target: input.id, detail: target.detail },
            });
          return { status: "not_sent", reason: target.reason };
        }
        const body = new TextEncoder().encode(
          JSON.stringify({
            id: input.idempotencyKey,
            contact: `webhook:${input.id}`,
            from: `session:${input.sender}`,
            message: input.message,
            ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
            sentAt: deps.now(),
          }),
        );
        const posted = await deps.sender.post({
          url: target.url,
          secret: target.secret,
          idempotencyKey: input.idempotencyKey,
          body,
        });
        return {
          status: posted.receipt.value,
          ...(posted.reason === undefined ? {} : { reason: posted.reason }),
          ...(posted.response === undefined ? {} : { response: posted.response }),
        };
      }),
  };
}
