import { createHmac, randomBytes } from "node:crypto";

// Credential material never sits in Map keys or observation records. A plain
// digest of a short secret is reversible by dictionary; keying it with a
// process-lifetime random secret keeps fingerprints stable for the caches
// (process-scoped anyway) and worthless outside the process.
const PROCESS_KEY = randomBytes(32);

export function secretFingerprint(material: string): string {
  return createHmac("sha256", PROCESS_KEY).update(material).digest("hex");
}
