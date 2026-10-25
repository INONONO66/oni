import { expect, test } from "bun:test";
import { addBounded } from "../src/composition/bounded-set";

test("bounded Set evicts the oldest key without refreshing an existing key", () => {
  const keys = new Set<string>();
  addBounded(keys, "old", 2);
  addBounded(keys, "next", 2);
  addBounded(keys, "old", 2);
  expect([...keys]).toEqual(["old", "next"]);

  addBounded(keys, "new", 2);
  expect([...keys]).toEqual(["next", "new"]);
});
