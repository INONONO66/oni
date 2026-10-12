import { timingSafeEqual } from "node:crypto";

export async function verifyHmacSignature(
  payload: Uint8Array,
  signature: string,
  secret: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, payload);
  const digest = `sha256=${Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
  if (signature.length !== digest.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

export function verifyGitHubSignature(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  return verifyHmacSignature(new TextEncoder().encode(payload), signature, secret);
}
