import { composePointTable, GateComposeError } from "../src/core/gate/compile";
import { describe, expect, it } from "bun:test";
import { CORE_POINT_RECORDS } from "@oni/protocol";

describe("built-in seal (#1251)", () => {
  it("rejects a composition missing a sealed core point with typed `builtin_removed`", () => {
    for (const removed of ["turn.post", "ingress.pre"]) {
      try {
        composePointTable({
          capabilities: [],
          core: CORE_POINT_RECORDS.filter((record) => record.id !== removed),
        });
        throw new Error("expected builtin_removed");
      } catch (error) {
        if (!GateComposeError.isInstance(error)) throw error;
        expect(error.data).toEqual({ code: "builtin_removed", point: removed });
      }
    }
  });

  it("accepts the sealed core with no capabilities: the eight core points remain", () => {
    const table = composePointTable({ capabilities: [] });
    expect(table.size).toBe(8);
    expect([...table.values()].every((record) => record.owner === "core")).toBe(true);
  });
});
