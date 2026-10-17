import { describe, expect, test } from "bun:test";
import { ChildLifecycleEvidence, TranscriptRef } from "../src/index.js";

const location = {
  machine: "machine-1",
  export: "home",
  path: "sessions/turn.jsonl",
  range: { offsetBytes: 12, lengthBytes: 48 },
  parser: { dialect: "dialect-1", version: "1" },
};
const hash = "a".repeat(64);

describe("TranscriptRef", () => {
  test("round trips both source generation variants", () => {
    for (const generation of [
      { kind: "size-and-prefix-hash", size: 60, prefixSha256: hash },
      { kind: "inode", device: "dev-1", inode: "node-1" },
    ]) {
      const value = { ...location, generation };
      const parsed = TranscriptRef.parse(value);
      expect(TranscriptRef.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    }
  });

  test("refuses invalid and extra source coordinates at the exact path", () => {
    const value = {
      ...location,
      generation: { kind: "size-and-prefix-hash", size: 60, prefixSha256: hash },
    };
    expect(TranscriptRef.safeParse(value).success).toBe(true);
    const refusals: [object, PropertyKey[]][] = [
      [{ ...value, generation: { ...value.generation, prefixSha256: "not-a-hash" } }, ["generation", "prefixSha256"]],
      [{ ...value, generation: { kind: "inode", device: "dev-1" } }, ["generation", "inode"]],
      [{ ...value, generation: { kind: "inode", device: "dev-1", inode: "1", extra: 1 } }, ["generation"]],
      [{ ...value, range: { offsetBytes: -1, lengthBytes: 48 } }, ["range", "offsetBytes"]],
      [{ ...value, range: { offsetBytes: 12.5, lengthBytes: 48 } }, ["range", "offsetBytes"]],
      [{ ...value, range: { ...value.range, extra: 1 } }, ["range"]],
      [{ ...value, parser: { ...value.parser, extra: 1 } }, ["parser"]],
      [{ ...value, extra: 1 }, []],
    ];
    for (const [invalid, path] of refusals) {
      expect(TranscriptRef.safeParse(invalid).error?.issues.map((issue) => issue.path)).toEqual([path]);
    }
  });
});

describe("ChildLifecycleEvidence", () => {
  test("round trips each phase with a remote reference", () => {
    const ref = {
      ...location,
      generation: { kind: "size-and-prefix-hash", size: 60, prefixSha256: hash },
    };
    for (const phase of ["observed", "requested", "waiting", "decided", "result", "terminal"]) {
      const value = {
        child: "child-1",
        turn: "turn-1",
        toolUseId: "call-1",
        phase,
        ref,
        diagnostics: [{ code: "parse-error", detail: "line 1" }],
      };
      const parsed = ChildLifecycleEvidence.parse(value);
      expect(ChildLifecycleEvidence.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    }
  });

  test("round trips a hook reference without an optional tool id", () => {
    const value = {
      child: "child-1",
      turn: "turn-1",
      phase: "terminal",
      ref: { kind: "hook", event: "stop", receivedAt: 1_700_000_000_000, seq: 0 },
      diagnostics: [],
    };
    const parsed = ChildLifecycleEvidence.parse(value);
    expect(ChildLifecycleEvidence.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  test("refuses invalid and extra evidence at the exact path", () => {
    const value = {
      child: "child-1",
      turn: "turn-1",
      phase: "requested",
      ref: { kind: "hook", event: "request", receivedAt: 1_700_000_000_000, seq: 1 },
      diagnostics: [{ code: "notice", detail: "detail" }],
    };
    expect(ChildLifecycleEvidence.safeParse(value).success).toBe(true);
    const refusals: [object, PropertyKey[]][] = [
      [{ ...value, phase: "finished" }, ["phase"]],
      [{ ...value, diagnostics: undefined }, ["diagnostics"]],
      [{ ...value, diagnostics: [{ code: "notice", detail: "detail", extra: 1 }] }, ["diagnostics", 0]],
      [{ ...value, ref: { ...value.ref, seq: -1 } }, ["ref", "seq"]],
      [{ ...value, ref: { ...value.ref, receivedAt: -1 } }, ["ref", "receivedAt"]],
      [{ ...value, ref: { ...value.ref, extra: 1 } }, ["ref"]],
      [{ ...value, extra: 1 }, []],
    ];
    for (const [invalid, path] of refusals) {
      expect(ChildLifecycleEvidence.safeParse(invalid).error?.issues.map((issue) => issue.path)).toEqual([path]);
    }
  });
});
