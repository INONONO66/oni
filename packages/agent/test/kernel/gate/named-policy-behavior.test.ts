import { expect, test } from "bun:test";
import type { PlainValue } from "@oni/protocol";
import { compilePolicySnapshot } from "../../../src/core/gate/compile";
import { atGeneration, compaction, draft } from "./row-fixtures";

test("existing compiler executes the supplied captured named transform", () => {
  const options = {
    generation: 1,
    registry: {
      transformers: [
        { name: "demo/replace", apply: (_args: PlainValue, config: PlainValue) => config },
      ],
      obligations: [],
    },
    rows: [
      atGeneration(compaction, 1),
      atGeneration(
        draft("replace", "tool", "pre", {
          type: "transform",
          ref: "demo/replace",
          config: { fields: ["command"], command: "admitted" },
        }),
        1,
      ),
    ],
  };

  const result = compilePolicySnapshot(options).evaluate({
    kind: "tool",
    phase: "pre",
    op: "bash",
    value: { command: "original" },
  }).value;

  expect(result).toEqual({ command: "admitted" });
});
