import { expect, test } from "bun:test";
import { openTestChannelStore } from "../helpers/sqlite";

test("actor endpoint filters distinguish no filter from the empty workspace", () => {
  const opened = openTestChannelStore(":memory:");
  try {
    const store = opened.store.actorRegistry;
    for (const id of ["a", "b"]) store.setIdentity({ id, kind: "human", trustTier: "observer" });
    for (const [id, actorId, workspace] of [
      ["1", "a", ""],
      ["2", "a", "guild"],
      ["3", "b", "guild"],
    ] as const) {
      store.setEndpoint({
        id,
        actorId,
        workspace: workspace || undefined,
        channel: "discord",
        externalId: id,
        createdAt: 1,
        updatedAt: 1,
      });
    }
    expect(store.listEndpoints().map((row) => row.id)).toEqual(["1", "2", "3"]);
    expect(store.listEndpoints("a").map((row) => row.id)).toEqual(["1", "2"]);
    expect(store.listEndpoints(undefined, "guild").map((row) => row.id)).toEqual(["2", "3"]);
    expect(store.listEndpoints("b", "guild").map((row) => row.id)).toEqual(["3"]);
    expect(store.listEndpoints(undefined, "").map((row) => row.id)).toEqual(["1"]);
    // #1600: an exact workspace match first; a workspace-less row answers for every workspace of the platform.
    expect(store.findEndpoint("discord", "2", "guild")?.id).toBe("2");
    expect(store.findEndpoint("discord", "1", "guild")?.id).toBe("1");
    expect(store.findEndpoint("discord", "1", undefined)?.id).toBe("1");
    expect(store.findEndpoint("discord", "3", "elsewhere")).toBeUndefined();
    opened.db.query("UPDATE actor_endpoint SET data = ? WHERE id = '2'").run('{"id":"2"}');
    expect(() => store.getEndpoint("2")).toThrow();
    expect(() => store.findEndpoint("discord", "2", "guild")).toThrow();
    expect(() => store.listEndpoints("a")).toThrow();
  } finally {
    opened.close();
  }
});
