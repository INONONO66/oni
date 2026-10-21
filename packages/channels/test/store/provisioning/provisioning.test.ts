import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createDecipheriv, type DecipherGCM } from "node:crypto";
import { expectNamedFailure } from "../helpers/errors";
import { useSqliteChannelStore } from "../helpers/sqlite";
import { inspect } from "node:util";
import { Provisioning } from "@oni/protocol";
import { createChannelInstanceStore, createPersonStore, createSecretStore, Vault, } from "../../../src/index.js";

const NOW = 1_756_000_000_000;

function person(id: string, trustTier: Provisioning.Person["trustTier"]): Provisioning.Person {
  return {
    id,
    displayName: id,
    kind: "human",
    trustTier,
    endpoints: [{ channel: "telegram", externalId: "12345" }],
    revision: 0,
    createdBy: "test",
    updatedAt: NOW,
  };
}

function kekFixture(byte: number): Vault.Kek {
  return Vault.kekOf(new Uint8Array(32).fill(byte));
}

function secretRow(id: string, envelope: Vault.Envelope): Provisioning.Secret {
  return {
    id,
    ciphertext: envelope.ciphertext,
    wrappedDek: envelope.wrappedDek,
    kekId: envelope.kekId,
    purpose: "channel_credential",
    createdAt: NOW,
  };
}

describe("provisioning stores", () => {
  const stores = useSqliteChannelStore("provisioning");
  const persons = () => createPersonStore(stores.store);
  const instances = () => createChannelInstanceStore(stores.store);
  const secrets = () => createSecretStore(stores.store);

  test("Person roundtrips, lists, and removes", () => {
    const declared = persons().put(person("person:alice", "collaborator"));
    expect(persons().get("person:alice")).toEqual(declared);
    expect(persons().list()).toEqual([declared]);
    expect(persons().remove("person:alice")).toBe(true);
    expect(persons().get("person:alice")).toBeUndefined();
    expect(persons().remove("person:alice")).toBe(false);
  });

  test("sole-owner invariant: a second owner Person is a typed owner_exists refusal", () => {
    persons().put(person("person:ino", "owner"));
    expectNamedFailure(
      () => persons().put(person("person:mallory", "owner")),
      Provisioning.StoreError.name,
      { code: "owner_exists", id: "person:ino" },
    );
    expect(persons().get("person:mallory")).toBeUndefined();
  });

  test("the reigning owner Person may be re-declared and other tiers coexist", () => {
    persons().put(person("person:ino", "owner"));
    const updated = persons().put({ ...person("person:ino", "owner"), revision: 1 });
    expect(updated.revision).toBe(1);
    persons().put(person("person:bob", "observer"));
    expect(persons().list()).toHaveLength(2);
  });

  test("ChannelInstance roundtrips with settings and credentialRef intact", () => {
    const instance: Provisioning.ChannelInstance = {
      id: "channel:telegram:main",
      provider: "telegram",
      identity: "bot",
      enabled: true,
      settings: { pollIntervalMs: 500 },
      credentialRef: "secret:channel-telegram-main",
      revision: 0,
      createdBy: "test",
      updatedAt: NOW,
    };
    instances().put(instance);
    expect(instances().get(instance.id)).toEqual(instance);
    expect(instances().list()).toEqual([instance]);
    expect(instances().remove(instance.id)).toBe(true);
    expect(instances().list()).toEqual([]);
  });

  test("Secret BLOB envelope roundtrips byte-exact through SQLite", () => {
    const kek = kekFixture(7);
    const envelope = Vault.seal(new TextEncoder().encode('{"token":"tg-token"}'), kek);
    const row = secretRow("secret:channel-telegram-main", envelope);
    secrets().put(row);
    const loaded = secrets().get(row.id);
    if (loaded === undefined) throw new Error("expected the secret row back");
    expect(loaded.ciphertext).toEqual(envelope.ciphertext);
    expect(loaded.wrappedDek).toEqual(envelope.wrappedDek);
    expect(loaded.kekId).toBe(kek.id);
    expect(Vault.open(loaded, kek).revealText()).toBe('{"token":"tg-token"}');
    expect(secrets().list()).toHaveLength(1);
    expect(secrets().remove(row.id)).toBe(true);
  });

  test("§8.2: the database file never contains credential plaintext", async () => {
    const plaintext = "hunter2-super-secret-token";
    const kek = kekFixture(9);
    secrets().put(
      secretRow("secret:leak-probe", Vault.seal(new TextEncoder().encode(plaintext), kek)),
    );
    const fileBytes = await readFile(stores.path);
    expect(fileBytes.includes(plaintext)).toBe(false);
  });

  test("a storage adapter without the provisioning seam fails closed with adapter_absent", () => {
    const bare = { transaction: <T>(fn: () => T): T => fn() };
    for (const attempt of [
      () => createPersonStore(bare).list(),
      () => createChannelInstanceStore(bare).list(),
      () => createSecretStore(bare).list(),
    ]) {
      expectNamedFailure(attempt, Provisioning.StoreError.name, { code: "adapter_absent" });
    }
  });
});

