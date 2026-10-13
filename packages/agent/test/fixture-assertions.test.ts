import { runAgentSync } from "./helpers/executor";
import { catalogLayer } from "./helpers/service-layers";
import { Effect } from "effect";
import { expect, it } from "bun:test";
import { expectFailedToolCommit, expectUncalledBudget } from "./helpers/execution-assertions";
import { recordingExecutor } from "./helpers/effect-g1";
import { timedQueryTool } from "./helpers/query-tool";
import { createDispatcher } from "../src/plugins/tool";
import { isolated } from "./helpers/isolated";

it("shared budget assertions reject wrong reasons and unexpected provider calls", () => {
  const stopped = Object.assign(new Error("stopped"), { code: "agent_stop", reason: "budget" });
  expectUncalledBudget(stopped, 0);
  // Each helper fails through one specific matcher; the failure names it.
  expect(() => expectUncalledBudget(stopped, 1)).toThrow(/^expect\(received\)\.toBe\(expected\)/);
  expect(() => expectUncalledBudget(Object.assign(new Error("other"), { code: "agent_stop", reason: "other" }), 0)).toThrow(/^expect\(received\)\.toMatchObject\(expected\)/);
});

it("shared tool assertions remain sensitive to result and durable commit mutations", () => isolated(Effect.gen(function* () {
  const recording = recordingExecutor();
  const dispatcher = runAgentSync(createDispatcher({ executor: recording.executor }).pipe(Effect.provide(catalogLayer([timedQueryTool("reject before timeout", async () => { throw new Error("failed"); })]))));
  const result = yield* dispatcher.execute({ id: "check", tool: "timed", input: {} }, { sessionId: "session-1", turnId: "turn-1" });
  expectFailedToolCommit(result, recording.committed);
  expect(() => expectFailedToolCommit({ ...result, isError: false }, recording.committed)).toThrow(/^expect\(received\)\.toMatchObject\(expected\)/);
  expect(() => expectFailedToolCommit(result, [])).toThrow(/^expect\(received\)\.toHaveLength\(expected\)/);
})));
