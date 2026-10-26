import { describe, expect, test } from "bun:test";
import { type Checkpoint, commitCheckpoint, replayCheckpoints, type SyncChange, syncPath } from "@oni/sync";
import { code } from "./sync-error.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function history(projectId: string, sets: readonly (readonly SyncChange[])[]): Checkpoint[] {
  const out: Checkpoint[] = [];
  let head: ReturnType<typeof commitCheckpoint> | undefined;
  for (const changes of sets) {
    head = commitCheckpoint(projectId, head, changes);
    out.push(head.checkpoint);
  }
  return out;
}

describe("syncPath", () => {
  test("accepts canonical relative keys", () => {
    expect(syncPath("src/a.ts")).toBe("src/a.ts");
  });

  test.each(["", "/etc/passwd", "../up", "a/../../b", "a/./b", "a//b", "a/", "a\\b", "a\0b", "x".repeat(4097)])(
    "rejects %p",
    (raw) => {
      expect(code(() => syncPath(raw))).toBe("path_rejected");
    },
  );
});

describe("checkpoints", () => {
  const sets: SyncChange[][] = [
    [
      { path: "src/b.ts", digest: DIGEST_B, size: 2 },
      { path: "src/a.ts", digest: DIGEST_A, size: 1 },
    ],
    [{ path: "src/a.ts", removed: true }],
  ];

  test("replay rebuilds the manifest and verifies the chain", () => {
    const recorded = history("project-1", sets);
    expect(recorded.map((cp) => cp.sequence)).toEqual([1, 2]);
    expect(recorded[1]?.parent).toBe(recorded[0]?.id ?? "");
    expect(recorded[0]?.changes.map((change) => change.path)).toEqual(["src/a.ts", "src/b.ts"]);
    const state = replayCheckpoints("project-1", recorded);
    expect(state.checkpoint.id).toBe(recorded[1]?.id ?? "");
    expect([...state.manifest]).toEqual([["src/b.ts", { digest: DIGEST_B, size: 2 }]]);
  });

  test("identity is per project and order-insensitive within a change set", () => {
    const one = commitCheckpoint("project-1", undefined, sets[0] ?? []);
    const reordered = commitCheckpoint("project-1", undefined, [...(sets[0] ?? [])].reverse());
    const other = commitCheckpoint("project-2", undefined, sets[0] ?? []);
    expect(reordered.checkpoint.id).toBe(one.checkpoint.id);
    expect(other.checkpoint.id).not.toBe(one.checkpoint.id);
  });

  test("replay refuses a tampered, reordered, foreign or empty history", () => {
    const recorded = history("project-1", sets);
    const [first, second] = recorded;
    if (first === undefined || second === undefined) throw new Error("history");
    expect(code(() => replayCheckpoints("project-1", []))).toBe("checkpoint_broken");
    expect(code(() => replayCheckpoints("project-1", [second, first]))).toBe("checkpoint_broken");
    expect(code(() => replayCheckpoints("project-2", recorded))).toBe("checkpoint_broken");
    expect(code(() => replayCheckpoints("project-1", [{ ...first, id: DIGEST_A }]))).toBe("checkpoint_broken");
    expect(code(() => replayCheckpoints("project-1", [{ ...first, sequence: 7 }]))).toBe("checkpoint_broken");
    const tampered = { ...first, changes: [{ path: "src/a.ts", digest: DIGEST_B, size: 1 }] };
    expect(code(() => replayCheckpoints("project-1", [tampered]))).toBe("checkpoint_broken");
  });

  test("commit refuses malformed change sets", () => {
    const head = commitCheckpoint("project-1", undefined, sets[0] ?? []);
    expect(code(() => commitCheckpoint("", undefined, []))).toBe("invalid_change");
    expect(code(() => commitCheckpoint("project-2", head, []))).toBe("checkpoint_broken");
    expect(code(() => commitCheckpoint("project-1", head, [{ path: "gone.ts", removed: true }]))).toBe("invalid_change");
    expect(code(() => commitCheckpoint("project-1", head, [{ path: "x", digest: "md5:1", size: 1 }]))).toBe("invalid_change");
    expect(code(() => commitCheckpoint("project-1", head, [{ path: "x", digest: DIGEST_A, size: -1 }]))).toBe("invalid_change");
    expect(code(() => commitCheckpoint("project-1", head, [{ path: "../x", digest: DIGEST_A, size: 1 }]))).toBe("path_rejected");
    const twice: SyncChange[] = [
      { path: "x", digest: DIGEST_A, size: 1 },
      { path: "x", removed: true },
    ];
    expect(code(() => commitCheckpoint("project-1", head, twice))).toBe("invalid_change");
  });
});
