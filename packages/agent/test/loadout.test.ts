import { expect, test } from "bun:test";
import { filterLoadout } from "../src/core/gate/bind";

const definitions = [
  { name: "shared", visibility: { model: ["resident", "child"], cell: [] } },
  { name: "resident", visibility: { model: ["resident"], cell: [] } },
  { name: "cell", visibility: { model: [], cell: ["child"] } },
  { name: "unoffered", visibility: { model: ["child"], cell: [] } },
] as const;
const offered = new Set(["shared", "resident", "cell"]);

test("loadout intersects offered names lineage visibility and an optional allowlist", () => {
  expect(filterLoadout(definitions, offered, "child").map((tool) => tool.name)).toEqual(["shared", "cell"]);
  expect(filterLoadout(definitions, offered, "child", new Set(["shared", "resident", "unoffered"])))
    .toEqual([definitions[0]]);
  expect(filterLoadout(definitions, offered, "child", new Set())).toEqual([]);
});
