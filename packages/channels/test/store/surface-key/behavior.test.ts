import { describe, expect, test } from "bun:test";
import { Channel } from "@oni/protocol";
import { createSurfaceKeyStore } from "../../../src/store/surface-key/index.js";
import { useMemoryChannelStore } from "../helpers/sqlite";

// The pure string codec (create/fromChannel/parse) lives in the protocol
// adapter domain — see packages/protocol/test/adapter-surface-key.test.ts.
// This suite covers the storage semantics: claim/lookup/listBySession.
// The mapping is session-agnostic by design (#1317): session ids are opaque
// strings here, so no session rows are materialized.

describe("SurfaceKey", () => {
  const stores = useMemoryChannelStore();
  const surfaceKeys = () => createSurfaceKeyStore(stores.store);

  describe("claim and lookup", () => {
    test("claims and looks up a surfaceKey", () => {
      const key = "slack:workspaceA:channel:C123";
      const sessionId = "session-123";

      surfaceKeys().claim(key, sessionId);
      expect(surfaceKeys().lookup(key)).toBe(sessionId);
    });

    test("returns undefined for unregistered key", () => {
      expect(surfaceKeys().lookup("slack:unknown")).toBeUndefined();
    });

    test("throws error on invalid format during claim", () => {
      expect(() => surfaceKeys().claim("invalid", "session-123")).toThrow(
        /Invalid surfaceKey format/,
      );
    });
  });

  describe("N:1 mapping (multiple keys → same session)", () => {
    test("allows multiple keys to map to same session", () => {
      const sessionId = "session-123";
      const key1 = "slack:workspaceA:channel:C123";
      const key2 = "slack:workspaceA:channel:C456";

      surfaceKeys().claim(key1, sessionId);
      surfaceKeys().claim(key2, sessionId);

      expect(surfaceKeys().lookup(key1)).toBe(sessionId);
      expect(surfaceKeys().lookup(key2)).toBe(sessionId);
    });

    test("lists all keys for a session", () => {
      const sessionId = "session-123";
      const key1 = "slack:workspaceA:channel:C123";
      const key2 = "slack:workspaceA:channel:C456";
      const key3 = "telegram:botId:chat:chatId";

      surfaceKeys().claim(key1, sessionId);
      surfaceKeys().claim(key2, sessionId);
      surfaceKeys().claim(key3, sessionId);

      const keys = surfaceKeys().listBySession(sessionId);
      expect(keys).toHaveLength(3);
      expect(keys).toContain(key1);
      expect(keys).toContain(key2);
      expect(keys).toContain(key3);
    });

    test("returns empty array for session with no keys", () => {
      expect(surfaceKeys().listBySession("unknown-session")).toEqual([]);
    });
  });

  describe("collision handling", () => {
    test("handles key reassignment from one session to another", () => {
      const key = "slack:workspaceA:channel:C123";
      const sessionId1 = "session-1";
      const sessionId2 = "session-2";

      surfaceKeys().claim(key, sessionId1);
      expect(surfaceKeys().lookup(key)).toBe(sessionId1);
      expect(surfaceKeys().listBySession(sessionId1)).toContain(key);

      surfaceKeys().claim(key, sessionId2, sessionId1);
      expect(surfaceKeys().lookup(key)).toBe(sessionId2);
      expect(surfaceKeys().listBySession(sessionId1)).not.toContain(key);
      expect(surfaceKeys().listBySession(sessionId2)).toContain(key);
    });

    test("claim returns existing owner without overwriting it", () => {
      const key = "slack:workspaceA:channel:C123";
      surfaceKeys().claim(key, "session-1");

      const owner = surfaceKeys().claim(key, "session-2");

      expect(owner).toBe("session-1");
      expect(surfaceKeys().lookup(key)).toBe("session-1");
    });

    test("claim can replace an expected owner", () => {
      const key = "slack:workspaceA:channel:C123";
      surfaceKeys().claim(key, "session-1");

      const owner = surfaceKeys().claim(key, "session-2", "session-1");

      expect(owner).toBe("session-2");
      expect(surfaceKeys().lookup(key)).toBe("session-2");
    });
  });

  describe("codec-built keys route independently", () => {
    test("routes DM and group to different sessions", () => {
      const dmKey = Channel.SurfaceKey.fromChannel({
        surface: "slack",
        namespace: "ws1",
        kind: "dm",
        id: "U001",
      });
      const groupKey = Channel.SurfaceKey.fromChannel({
        surface: "slack",
        namespace: "ws1",
        kind: "group",
        id: "C001",
      });

      surfaceKeys().claim(dmKey, "session-dm");
      surfaceKeys().claim(groupKey, "session-group");

      expect(surfaceKeys().lookup(dmKey)).toBe("session-dm");
      expect(surfaceKeys().lookup(groupKey)).toBe("session-group");
    });

    test("routes thread separately from parent channel", () => {
      const channelKey = Channel.SurfaceKey.fromChannel({
        surface: "slack",
        namespace: "ws1",
        kind: "group",
        id: "C001",
      });
      const threadKey = Channel.SurfaceKey.fromChannel({
        surface: "slack",
        namespace: "ws1",
        kind: "group",
        id: "C001",
        threadId: "171000",
      });

      surfaceKeys().claim(channelKey, "session-channel");
      surfaceKeys().claim(threadKey, "session-thread");

      expect(surfaceKeys().lookup(channelKey)).toBe("session-channel");
      expect(surfaceKeys().lookup(threadKey)).toBe("session-thread");
    });

    test("existing keys without explicit kind still claim/lookup", () => {
      const legacyKey = "tui:/Users/ino/Develop/Oni";
      surfaceKeys().claim(legacyKey, "session-tui");
      expect(surfaceKeys().lookup(legacyKey)).toBe("session-tui");
    });
  });

  describe("fail-closed", () => {
    const key = "slack:workspaceA:channel:C123";
    const absentMessage = "does not implement surfaceKey";

    test("every operation throws when the surfaceKey sub-adapter is absent", () => {
      const bare = createSurfaceKeyStore({});
      expect(() => bare.claim(key, "session-1")).toThrow(absentMessage);
      expect(() => bare.lookup(key)).toThrow(absentMessage);
      expect(() => bare.listBySession("session-1")).toThrow(absentMessage);
    });

    test("claim never fabricates a successful claim without persistence", () => {
      // The pre-#522 fail-open returned the candidate sessionId as if the
      // claim had been persisted; ownership answers must never be fabricated.
      expect(() => createSurfaceKeyStore({}).claim(key, "candidate-session")).toThrow(
        absentMessage,
      );
    });
  });
});
