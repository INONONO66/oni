import { describe, expect, test } from "bun:test";
import { Machine } from "../src/machine/index.js";
import { expectIssue } from "./helpers/schema.js";

const pin = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const enrollment = {
  machineId: "mac-0",
  name: "brain-mac",
  allowedCapabilities: ["fs.read"],
  publicKey: pin,
  enrolledAt: 1,
} satisfies Machine.Enrollment;

describe("Machine.KeyFingerprint", () => {
  test("a valid pin parses standalone and inside an Enrollment", () => {
    expect(Machine.KeyFingerprint.safeParse(pin).success).toBe(true);
    const result = Machine.Enrollment.safeParse(enrollment);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.publicKey).toBe(pin);
  });

  test("fingerprintOf emits the canonical form over the SPKI DER bytes", () => {
    const fingerprint = Machine.fingerprintOf(new Uint8Array([1, 2, 3]));
    expect(Machine.KeyFingerprint.safeParse(fingerprint).success).toBe(true);
    // sha256([1,2,3]) — pinned so the canonical form can never silently change.
    expect(fingerprint).toBe("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
  });

  test("a wrong-length pin rejects", () => {
    expectIssue(Machine.Enrollment.safeParse({ ...enrollment, publicKey: pin.slice(0, 63) }), {
      message: "key fingerprint must be 64 lowercase hex chars of sha256(SPKI DER)",
      path: "publicKey",
    });
  });

  test("an uppercase pin rejects — one canonical spelling only", () => {
    expect(Machine.Enrollment.safeParse({ ...enrollment, publicKey: pin.toUpperCase() }).success).toBe(false);
  });

  test("a non-hex pin rejects", () => {
    expect(Machine.Enrollment.safeParse({ ...enrollment, publicKey: `${pin.slice(0, 63)}g` }).success).toBe(false);
  });

  test("a missing pin rejects — enrollment without a daemon key is not admissible", () => {
    const { publicKey: _publicKey, ...withoutPin } = enrollment;
    expectIssue(Machine.Enrollment.safeParse(withoutPin), { path: "publicKey" });
  });
});

describe("Machine.AttachResult transport refusal reasons", () => {
  test.each(["peer_key_mismatch", "disconnected", "unsupported_contract", "stale_generation"] as const)("%s round-trips", (reason) => {
    const refusal = { status: "refused", reason } satisfies Machine.AttachResult;
    const result = Machine.AttachResult.safeParse(JSON.parse(JSON.stringify(refusal)));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(refusal);
  });
});

test.each(["superseded", "superseded_by_reattach"] as const)("machine detach reads serialized %s reason", (reason) => {
  const event = { machineId: "mac-0", time: 1, reason };
  expect(Machine.Events.Detached.schema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
});
