/**
 * The entity runner layer takes `Crypto.Crypto` as an injected
 * service, never ambient webcrypto: the cluster host refuses to build without
 * one (compile-time requirement), and a fully deterministic layer (seeded
 * xorshift bytes + real SHA digest) hosts the complete deliver round-trip.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Crypto, Effect, Layer } from "effect";
import {
  clusterTempDir,
  readChain,
  runCluster,
  sendPrompt,
  sessionFileFor,
  verifyChain,
} from "./helpers/cluster-runtime";

const { dir, sessionsDir, catalogFile } = clusterTempDir("w52-deterministic-crypto-");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Seeded xorshift32 byte stream: same seed, same bytes, every run. */
function deterministicCrypto(seed: number): Layer.Layer<Crypto.Crypto> {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state & 0xff;
  };
  return Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: (size) => Uint8Array.from({ length: size }, next),
      digest: (algorithm, data) =>
        Effect.promise(async () => new Uint8Array(await crypto.subtle.digest(algorithm, data))),
    }),
  );
}

test("a deliver round-trips on a cluster host whose Crypto is the injected deterministic layer", async () => {
  const sessionId = "crypto-session";
  const receipt = await runCluster(
    { sessionsDir, catalogFile, crypto: deterministicCrypto(0xc0ffee) },
    sendPrompt(sessionId, "crypto-m1", "deterministic bytes"),
  );
  expect(receipt.existed).toBe(false);
  // The chain the entity committed under that host verifies hash-by-hash.
  const file = sessionFileFor(sessionsDir, sessionId);
  expect(verifyChain(file, sessionId)).toBeGreaterThanOrEqual(2);
  expect(readChain(file, sessionId).some((row) => row.id === "crypto-m1")).toBe(true);
});
