import { messageSource } from "../../helpers/message-source";
import { runAgentSync } from "../../helpers/executor";
import type { ChatFixture as ChatAgentConfig } from "../../helpers/chat-services";
import { catalogLayer } from "../../helpers/service-layers";
import { Effect } from "effect";
import { isolated } from "../../helpers/isolated";
import { createTestAgent } from "../../helpers/effect-g1";
import { beforeEach, describe, expect, it } from "bun:test";
import type { Tool } from "@oni/protocol";
import { defineTool } from "../../../src/core/loop/tool";
import { createDispatcher } from "../../../src/plugins/tool";
import { Bus } from "../../helpers/bus";
import { recordingExecutor } from "../../helpers/effect-g1";
import { compiledPolicy } from "../../helpers/compiled-policy";
import { z } from "zod";
import { createAssistantMessage } from "../../../src/core/journal/message-factory";
import type {} from "../../../src/core/ports/types";

// Catalog metadata does not bypass the executor's compiled policy.
const tools: Tool.Spec[] = [
  {
    name: "screen.capture",
    inputSchema: { type: "object" },
  },
  { name: "network.fetch", inputSchema: { type: "object" } },
];

describe("tool calls reach the executor without target gating", () => {
  beforeEach(() => Bus.reset());
  for (const wave of [false, true]) {
    it(`preserves the catalog and executor refusal at the ${wave ? "wave" : "single"} door`, async () => {
      const catalogs: string[][] = [];
      const executed: string[] = [];
      const results: Tool.Result[] = [];
      let requested = false;
      const recording = recordingExecutor({
        policy: compiledPolicy([
          {
            name: "refuse-screen",
            kind: "tool",
            phase: "pre",
            priority: 1,
            generation: 1,
            match: { encodingVersion: 1, value: { op: "screen.capture" } },
            verdict: { encodingVersion: 1, value: { type: "deny", reason: "policy_denied" } },
          },
        ]),
      });
      const dispatcher = runAgentSync(createDispatcher({ executor: recording.executor }).pipe(Effect.provide(catalogLayer([
          defineTool({
            name: "screen.capture",
            description: "Capture screen",
            category: "query",
            input: z.object({}),
            output: z.string(),
            visibility: { model: ["resident"], cell: [] },
            execute: async () => {
              executed.push("screen.capture");
              return "image";
            },
            render: (_input, output) => output,
          }),
        ]))));
      const context = { sessionId: "session-tools", turnId: "turn-tools" };
      const execute = (call: Tool.Call) => dispatcher.execute(call, context);
      const config: ChatAgentConfig = {
        events: Bus,
        model: { provider: "test", id: "model" },
        tools,
        toolExecutor: execute,
        ...(wave
          ? { toolWave: (calls: readonly Tool.Call[]) => dispatcher.executeWave(calls, context) }
          : {}),
        llm: {
          resolveModel: () => Effect.succeed({ id: "model", name: "model", providerID: "test" }),
          run: (input, sink) => Effect.sync(() => {
            catalogs.push(input.tools.map((tool) => tool.name));
            const message = createAssistantMessage("completed", "", "session-tools", messageSource);
            if (!requested) {
              requested = true;
              message.parts.push({
                id: "part",
                messageID: message.info.id,
                sessionID: "session-tools",
                type: "tool",
                callID: "call",
                tool: "screen.capture",
                state: { status: "pending", input: {} },
              });
            }
            sink.onMessage(message);
            return { type: "stop" as const };
          }),
        },
      };
      await isolated(createTestAgent(config).run(
        {
          messages: [{ role: "user", content: [{ kind: "text", text: "inspect" }] }],
          traceContext: { traceId: "trace-tools", sessionId: "session-tools", runId: "run-tools" },
        },
        {
          onMessage: () => undefined,
          onToolCall: () => undefined,
          onToolResult: (result) => results.push(result),
        },
      ));
      expect(catalogs.length).toBeGreaterThan(0);
      expect(
        catalogs.every((catalog) => catalog.join(",") === "screen.capture,network.fetch"),
      ).toBe(true);
      expect(executed).toEqual([]);
      expect(results).toMatchObject([
        { toolCallId: "call", isError: true, errorKind: "precondition_failed" },
      ]);
      expect(
        recording.committed
          .filter((action) => action.kind === "policy.decision")
          .map((action) => action.intent.value),
      ).toContainEqual(
        expect.objectContaining({
          hook: "tool.pre",
          op: "screen.capture",
          verdict: "deny",
          matchedRuleIds: ["refuse-screen"],
        }),
      );
    });
  }
});
