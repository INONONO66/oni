import { Vault, type createSecretStore } from "@oni/channels";

export function putChannelCredential(
  secrets: ReturnType<typeof createSecretStore>,
  id: string,
  plaintext: string,
  key: Uint8Array,
  at: number,
) {
  const envelope = Vault.seal(new TextEncoder().encode(plaintext), Vault.kekOf(key));
  secrets.put({
    id,
    ciphertext: envelope.ciphertext,
    wrappedDek: envelope.wrappedDek,
    kekId: envelope.kekId,
    purpose: "channel_credential",
    createdAt: at,
  });
  return envelope;
}
