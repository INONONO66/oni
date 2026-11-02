import { expect, test } from "bun:test";
import type { Machine } from "@oni/protocol";
import { type ChildRow, contactCursor } from "../src/bundles/child-activity/reconcile";
import { childSource, type ChildSourcePorts } from "../src/composition/watch-sources";
import { spec } from "./helpers/child-activity";

test("agent transcript pages admit child facts and restore the server cursor", async () => {
  const rows: ChildRow[] = [];
  const last = { ...spec.cursor, byteOffset: 64, recordHash: "c".repeat(64) };
  const pages: Machine.AgentSessionTailResult[] = [
    { status: "ok", records: [{ kind: "turn", role: "user", text: "hello" }], cursor: { ...spec.cursor, byteOffset: 32, recordHash: "b".repeat(64) }, hasMore: true },
    { status: "ok", records: [{ kind: "turn", role: "assistant", text: "done" }], cursor: last, hasMore: false },
  ];
  const reads: number[] = [];
  const ports: ChildSourcePorts = {
    machines: {
      get: () => ({
        agentSession: {
          tail: async (input) => {
            if (!("cursor" in input)) throw new Error("expected server cursor");
            reads.push(input.cursor.byteOffset);
            return pages.shift() ?? { status: "ok", records: [], cursor: input.cursor, hasMore: false };
          },
        },
      }),
    },
    rows: () => rows,
    admit: async (_sessionId, added) => {
      rows.push(...added);
      return added;
    },
  };
  const failures: Error[] = [];
  const source = childSource(spec, ports, { clock: () => 100, failure: (error) => failures.push(error) });
  await source.ready;
  expect(reads).toEqual([0, 32]);
  expect(rows.filter((row) => row.kind === "child_fact").map((row) => row.content.phase)).toEqual(["observed", "terminal"]);
  expect(rows.filter((row) => row.kind === "child_receipt")).toHaveLength(2);
  expect(contactCursor(rows, spec.contact)).toEqual(last);
  await source.close();
  const restored = childSource(spec, ports, { clock: () => 101, failure: (error) => failures.push(error) });
  await restored.ready;
  expect(reads).toEqual([0, 32, 64]);
  expect(rows.filter((row) => row.kind === "child_fact")).toHaveLength(2);
  expect(failures).toEqual([]);
  await restored.close();
});
