import { runAgentSync } from "../../helpers/executor";
import { catalogLayer } from "../../helpers/service-layers";
import { Effect, Fiber } from "effect";
import { boundedSignal } from "../../helpers/g0-signals";
import { isolated } from "../../helpers/isolated";
import { describe, expect, it } from "bun:test";
import { stringQueryTool } from "../../helpers/query-tool";
import type { ToolExecutionContext } from "@openomni/protocol";
import { z } from "zod";
import { defineTool, eraseTool } from "../../../src/core/loop/tool";
import { createDispatcher } from "../../../src/plugins/tool";
import { recordingExecutor } from "../../helpers/g0-effect";

describe("tool execution context", () => {
  it("forwards per-call cancellation with kernel-owned correlation identity", async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    let captured: ToolExecutionContext | undefined;
    const definition = defineTool({
      name: "capture",
      description: "Capture context",
      category: "query",
      input: z.object({}).strict(),
      output: z.string(),
      visibility: { model: ["resident"], cell: ["resident"] },
      execute: async (_input: Record<string, never>, context: ToolExecutionContext) => {
        captured = context;
        context.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        entered.resolve();
        await aborted.promise;
        return "ok";
      },
      render: (_input: Record<string, never>, output: string) => output,
    });
    const { executor } = recordingExecutor();
    const dispatcher = runAgentSync(createDispatcher({ executor }).pipe(Effect.provide(catalogLayer([eraseTool(definition)]))));

    await isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const running = yield* Effect.forkChild(
            dispatcher.execute(
              { id: "call-1", tool: "capture", input: {} },
              { sessionId: "session-call", turnId: "turn-1", signal: controller.signal },
            ),
          );
          yield* boundedSignal(entered.promise, "tool entered");
          controller.abort("caller cancelled");
          yield* Fiber.join(running);
        }),
      ),
    );

    expect(captured).toEqual({
      signal: controller.signal,
      sessionId: "session-call",
      turnId: "turn-1",
      callId: "call-1",
    });
    expect(captured?.signal?.aborted).toBe(true);
  });
  it("never enters a body when the caller already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const definition = stringQueryTool("capture", "Capture context", async () => {
      calls += 1;
      return "unexpected";
    });
    const { executor } = recordingExecutor();
    const result = await isolated(
      runAgentSync(createDispatcher({ executor }).pipe(Effect.provide(catalogLayer([eraseTool(definition)])))).execute(
        { id: "cancelled", tool: "capture", input: {} },
        { sessionId: "session-call", turnId: "turn", signal: controller.signal },
      ),
    );
    expect(result.isError).toBe(true);
    expect(calls).toBe(0);
  });
});
