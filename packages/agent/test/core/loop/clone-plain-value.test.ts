import { expect, test } from "bun:test";
import type { PlainValue } from "@oni/protocol";
import { clonePlainValue } from "../../../src/core/loop/record";

const vectors: readonly PlainValue[] = [
  null,
  true,
  "text",
  42,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  [1, Number.NEGATIVE_INFINITY, "x", [Number.NaN, null]],
  { output: "x".repeat(100_000), nested: { score: Number.POSITIVE_INFINITY, items: [0, -0.5, { deep: Number.NaN }] } },
];

test("clonePlainValue matches the JSON round trip it replaced on every vector", () => {
  for (const value of vectors) expect(clonePlainValue(value)).toEqual(JSON.parse(JSON.stringify(value)) as PlainValue);
});

test("clonePlainValue returns a detached copy", () => {
  const source: PlainValue = { list: [{ leaf: "kept" }] };
  const copy = clonePlainValue(source);
  expect(copy).toEqual(source);
  expect(copy).not.toBe(source);
  if (copy === null || typeof copy !== "object" || Array.isArray(copy)) throw new Error("object expected");
  expect(copy.list).not.toBe(source.list);
});
