import { verifyHmacSignature } from "../../authn/github-signature";
import type { SecretRefPort, WebhookRefusal } from "./types";

export async function verifyWebhook(
  body: Uint8Array,
  signature: string | null,
  secretRef: string,
  resolveSecret: SecretRefPort,
): Promise<{ readonly verified: true } | WebhookRefusal> {
  if (signature === null) return { refused: { reason: "missing_signature" } };
  const secret = await resolveSecret(secretRef);
  if (secret === undefined) return { refused: { reason: "unknown_secret" } };
  if (!(await verifyHmacSignature(body, signature, secret)))
    return { refused: { reason: "signature_mismatch" } };
  return { verified: true };
}
