import { expect, test } from "bun:test";
import { Core } from "@oni/agent";
const ToolRefused = Core.ToolRefused;
import { createEvalTool } from "../src/bundles/tools/eval/index";

const CONTEXT = {
  sessionId: "eval-session",
  turnId: "eval-turn",
  callId: "eval-call",
  signal: new AbortController().signal,
};

/** A cell whose every operation rejects with the given failure. */
function failingCell(failure: Error): NonNullable<Parameters<typeof createEvalTool>[0]> {
  const reject = () => Promise.reject(failure);
  return { run: reject, peek: reject, stop: reject };
}

test("eval propagates a cell failure that is not a spent cell id unchanged", async () => {
  const failure = new Error("interpreter crashed");
  const tool = createEvalTool(failingCell(failure));
  const run = { op: "run" as const, code: "1 + 1", timeout: 1 };
  await expect(tool.execute({ operation: run }, CONTEXT)).rejects.toBe(failure);
  await expect(
    tool.execute({ operation: { op: "peek", cell_id: "cell-1" } }, CONTEXT),
  ).rejects.toBe(failure);
});

test("eval refuses before any cell operation when codemode is not composed", () => {
  const tool = createEvalTool(undefined);
  expect(() => tool.execute({ operation: { op: "stop", cell_id: "cell-1" } }, CONTEXT)).toThrow(
    ToolRefused,
  );
});
