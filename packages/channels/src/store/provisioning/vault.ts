import { createCipheriv, createDecipheriv, createHash, randomBytes, type DecipherGCM } from "node:crypto";
import { inspect } from "node:util";
import { Provisioning } from "@oni/protocol";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

type DecipherFactory = (
  algorithm: "aes-256-gcm",
  key: Uint8Array,
  iv: Uint8Array,
) => DecipherGCM;

const defaultDecipherFactory: DecipherFactory = (algorithm, key, iv) => createDecipheriv(algorithm, key, iv);

function pack(iv: Uint8Array, tag: Uint8Array, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const packed = new Uint8Array(iv.length + tag.length + data.length);
  packed.set(iv, 0);
  packed.set(tag, iv.length);
  packed.set(data, iv.length + tag.length);
  return packed;
}

function encryptWith(key: Uint8Array, plaintext: Uint8Array): Uint8Array<ArrayBuffer> {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = new Uint8Array(Buffer.concat([cipher.update(plaintext), cipher.final()]));
  return pack(iv, new Uint8Array(cipher.getAuthTag()), data);
}

function decryptWith(
  key: Uint8Array,
  packed: Uint8Array,
  secretId?: string,
  decipherFactory: DecipherFactory = defaultDecipherFactory,
): Uint8Array {
  if (packed.length < IV_LENGTH + TAG_LENGTH) {
    throw new Provisioning.VaultError({
      message: "Packed ciphertext is shorter than IV + auth tag",
      code: "unopenable",
      ...(secretId === undefined ? {} : { secretId }),
    });
  }
  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const data = packed.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = decipherFactory("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(data), decipher.final()]));
  } catch (cause) {
    throw new Provisioning.VaultError(
      {
        message: "Ciphertext failed authentication under the presented KEK",
        code: "unopenable",
        ...(secretId === undefined ? {} : { secretId }),
      },
      { cause: cause instanceof Error ? cause : new Error(String(cause)) },
    );
  }
}

/**
 * Envelope crypto for vault rows (docs/provisioning-and-providers.md §3.3):
 * each secret gets its own random DEK; the DEK encrypts the plaintext and the
 * KEK wraps the DEK, both AES-256-GCM in the packed `IV ‖ tag ‖ data` layout.
 * KEK *sourcing* (env / key file) is composition-root policy — this module
 * only takes key bytes. Opened values come back as `Revealed`, whose every
 * accidental serialization path prints `[redacted]` (§8.3).
 */
export namespace Vault {
  export interface Kek {
    /** Stable fingerprint-derived name persisted on rows for rotation bookkeeping. */
    readonly id: string;
    readonly key: Uint8Array;
  }

  /** Sealed envelope fields, ready to persist on a `Provisioning.Secret` row. */
  export interface Envelope {
    readonly ciphertext: Uint8Array<ArrayBuffer>;
    readonly wrappedDek: Uint8Array<ArrayBuffer>;
    readonly kekId: string;
  }

  /**
   * The only carrier an opened secret travels in. `reveal()` is the single
   * deliberate exit; string coercion, JSON serialization, and util.inspect
   * (console.log / telemetry dumps) all print `[redacted]`.
   */
  class Revealed {
    readonly #value: Uint8Array;

    constructor(value: Uint8Array) {
      this.#value = value;
    }

    reveal(): Uint8Array {
      return this.#value;
    }

    revealText(): string {
      return new TextDecoder().decode(this.#value);
    }

    toString(): string {
      return "[redacted]";
    }

    toJSON(): string {
      return "[redacted]";
    }

    [inspect.custom](): string {
      return "[redacted]";
    }
  }

  /** Derives the stable KEK id from key bytes: `kek:<first 12 hex of sha256>`. */
  export function kekOf(key: Uint8Array): Kek {
    if (key.length !== KEY_LENGTH) {
      throw new Provisioning.VaultError({
        message: `KEK must be exactly ${KEY_LENGTH} bytes, got ${key.length}`,
        code: "vault_locked",
      });
    }
    const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 12);
    return { id: `kek:${fingerprint}`, key };
  }

  export function seal(plaintext: Uint8Array, kek: Kek): Envelope {
    const dek = new Uint8Array(randomBytes(KEY_LENGTH));
    return {
      ciphertext: encryptWith(dek, plaintext),
      wrappedDek: encryptWith(kek.key, dek),
      kekId: kek.id,
    };
  }

  export function open(
    envelope: Envelope & { readonly id?: string },
    kek: Kek,
    decipherFactory: DecipherFactory = defaultDecipherFactory,
  ): Revealed {
    if (envelope.kekId !== kek.id) {
      throw new Provisioning.VaultError({
        message: `Row sealed under ${envelope.kekId}; presented KEK is ${kek.id}`,
        code: "kek_mismatch",
        ...(envelope.id === undefined ? {} : { secretId: envelope.id }),
      });
    }
    const dek = decryptWith(kek.key, envelope.wrappedDek, envelope.id, decipherFactory);
    return new Revealed(decryptWith(dek, envelope.ciphertext, envelope.id, decipherFactory));
  }
}
