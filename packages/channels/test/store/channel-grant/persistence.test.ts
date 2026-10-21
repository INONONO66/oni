import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createChannelGrantStore } from "../../../src/index.js";
import { testNow, useSqliteChannelStore } from "../helpers/sqlite";
import { Actor } from "@oni/protocol";

describe("ChannelGrantStore SQLite persistence", () => {
  const stores = useSqliteChannelStore("channel-grant");
  const grants = () => createChannelGrantStore(stores.store);

  test("persists grant fields without resolution-derived normalization", () => {
    const stored = grants().put({
      id: "grant-byte-fixture",
      surface: "discord",
      workspace: "guild",
      channel: "design",
      kind: "broadcast_channel",
      defaultTier: "observer",
      inboundTreatment: "full_access",
      createdBy: "act_owner",
      createdAt: 100,
      updatedAt: 200,
    });

    using reader = new Database(stores.path, { readonly: true });
    const row = reader
      .query<{ data: string }, [string]>("SELECT data FROM channel_grant WHERE id = ?")
      .get("grant-byte-fixture");
    if (row === null) throw new Error("missing persisted grant");
    expect(row.data).toBe(
      '{"id":"grant-byte-fixture","surface":"discord","workspace":"guild","channel":"design","kind":"broadcast_channel","defaultTier":"observer","inboundTreatment":"full_access","createdBy":"act_owner","createdAt":100,"updatedAt":200}',
    );
    expect(Actor.ChannelGrant.parse(JSON.parse(row.data))).toEqual(stored);
  });

  test("round-trips raw grant facts across adapter reconfiguration", () => {
    const stored = grants().put({
      id: "grant-channel",
      surface: "discord",
      workspace: "guild",
      channel: "design",
      kind: "broadcast_channel",
      defaultTier: "observer",
      createdBy: "act_owner",
      createdAt: 100,
      updatedAt: 200,
    });

    stores.reopen();

    expect(grants().get(stored.id)).toEqual(stored);
    expect(grants().list()).toEqual([stored]);
  });

  test("removes exactly one stored fact", () => {
    grants().put({
      id: "grant-discord",
      surface: "discord",
      kind: "trusted_channel",
      createdBy: "act_owner",
    });

    expect(grants().remove("grant-discord")).toBe(true);
    expect(grants().get("grant-discord")).toBeUndefined();
    expect(grants().remove("grant-discord")).toBe(false);
  });

  test("raw reads fail closed when the channelGrant sub-adapter is absent", () => {
    expect(() => createChannelGrantStore({ now: testNow }).list()).toThrow("does not implement channel grants");
  });
});
