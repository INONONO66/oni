import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "@openomni/channels";
import type { AppLedgerPlane } from "../src/composition/cluster-runtime";
import { testPlane } from "./helpers/ledger";
import { Actor, type Provisioning } from "@openomni/protocol";
import { declaredChannelProfile, validateProviderCredential } from "../src/channels";
import { MOUNTED_CHANNEL_DEFAULT_TIER } from "../src/gateway";
import {
  desiredChannels,
  materializePersons,
  vaultCredentialReader,
} from "../src/bundles/provision/declared";
import { resolveKek, vaultKeyPath } from "../src/bundles/provision/vault-key";

import { putChannelCredential } from "./helpers/channel-credential";
import { testChannelDeps } from "./helpers/test-entropy";

const NOW = 1_756_000_000_000;
const KEY_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

function instance(overrides: Partial<Provisioning.ChannelInstance>): Provisioning.ChannelInstance {
  return {
    id: "channel:telegram:main",
    provider: "telegram",
    enabled: true,
    settings: {},
    credentialRef: "secret:channel-telegram-main",
    revision: 0,
    createdBy: "test",
    updatedAt: NOW,
    ...overrides,
  };
}

describe("vault-key resolution", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "vault-key-test-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true });
  });

  test("OPENOMNI_VAULT_KEY wins over the key file", async () => {
    await writeFile(join(home, "unused"), "");
    const resolved = resolveKek({ OPENOMNI_VAULT_KEY: KEY_B64 }, home);
    expect(resolved.kind).toBe("ok");
  });

  test("a wrong-length env key is locked, never a partial KEK", () => {
    const short = Buffer.from(new Uint8Array(16)).toString("base64");
    const resolved = resolveKek({ OPENOMNI_VAULT_KEY: short }, home);
    expect(resolved.kind === "locked" && resolved.reason.includes("32 bytes")).toBe(true);
  });

  test("no env key and no key file is locked with the missing path named", () => {
    const resolved = resolveKek({}, home);
    expect(resolved.kind === "locked" && resolved.reason.includes(vaultKeyPath(home))).toBe(true);
  });

  test("an operator key file resolves without changing its bytes or permissions", async () => {
    expect(resolveKek({}, home).kind).toBe("locked");
    await mkdir(join(home, ".openomni"));
    const path = vaultKeyPath(home);
    await writeFile(path, `${KEY_B64}\n`, { mode: 0o600 });
    expect(resolveKek({}, home).kind).toBe("ok");
    expect(await readFile(path, "utf8")).toBe(`${KEY_B64}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("declared channel profile", () => {
  const kek = Vault.kekOf(new Uint8Array(32).fill(7));

  function readerFor(rows: Record<string, string>): Parameters<typeof declaredChannelProfile>[1] {
    return (ref) => {
      const plaintext = rows[ref];
      return plaintext === undefined
        ? { kind: "locked", reason: `no vault row for credentialRef ${ref}` }
        : { kind: "ok", plaintext: new TextEncoder().encode(plaintext) };
    };
  }

  test("a valid declaration mounts with the provider's empty driver configuration", () => {
    const { rows, statuses } = declaredChannelProfile(
      [instance({})],
      readerFor({ "secret:channel-telegram-main": '{"token":"tg-token"}' }),
      testChannelDeps(),
    );
    expect(statuses).toEqual([
      { id: "channel:telegram:main", provider: "telegram", state: "ready" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.instanceId).toBe("channel:telegram:main");
    expect(rows[0]?.component.id).toBe("telegram");
    const built = rows[0]?.component.build(() => Promise.resolve());
    expect(built?.surface.config).toEqual({});
    expect(built?.surface.id).toBe("telegram");
  });

  test("disabled, unknown-provider, and credential-less rows are statuses, not mounts", () => {
    const { rows, statuses } = declaredChannelProfile(
      [
        instance({ enabled: false }),
        instance({ id: "channel:smoke:main", provider: "smoke" }),
        instance({ id: "channel:discord:main", provider: "discord", credentialRef: undefined }),
      ],
      readerFor({}),
      testChannelDeps(),
    );
    expect(rows).toEqual([]);
    expect(statuses.map((status) => status.state)).toEqual([
      "disabled",
      "unknown_provider",
      "missing_credential",
    ]);
  });

  test("locked vault and malformed payloads fail closed per row", () => {
    const { rows, statuses } = declaredChannelProfile(
      [
        instance({}),
        instance({
          id: "channel:discord:main",
          provider: "discord",
          credentialRef: "secret:channel-discord-main",
        }),
        instance({
          id: "channel:github:main",
          provider: "github",
          credentialRef: "secret:channel-github-main",
        }),
      ],
      readerFor({
        "secret:channel-discord-main": "not json",
        "secret:channel-github-main": '{"wrong":"shape"}',
      }),
      testChannelDeps(),
    );
    expect(rows).toEqual([]);
    expect(statuses.map((status) => status.state)).toEqual([
      "vault_locked",
      "credential_invalid",
      "credential_invalid",
    ]);
  });

  test("vaultCredentialReader opens real store rows and reports lock reasons", () => {
    const plane = testPlane();
    try {
      const envelope = Vault.seal(new TextEncoder().encode('{"token":"tg"}'), kek);
      plane.stores.secrets.put({
        id: "secret:channel-telegram-main",
        ciphertext: envelope.ciphertext,
        wrappedDek: envelope.wrappedDek,
        kekId: envelope.kekId,
        purpose: "channel_credential",
        createdAt: NOW,
      });
      const readSecret = (id: string) => plane.stores.secrets.get(id);
      const reader = vaultCredentialReader({ kind: "ok", kek }, readSecret);
      const hit = reader("secret:channel-telegram-main");
      expect(hit.kind === "ok" && new TextDecoder().decode(hit.plaintext)).toBe('{"token":"tg"}');
      const miss = reader("secret:absent");
      expect(miss.kind === "locked" && miss.reason.includes("secret:absent")).toBe(true);
      const locked = vaultCredentialReader({ kind: "locked", reason: "no key" }, readSecret)("secret:any");
      expect(locked).toEqual({ kind: "locked", reason: "no key" });
      const wrongKek = vaultCredentialReader({
        kind: "ok",
        kek: Vault.kekOf(new Uint8Array(32).fill(8)),
      }, readSecret)("secret:channel-telegram-main");
      expect(wrongKek.kind === "locked" && wrongKek.reason.includes("kek")).toBe(true);
    } finally {
      plane.close();
    }
  });
});

describe("boot profile selection (§8.1, §8.4)", () => {
  const state: { home: string; plane: AppLedgerPlane | undefined } = { home: "", plane: undefined };
  const plane = () => {
    if (state.plane === undefined) throw new Error("test plane not open");
    return state.plane;
  };
  const provisionStores = () => ({
    instances: plane().stores.instances,
    secrets: plane().stores.secrets,
  });

  beforeEach(async () => {
    state.home = await mkdtemp(join(tmpdir(), "select-profile-test-"));
    state.plane = testPlane();
  });

  afterEach(async () => {
    state.plane?.close();
    state.plane = undefined;
    await rm(state.home, { recursive: true });
  });

  test("no declarations means no external channels", () => {
    const selection = desiredChannels(provisionStores(), resolveKek({}, state.home), testChannelDeps());
    expect(selection.source).toBe("declared");
    expect(selection.rows).toEqual([]);
    expect(selection.statuses).toEqual([]);
  });

  // #931: the ChannelInstance grant block is the Owner's tier decision; a
  // declaration without one mounts at the mount tier, never owner.
  test("a declared row carries its grant tier, and an undeclared grant mounts at the mount tier", () => {
    putChannelCredential(
      plane().stores.secrets,
      "secret:channel-telegram-main",
      '{"token":"tg"}',
      new Uint8Array(32).fill(7),
      NOW,
    );

    // Every declared tier threads through exactly: a remap of any single tier
    // (e.g. observer -> owner) fails here rather than surviving on one literal.
    for (const tier of Actor.TrustTier.options) {
      plane().stores.instances.put(instance({ grant: { defaultTier: tier } }));
      const declaredTier = desiredChannels(provisionStores(), resolveKek({ OPENOMNI_VAULT_KEY: KEY_B64 }, state.home), testChannelDeps());
      expect(declaredTier.rows[0]?.defaultTier).toBe(tier);
    }

    plane().stores.instances.put(instance({ grant: { allowedSenders: ["tg:1"] } }));
    const noTier = desiredChannels(provisionStores(), resolveKek({ OPENOMNI_VAULT_KEY: KEY_B64 }, state.home), testChannelDeps());
    expect(noTier.rows[0]?.defaultTier).toBe(MOUNTED_CHANNEL_DEFAULT_TIER);
  });

  test("a disabled declaration stays unmounted", () => {
    plane().stores.instances.put(instance({ enabled: false, credentialRef: undefined }));
    const selection = desiredChannels(provisionStores(), resolveKek({ OPENOMNI_VAULT_KEY: KEY_B64 }, state.home), testChannelDeps());
    expect(selection.source).toBe("declared");
    expect(selection.rows).toEqual([]);
    expect(selection.statuses).toEqual([
      { id: "channel:telegram:main", provider: "telegram", state: "disabled" },
    ]);
  });

  test("§8.4 locked vault: enabled declarations become vault_locked statuses, nothing mounts", () => {
    plane().stores.instances.put(instance({}));
    const selection = desiredChannels(provisionStores(), resolveKek({}, state.home), testChannelDeps());
    expect(selection.source).toBe("declared");
    expect(selection.rows).toEqual([]);
    expect(selection.statuses[0]?.state).toBe("vault_locked");
    expect(selection.statuses[0]?.detail).toContain("no OPENOMNI_VAULT_KEY");
  });

  test("§8.7 the declared bounce key folds revision with the secret's rotation epoch", () => {
    const envelope = putChannelCredential(
      plane().stores.secrets,
      "secret:channel-telegram-main",
      '{"token":"tg"}',
      new Uint8Array(32).fill(7),
      NOW,
    );
    plane().stores.instances.put(instance({ revision: 4 }));
    const get = spyOn(plane().stores.secrets, "get");
    let before: ReturnType<typeof desiredChannels>;
    try {
      before = desiredChannels(provisionStores(), resolveKek({ OPENOMNI_VAULT_KEY: KEY_B64 }, state.home), testChannelDeps());
      expect(get.mock.calls).toEqual([["secret:channel-telegram-main"]]);
    } finally {
      get.mockRestore();
    }
    expect(before.rows[0]?.instanceId).toBe("channel:telegram:main");
    expect(before.rows[0]?.key).toBe(`4:${NOW}`);

    plane().stores.secrets.put({
      id: "secret:channel-telegram-main",
      ciphertext: envelope.ciphertext,
      wrappedDek: envelope.wrappedDek,
      kekId: envelope.kekId,
      purpose: "channel_credential",
      createdAt: NOW,
      rotatedAt: NOW + 50,
    });
    const after = desiredChannels(provisionStores(), resolveKek({ OPENOMNI_VAULT_KEY: KEY_B64 }, state.home), testChannelDeps());
    expect(after.rows[0]?.key).toBe(`4:${NOW + 50}`);
  });
});

describe("materializePersons", () => {
  const planeRef: { current: AppLedgerPlane | undefined } = { current: undefined };
  beforeEach(() => {
    planeRef.current = testPlane();
  });

  afterEach(() => {
    planeRef.current?.close();
    planeRef.current = undefined;
  });

  test("Person manifests become identity and endpoint facts, idempotently", () => {
    const plane = planeRef.current;
    if (plane === undefined) throw new Error("test plane not open");
    plane.stores.persons.put({
      id: "person:ino",
      displayName: "Ino",
      kind: "human",
      trustTier: "owner",
      endpoints: [
        { channel: "telegram", externalId: "12345" },
        { channel: "discord", externalId: "9876", workspace: "guild-1" },
      ],
      revision: 0,
      createdBy: "openomni-init",
      updatedAt: NOW,
    });
    const stores = { persons: plane.stores.persons, actors: plane.stores.actors };
    materializePersons(stores);
    materializePersons(stores);
    const identity = plane.stores.actors.getIdentity("person:ino");
    expect(identity?.trustTier).toBe("owner");
    expect(identity?.displayName).toBe("Ino");
    const resolved = plane.stores.actors.resolveEndpoint("telegram", "12345");
    expect(resolved?.endpoint.actorId).toBe("person:ino");
    const discord = plane.stores.actors.resolveEndpoint("discord", "9876", "guild-1");
    expect(discord?.endpoint.workspace).toBe("guild-1");
  });
});

describe("provider credential gate", () => {
  test("an unregistered provider is refused before any schema runs", () => {
    expect(validateProviderCredential("smoke", { token: "t" })).toBe("unknown provider smoke");
  });
});

describe("github declared row", () => {
  test("a github declaration mounts through the provider credential schema", () => {
    const { rows, statuses } = declaredChannelProfile(
      [
        {
          id: "channel:github:main",
          provider: "github",
          enabled: true,
          settings: {},
          credentialRef: "secret:channel-github-main",
          revision: 0,
          createdBy: "test",
          updatedAt: 1,
        },
      ],
      () => ({
        kind: "ok",
        plaintext: new TextEncoder().encode('{"secret":"hook-secret"}'),
      }),
      testChannelDeps(),
    );
    expect(statuses).toEqual([{ id: "channel:github:main", provider: "github", state: "ready" }]);
    expect(rows[0]?.component.id).toBe("github");
  });

  test("a slack declaration mounts through the provider credential schema", () => {
    const { rows, statuses } = declaredChannelProfile(
      [
        {
          id: "channel:slack:main",
          provider: "slack",
          enabled: true,
          settings: {},
          credentialRef: "secret:channel-slack-main",
          revision: 0,
          createdBy: "test",
          updatedAt: 1,
        },
      ],
      () => ({
        kind: "ok",
        plaintext: new TextEncoder().encode('{"botToken":"xoxb-1","appToken":"xapp-1"}'),
      }),
      testChannelDeps(),
    );
    expect(statuses).toEqual([{ id: "channel:slack:main", provider: "slack", state: "ready" }]);
    expect(rows[0]?.component.id).toBe("slack");
  });
});
