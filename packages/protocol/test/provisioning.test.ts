import { describe, expect, test } from "bun:test";
import { Provisioning } from "../src/index.js";

const NOW = 1_756_000_000_000;

describe("Provisioning ids", () => {
  test("PersonId / ChannelInstanceId / SecretId enforce their prefixes and slugs", () => {
    expect(Provisioning.Person.shape.id.safeParse("person:ino").success).toBe(true);
    expect(Provisioning.Person.shape.id.safeParse("ino").success).toBe(false);
    expect(Provisioning.Person.shape.id.safeParse("person:Ino").success).toBe(false);
    expect(Provisioning.ChannelInstance.shape.id.safeParse("channel:telegram:main").success).toBe(true);
    expect(Provisioning.ChannelInstance.shape.id.safeParse("channel:main").success).toBe(false);
    expect(Provisioning.Secret.shape.id.safeParse("secret:channel-telegram-main").success).toBe(true);
    expect(Provisioning.Secret.shape.id.safeParse("secret:").success).toBe(false);
  });
});

describe("Provisioning.Person", () => {
  const valid: Provisioning.Person = {
    id: "person:ino",
    displayName: "Ino",
    kind: "human",
    trustTier: "owner",
    endpoints: [{ channel: "telegram", externalId: "12345", workspace: "T123" }],
    revision: 0,
    createdBy: "openomni-init",
    updatedAt: NOW,
  };

  test("parses a full manifest and rejects unknown fields (strict)", () => {
    expect(Provisioning.Person.parse(valid)).toEqual(valid);
    expect(Provisioning.Person.safeParse({ ...valid, password: "x" }).success).toBe(false);
  });

  test("endpoints reject blank ids and unknown fields", () => {
    expect(
      Provisioning.Person.shape.endpoints.element.safeParse({ channel: "telegram", externalId: "" }).success,
    ).toBe(false);
    expect(
      Provisioning.Person.shape.endpoints.element.safeParse({
        channel: "telegram",
        externalId: "1",
        username: "mutable",
      }).success,
    ).toBe(false);
  });
});

describe("Provisioning.ChannelInstance", () => {
  test("parses with optional credentialRef/grant and rejects inline secrets (strict)", () => {
    const valid: Provisioning.ChannelInstance = {
      id: "channel:telegram:main",
      provider: "telegram",
      identity: "bot",
      enabled: true,
      settings: { pollIntervalMs: 500 },
      credentialRef: "secret:channel-telegram-main",
      grant: { defaultTier: "observer", provisionalMint: true },
      revision: 1,
      createdBy: "person:ino",
      updatedAt: NOW,
    };
    expect(Provisioning.ChannelInstance.parse(valid)).toEqual(valid);
    expect(Provisioning.ChannelInstance.safeParse({ ...valid, token: "inline" }).success).toBe(
      false,
    );
  });
});

describe("Provisioning.Secret", () => {
  test("§8.2 by construction: only ciphertext fields exist, plaintext is rejected", () => {
    const valid: Provisioning.Secret = {
      id: "secret:channel-telegram-main",
      ciphertext: new Uint8Array([1, 2, 3]),
      wrappedDek: new Uint8Array([4, 5, 6]),
      kekId: "kek:abc123",
      purpose: "channel_credential",
      createdAt: NOW,
    };
    expect(Provisioning.Secret.parse(valid)).toEqual(valid);
    expect(Provisioning.Secret.safeParse({ ...valid, plaintext: "leak" }).success).toBe(false);
    expect(Object.keys(Provisioning.Secret.shape)).not.toContain("plaintext");
  });
});

describe("Provisioning typed errors", () => {
  test("StoreError and VaultError carry their code taxonomies", () => {
    const store = new Provisioning.StoreError({
      message: "second owner",
      code: "owner_exists",
      id: "person:ino",
    });
    expect(Provisioning.StoreError.isInstance(store)).toBe(true);
    expect(store.data.code).toBe("owner_exists");
    const vault = new Provisioning.VaultError({
      message: "no KEK",
      code: "vault_locked",
    });
    expect(Provisioning.VaultError.isInstance(vault)).toBe(true);
    expect(vault.data.code).toBe("vault_locked");
  });
});