describe("Vault envelope crypto", () => {
  test("kekOf refuses non-32-byte keys with a typed vault_locked error", () => {
    expectNamedFailure(() => Vault.kekOf(new Uint8Array(16)), Provisioning.VaultError.name, {
      code: "vault_locked",
    });
  });

  test("kek ids are stable fingerprints of the key bytes", () => {
    expect(kekFixture(3).id).toBe(kekFixture(3).id);
    expect(kekFixture(3).id).not.toBe(kekFixture(4).id);
    expect(kekFixture(3).id.startsWith("kek:")).toBe(true);
  });

  test("seal produces ciphertext that shares no bytes with the plaintext", () => {
    const plaintext = "xoxb-plaintext-credential";
    const envelope = Vault.seal(new TextEncoder().encode(plaintext), kekFixture(1));
    expect(Buffer.from(envelope.ciphertext).includes(plaintext)).toBe(false);
  });

  test("open under the wrong KEK id is a typed kek_mismatch", () => {
    const envelope = Vault.seal(new TextEncoder().encode("value"), kekFixture(1));
    expectNamedFailure(
      () => Vault.open({ ...envelope, id: "secret:mismatch" }, kekFixture(2)),
      Provisioning.VaultError.name,
      { code: "kek_mismatch", secretId: "secret:mismatch" },
    );
  });

  test("a tampered ciphertext fails authentication as a typed unopenable", () => {
    const kek = kekFixture(1);
    const envelope = Vault.seal(new TextEncoder().encode("value"), kek);
    const tampered = new Uint8Array(envelope.ciphertext);
    const lastIndex = tampered.length - 1;
    tampered[lastIndex] = (tampered[lastIndex] ?? 0) ^ 0xff;
    expectNamedFailure(
      () => Vault.open({ ...envelope, ciphertext: tampered }, kek),
      Provisioning.VaultError.name,
      { code: "unopenable" },
    );
  });

  test("authentication failures preserve the exact decipher error as cause", () => {
    const kek = kekFixture(1);
    const envelope = Vault.seal(new TextEncoder().encode("value"), kek);
    const tampered = new Uint8Array(envelope.ciphertext);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    const decipherError = new Error("decipher authentication failed");
    const spyFactory = (algorithm: "aes-256-gcm", key: Uint8Array, iv: Uint8Array): DecipherGCM => {
      const decipher = createDecipheriv(algorithm, key, iv);
      function wrappedFinal(): Buffer<ArrayBuffer>;
      function wrappedFinal(outputEncoding: BufferEncoding): string;
      function wrappedFinal(_outputEncoding?: BufferEncoding): Buffer<ArrayBuffer> | string {
        throw decipherError;
      }
      decipher.final = wrappedFinal;
      return decipher;
    };
    expect(() => Vault.open({ ...envelope, ciphertext: tampered }, kek, spyFactory)).toThrow(
      expect.objectContaining({ cause: decipherError }),
    );
  });

  test("a truncated packed blob is a typed unopenable, not a crash", () => {
    const kek = kekFixture(1);
    const envelope = Vault.seal(new TextEncoder().encode("value"), kek);
    expectNamedFailure(
      () => Vault.open({ ...envelope, wrappedDek: envelope.wrappedDek.slice(0, 8) }, kek),
      Provisioning.VaultError.name,
      { code: "unopenable" },
    );
  });

  test("§8.3: every accidental serialization of a revealed secret prints [redacted]", () => {
    const kek = kekFixture(5);
    const revealed = Vault.open(Vault.seal(new TextEncoder().encode("tg-token"), kek), kek);
    expect(String(revealed)).toBe("[redacted]");
    expect(`${revealed}`).toBe("[redacted]");
    expect(JSON.stringify({ secret: revealed })).toBe('{"secret":"[redacted]"}');
    expect(inspect(revealed)).toBe("[redacted]");
    expect(revealed.reveal()).toEqual(new TextEncoder().encode("tg-token"));
    expect(revealed.revealText()).toBe("tg-token");
  });
});
