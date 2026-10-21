import { Crypto, Effect, Layer } from "effect";

/** Bun webcrypto-backed Crypto service (platform-bun is not a workspace dependency). */
export const BunCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => new Uint8Array(await crypto.subtle.digest(algorithm, data))),
  }),
);
