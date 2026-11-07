import { z } from "zod";
import { MachineId, Peer } from "./schema.js";

/**
 * Signed handshake (#1832): the first call on every machine connection, before
 * `machine.attach` or any other method. Both peers prove a static key inside
 * the message — the machine its enrollment key, the host the key the machine
 * pinned — so a relay, CDN or proxy that terminates TLS admits nothing and
 * learns nothing: after an accepted handshake every frame is sealed under the
 * per-attach session key both sides derive from fresh ephemerals (Noise IK
 * shape: host static key = pin, machine static key = enrollment `publicKey`).
 *
 * Every byte string rides as standard base64 so a peer generated from the
 * schema carries it verbatim; the transcript folds below sign the wire
 * spellings, never re-encoded bytes, so both languages agree byte for byte.
 */

/** Standard base64 of exactly 32 bytes: a nonce or a raw X25519 public key. */
const Base64Of32Bytes = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, {
  message: "expected the standard base64 of exactly 32 bytes",
});

/** Standard base64 of exactly 64 bytes: one ECDSA P-256 signature in fixed (r || s) form. */
const Base64Of64Bytes = z.string().regex(/^[A-Za-z0-9+/]{86}==$/, {
  message: "expected the standard base64 of exactly 64 bytes",
});

/**
 * Standard base64 of one SubjectPublicKeyInfo DER: the static key a peer
 * proves. Its sha256 is the `Machine.KeyFingerprint` an enrollment carries
 * (machine side) or the host pin a machine recorded at join (host side).
 */
const StaticKey = z
  .string()
  .min(4)
  .max(1024)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, {
    message: "expected the standard base64 of a SubjectPublicKeyInfo DER",
  });

/** Machine → host: the opening message of `machine.handshake`. */
export const HandshakeHello = z
  .object({
    machineId: MachineId,
    /** Judged first: a peer below `handshakeContractVersion` gets `unsupported_contract`. */
    peer: Peer,
    /** The machine's static P-256 key; its fingerprint must equal the enrollment's `publicKey`. */
    staticKey: StaticKey,
    /** Fresh X25519 public key for this attach. */
    ephemeralKey: Base64Of32Bytes,
    /** Fresh random bytes; a host refuses a nonce it has already accepted. */
    nonce: Base64Of32Bytes,
    /** ECDSA P-256 / SHA-256 over `helloTranscript`, fixed 64-byte form. */
    signature: Base64Of64Bytes,
  })
  .strict();
export type HandshakeHello = z.infer<typeof HandshakeHello>;

/**
 * Host → machine. `not_admitted` is the ONE reply for an unenrolled machine,
 * a key that is not the enrolled one and a signature that does not verify:
 * the bytes are identical so nobody can enumerate enrollments through the
 * refusal. `replay` names a nonce the host already accepted.
 */
export const HandshakeResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("accepted"),
      /** The host's static P-256 key; its sha256 must equal the pin the machine holds. */
      staticKey: StaticKey,
      ephemeralKey: Base64Of32Bytes,
      nonce: Base64Of32Bytes,
      /** ECDSA P-256 / SHA-256 over `acceptTranscript`, fixed 64-byte form. */
      signature: Base64Of64Bytes,
    })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum(["not_admitted", "replay", "unsupported_contract"]),
    })
    .strict(),
]);
export type HandshakeResult = z.infer<typeof HandshakeResult>;
export type HandshakeAccepted = Extract<HandshakeResult, { status: "accepted" }>;

/** Domain separation for every signature and key the handshake produces. */
export const handshakeLabel = "oni-machine-handshake/6" as const;
/** HKDF info prefix of the two frame keys; the transcript hash follows it. */
export const frameKeyLabel = "oni-machine-frames/6" as const;
/** AEAD associated data of a machine → host frame. */
export const frameAadToHost = "c2h" as const;
/** AEAD associated data of a host → machine frame. */
export const frameAadToMachine = "h2c" as const;

const encoder = new TextEncoder();

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** One length-prefixed field: big-endian u32 byte count, then the UTF-8 bytes. */
function field(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, bytes.length, false);
  return concat([prefix, bytes]);
}

/**
 * The bytes the machine signs: a label, then every hello field in wire
 * spelling and declaration order. The signature itself is not a field.
 */
export function helloTranscript(hello: Omit<HandshakeHello, "signature">): Uint8Array {
  return concat([
    encoder.encode(`${handshakeLabel}\nhello\n`),
    field(hello.machineId),
    field(hello.peer.kind),
    field(String(hello.peer.contractVersion)),
    field(hello.staticKey),
    field(hello.ephemeralKey),
    field(hello.nonce),
  ]);
}

/**
 * The bytes the host signs: a label, the whole hello transcript (so the host
 * vouches for exactly the hello it answered), then the host's own fields.
 */
export function acceptTranscript(
  hello: Omit<HandshakeHello, "signature">,
  accept: Omit<HandshakeAccepted, "status" | "signature">,
): Uint8Array {
  return concat([
    encoder.encode(`${handshakeLabel}\naccept\n`),
    helloTranscript(hello),
    field(accept.staticKey),
    field(accept.ephemeralKey),
    field(accept.nonce),
  ]);
}

/**
 * The bytes whose sha256 salts the frame keys: the accept transcript, then
 * both signatures, so the session key binds every byte either peer sent.
 */
export function sessionTranscript(hello: HandshakeHello, accept: Omit<HandshakeAccepted, "status">): Uint8Array {
  return concat([acceptTranscript(hello, accept), field(hello.signature), field(accept.signature)]);
}
