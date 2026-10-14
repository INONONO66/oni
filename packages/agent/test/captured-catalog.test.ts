import type { ResolvedExecutorOptions } from "../src/core/loop/executor";
import { turnTestLayer, catalogLayer } from "./helpers/service-layers";
import { expect, test } from "bun:test";
import { z } from "zod";
import { Effect } from "effect";
import { recordingLedger } from "./helpers/effect-g3-recording";
import { createTurnDispatcher } from "../src/plugins/tool";
import { defineTool, projectTools } from "../src/core/loop/tool";
import { compiledPolicy } from "./helpers/compiled-policy";
import { isolated } from "./helpers/isolated";
import { TEST_APPROVAL_POLICY } from "./helpers/approval-policy";

function definition(input = z.object({ value: z.string() })) {
  return defineTool({
    name: "captured",
    category: "query",
    description: "captured",
    input,
    output: z.string(),
    visibility: { model: ["resident"], cell: [] },
    execute: async () => "done",
    render: (_input, value) => value,
  });
}

test("recovery refuses a missing or changed captured definition instead of executing latest code", () => isolated(Effect.gen(function* () {
  const original = definition();
  const record = recordingLedger();
  const input = {
    sessionId: "session",
    role: "resident" as const,
    actionId: "resume-action",
    turnId: "original-turn",
    toolsGeneration: 1,
    toolsHash: "captured-hash",
    policy: compiledPolicy(),
    ledger: record.ledger,
    tools: projectTools([original]).session,
  };
  for (const definitions of [[], [definition(z.object({ value: z.string().min(2) }))]]) {
    const refused = yield* Effect.flip(createTurnDispatcher(input, { approvalPolicy: TEST_APPROVAL_POLICY }).pipe(Effect.provide(catalogLayer(definitions))));
    expect(refused).toMatchObject({ _tag: "AgentFailure", operation: "dispatcher.acquire" });
  }
  expect(record.committed).toEqual([]);
})));

test("a recovered tool and its policy decisions remain children of the captured turn, not the resume checkpoint", () =>
  isolated(
    Effect.gen(function* () {
      const tool = definition();
      const record = recordingLedger();
      const dispatcher = (yield* Effect.gen(function* () { const turnInput: Parameters<typeof createTurnDispatcher>[0] & { readonly policy?: ResolvedExecutorOptions["policy"] } = {
          sessionId: "session",
          role: "resident",
          actionId: "resume-action",
          turnId: "original-turn",
          tools: projectTools([tool]).session,
          policy: compiledPolicy(),
          ledger: record.ledger,
        }; const turnRuntime: Parameters<typeof createTurnDispatcher>[1] & Partial<Pick<ResolvedExecutorOptions, "clock" | "entropy" | "observations">> = { approvalPolicy: TEST_APPROVAL_POLICY, observations: { publish: () => undefined }, entropy: record.entropy }; return yield* createTurnDispatcher(turnInput, turnRuntime).pipe(Effect.provide(catalogLayer([tool])), Effect.provide(turnTestLayer(turnInput, turnRuntime))); }));
      const result = yield* dispatcher.execute(
        { id: "call", tool: "captured", input: { value: "ok" } },
        { sessionId: "session", turnId: "original-turn" },
      );
      expect(result.isError).toBeUndefined();
      expect(
        record.committed
          .filter((action) => action.kind === "policy.decision")
          .map((action) => action.parentId),
      ).toEqual(["original-turn", "original-turn"]);
      expect(record.committed.find((action) => action.kind === "tool")?.parentId).toBe("original-turn");
    }),
  ));
