import { verifyHmacSignature } from "../../authn/github-signature";
import type { SecretRefPort, WebhookCredentials, WebhookRefusal } from "./types";

export async function verifyWebhook(
  body: Uint8Array,
  signature: string | null,
  credentials: Pick<WebhookCredentials, "secret" | "secretRef">,
  resolveSecret: SecretRefPort,
): Promise<{ readonly verified: true } | WebhookRefusal> {
  if (signature === null) return { refused: { reason: "missing_signature" } };
  const secret =
    credentials.secret ?? (credentials.secretRef === undefined ? undefined : await resolveSecret(credentials.secretRef));
  if (secret === undefined) return { refused: { reason: "unknown_secret" } };
  if (!(await verifyHmacSignature(body, signature, secret)))
    return { refused: { reason: "signature_mismatch" } };
  return { verified: true };
}
