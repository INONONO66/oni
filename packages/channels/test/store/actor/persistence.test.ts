import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createActorRegistry } from "../../../src/index.js";
import { useSqliteChannelStore } from "../helpers/sqlite";

describe("ActorRegistry SQLite persistence", () => {
  const stores = useSqliteChannelStore("actor-registry");
  const registry = () => createActorRegistry(stores.store);
  const registerAccountEndpoint = () => {
    registry().registerIdentity({
      id: "act_account",
      kind: "human",
      trustTier: "manager",
    });
    registry().registerEndpoint({
      id: "ep_discord_user_1",
      actorId: "act_account",
      channel: "discord",
      externalId: "user-1",
      workspace: "guild",
    });
  };

  test("resolves registered endpoints across storage re-init", () => {
    // Given
    registerAccountEndpoint();

    stores.reopen();
    const resolved = registry().resolveEndpoint("discord", "user-1", "guild");

    // Then
    expect(resolved?.identity.id).toBe("act_account");
    expect(resolved?.identity.trustTier).toBe("manager");
    expect(resolved?.endpoint.id).toBe("ep_discord_user_1");
  });

  test("returns undefined for unregistered endpoints", () => {
    // Given
    registry().registerIdentity({
      id: "act_account",
      kind: "human",
      trustTier: "manager",
    });

    // When
    const resolved = registry().resolveEndpoint("discord", "unknown-user");

    // Then
    expect(resolved).toBeUndefined();
  });

  test("preserves createdAt when re-registering an identity", () => {
    // Given
    const createdAt = 100;
    registry().registerIdentity({
      id: "act_account",
      kind: "human",
      trustTier: "manager",
      createdAt,
      updatedAt: createdAt,
    });

    // When
    const updated = registry().registerIdentity({
      id: "act_account",
      kind: "human",
      trustTier: "manager",
      createdAt,
      updatedAt: createdAt,
    });

    // Then
    expect(updated.createdAt).toBe(createdAt);
    expect(updated.updatedAt).toBeGreaterThan(createdAt);
    expect(registry().getIdentity("act_account")?.trustTier).toBe("manager");
  });

  test("rejects endpoints for unknown actor identities", () => {
    // When / Then
    expect(() =>
      registry().registerEndpoint({
        id: "ep_missing_actor",
        actorId: "act_missing",
        channel: "discord",
        externalId: "user-1",
      }),
    ).toThrow("Actor identity not found: act_missing");
  });

  test("rejects duplicate endpoint addresses with different endpoint ids", () => {
    // Given
    registerAccountEndpoint();

    // When / Then
    expect(() =>
      registry().registerEndpoint({
        id: "ep_discord_user_1_duplicate",
        actorId: "act_account",
        channel: "discord",
        externalId: "user-1",
        workspace: "guild",
      }),
    ).toThrow("Actor endpoint already registered for discord:guild:user-1");
  });

  test("allows the same endpoint address in different workspaces", () => {
    // Given
    registry().registerIdentity({
      id: "act_account",
      kind: "human",
      trustTier: "manager",
    });
    registry().registerIdentity({
      id: "act_collaborator",
      kind: "human",
      trustTier: "collaborator",
    });
    registry().registerEndpoint({
      id: "ep_discord_user_1_guild_a",
      actorId: "act_account",
      channel: "discord",
      externalId: "user-1",
      workspace: "guild-a",
    });

    // When
    registry().registerEndpoint({
      id: "ep_discord_user_1_guild_b",
      actorId: "act_collaborator",
      channel: "discord",
      externalId: "user-1",
      workspace: "guild-b",
    });

    // Then
    expect(registry().resolveEndpoint("discord", "user-1", "guild-a")?.identity.id).toBe(
      "act_account",
    );
    expect(registry().resolveEndpoint("discord", "user-1", "guild-b")?.identity.id).toBe(
      "act_collaborator",
    );
    expect(registry().resolveEndpoint("discord", "user-1", "guild-c")).toBeUndefined();
  });

  test("an old-format row whose data blob carries relationship parses and round-trips (#498 A1)", () => {
    // Given — a row persisted BEFORE the relationship removal: migration 0018
    // dropped the column, but the JSON blob keeps the retired key forever.
    const db = new Database(stores.path);
    db.query(
      `INSERT INTO actor_identity (id, data, kind, trust_tier, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "act_legacy",
      JSON.stringify({
        id: "act_legacy",
        kind: "human",
        trustTier: "manager",
        relationship: "manager",
        createdAt: 100,
        updatedAt: 100,
      }),
      "human",
      "manager",
      100,
      100,
    );
    db.close();
    stores.reopen();

    // When — read the legacy blob, then write it back through the registry.
    const identity = registry().getIdentity("act_legacy");
    if (!identity) throw new Error("legacy identity not found");
    const roundTripped = registry().registerIdentity({ ...identity, trustTier: "manager" });

    // Then — the retired key is stripped on read and stays gone after re-write.
    expect("relationship" in identity).toBe(false);
    expect(identity.trustTier).toBe("manager");
    expect(identity.createdAt).toBe(100);
    expect("relationship" in roundTripped).toBe(false);
    expect(registry().getIdentity("act_legacy")?.trustTier).toBe("manager");
  });

  test("filters endpoint lists by actor and workspace", () => {
    // Given — two actors, endpoints across two workspaces.
    registry().registerIdentity({ id: "act_account", kind: "human", trustTier: "manager" });
    registry().registerIdentity({
      id: "act_collaborator",
      kind: "human",
      trustTier: "collaborator",
    });
    registry().registerEndpoint({
      id: "ep_account_a",
      actorId: "act_account",
      channel: "discord",
      externalId: "user-1",
      workspace: "guild-a",
    });
    registry().registerEndpoint({
      id: "ep_account_b",
      actorId: "act_account",
      channel: "discord",
      externalId: "user-1",
      workspace: "guild-b",
    });
    registry().registerEndpoint({
      id: "ep_collab_a",
      actorId: "act_collaborator",
      channel: "discord",
      externalId: "user-2",
      workspace: "guild-a",
    });

    // Then — every filter branch of the SQLite adapter returns the exact set
    // (ids sorted: the adapter orders by insertion timestamp, which is not a
    // stable assertion surface across same-millisecond registrations).
    const ids = (endpoints: readonly { id: string }[]) =>
      endpoints.map((endpoint) => endpoint.id).sort();
    expect(ids(registry().listEndpoints())).toEqual(["ep_account_a", "ep_account_b", "ep_collab_a"]);
    expect(ids(registry().listEndpoints("act_account"))).toEqual(["ep_account_a", "ep_account_b"]);
    expect(ids(registry().listEndpoints(undefined, "guild-a"))).toEqual([
      "ep_account_a",
      "ep_collab_a",
    ]);
    expect(ids(registry().listEndpoints("act_account", "guild-b"))).toEqual(["ep_account_b"]);
  });

  test("removing an identity removes its endpoints through SQLite cascade", () => {
    // Given
    registerAccountEndpoint();

    // When
    registry().removeIdentity("act_account");

    // Then
    expect(registry().getEndpoint("ep_discord_user_1")).toBeUndefined();
    expect(registry().resolveEndpoint("discord", "user-1", "guild")).toBeUndefined();
  });

  test("removing an endpoint preserves its identity and removes address lookup", () => {
    const registry = createActorRegistry(stores.store);
    registry.registerIdentity({ id: "actor", kind: "human", trustTier: "observer" });
    registry.registerEndpoint({
      id: "endpoint",
      actorId: "actor",
      channel: "discord",
      externalId: "external",
    });
    const adapter = stores.store.actorRegistry;
    expect(adapter.removeEndpoint("endpoint")).toBe(true);
    expect(registry.getIdentity("actor")?.id).toBe("actor");
    expect(registry.resolveEndpoint("discord", "external")).toBeUndefined();
    expect(adapter.removeEndpoint("endpoint")).toBe(false);
  });
});
