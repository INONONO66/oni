import { expect, test } from "bun:test";
import type { Machine } from "@oni/protocol";
import { phaseOf } from "../src/bundles/child-activity/contact/rule";
import { reconcile } from "../src/bundles/child-activity/reconcile";
import { spec } from "./helpers/child-activity";

const cursor = { ...spec.cursor, byteOffset: 96, recordHash: "b".repeat(64) };

test("every transcript record kind maps to its lifecycle phase; damaged records map to none", () => {
  const phases = (
    [
      { kind: "turn", role: "user", text: "go" },
      { kind: "turn", role: "assistant", text: "done" },
      { kind: "tool_call", callId: "c-1", name: "read", input: "{}" },
      { kind: "tool_result", callId: "c-1", output: "ok", failed: false },
      { kind: "corrupt", reason: "invalid_shape", excerpt: "{" },
      { kind: "truncated", originalBytes: 4096, prefix: "..." },
    ] satisfies Machine.AgentTranscriptRecord[]
  ).map(phaseOf);
  expect(phases).toEqual(["observed", "terminal", "requested", "result", undefined, undefined]);
});

test("a corrupt or truncated record admits one diagnostic row and the page's later records still land", () => {
  const rows = reconcile({
    machine: spec.machine, contact: spec.contact, child: spec.child, turn: spec.turn,
    records: [
      { kind: "corrupt", reason: "invalid_encoding", excerpt: "\uFFFD" },
      { kind: "truncated", originalBytes: 70_000, prefix: "long" },
      { kind: "turn", role: "assistant", text: "done" },
    ],
    cursor, previous: spec.cursor, observedAt: 7,
  }, []);
  const diagnostics = rows.filter((row) => row.kind === "child_diagnostic").map((row) => row.content.diagnostic);
  expect(diagnostics).toEqual([
    { code: "corrupt", detail: "invalid_encoding" },
    { code: "truncated", detail: "70000" },
  ]);
  expect(rows.map((row) => row.kind)).toEqual(["child_diagnostic", "child_diagnostic", "child_fact", "child_receipt"]);
  expect(rows.filter((row) => row.kind === "child_fact").map((row) => row.content.phase)).toEqual(["terminal"]);
});
