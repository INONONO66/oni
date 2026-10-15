import { expect, test } from "bun:test";
import { Machine } from "../../src";

test.each([
  { machineId: "worker", slots: 2 },
  { tag: "future", memReserveBytes: 0 },
  { tag: "batch", classCosts: { exec: 1, eval: 1, pty: 1, job: 2.5 } },
])("capacity accepts a bounded row %j", (row) => {
  expect(Machine.CapacityRow.parse(row)).toEqual(row);
});

test.each([
  {}, { machineId: "" }, { tag: "" }, { machineId: "w", tag: "both" },
  { tag: "w", slots: 0 }, { tag: "w", slots: 1.5 },
  { tag: "w", memReserveBytes: -1 }, { tag: "w", memReserveBytes: 0.5 },
  { tag: "w", classCosts: { exec: 2, eval: 1, pty: 1, job: 1 } },
  { tag: "w", classCosts: { exec: 1, eval: 1, pty: 1, job: 0 } },
  { tag: "w", classCosts: { exec: 1, eval: 1, pty: 1, job: Number.POSITIVE_INFINITY } },
  { tag: "w", unexpected: true },
])("capacity rejects an invalid row %j", (row) => {
  expect(Machine.CapacityRow.safeParse(row).success).toBe(false);
});

test("capacity row sets reject duplicate selectors but allow a later enrollment", () => {
  expect(Machine.CapacityRows.safeParse([{ machineId: "w" }, { machineId: "w" }]).success).toBe(false);
  expect(Machine.CapacityRows.safeParse([{ tag: "w" }, { tag: "w" }]).success).toBe(false);
  expect(Machine.CapacityRows.parse([{ machineId: "w" }, { tag: "w" }])).toHaveLength(2);
});
