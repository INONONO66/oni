import { testToolPorts } from "./helpers/tool-ports";
import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { Effect } from "effect";
import { expect, test } from "bun:test";
import type { Core } from "@openomni/agent";
type RunInput = Core.RunInput;
type Sink = Core.LlmSink;
import { Tool, type BusEvent, type ObservationSink, type PlainValue } from "@openomni/protocol";
import { residentRunner as createResident } from "./helpers/resident-runner";
import { requestToolStep, assistantMessage } from "./helpers/assistant-message";
import { allowConfigure } from "./helpers/generation-services";

function field(value: PlainValue, name: string): PlainValue | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value[name];
}

test("a resident tool call is executed and observed through the durable executor", async () => {
  const eventNames: string[] = [];
  const observations: ObservationSink = {
    publish<T>(event: BusEvent.Descriptor<T>) {
      eventNames.push(event.name);
    },
  };
  const sessionId = "resident-tool-wiring";
  let bodyRuns = 0;
  const resident = createResident({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    tools: { ...testToolPorts,
      cells: {
        cell: {
          async run() {
            bodyRuns += 1;
            return {
              status: "completed",
              cellId: "cell-1",
              value: "ok",
              output: { stdout: "ok", stderr: "" },
            };
          },
          peek: () => Promise.reject(new Error("not a background cell")),
          stop: () => Promise.reject(new Error("not a background cell")),
        },
      },
    },
    sessionRuntime: {
      authorizeConfigure: allowConfigure,
      observations,
      clock: () => 10,
      entropy: (() => {
        let id = 0;
        return () => `runtime-${++id}`;
      })(),
    },
    llm: {
      resolveModel: (model) => Effect.succeed({
        id: model.id,
        name: model.id,
        providerID: model.provider,
      }),
      run: (input: RunInput, sink: Sink) => Effect.sync(() => {
        const result = requestToolStep(input, sink, {
          id: "call-1",
          tool: "eval",
          input: { operation: { op: "run", code: "1", timeout: 1 } },
        });
        if (result === undefined) return { type: "stop" };
        sink.onMessage(assistantMessage(input, { text: String(result?.content ?? "missing") }));
        return { type: "stop" as const };
      }),
    },
  });

  await resident.prompt(sessionId, "please answer");

  const tree = sessionTree(sessionId, resident.plane.sessionStore(sessionId).actions);
  const prompt = tree.find((action) => action.kind === "prompt");
  const turn = tree.find((action) => action.kind === "turn" && action.id !== tree.at(-1)?.id);
  const toolIntent = tree.find(
    (action) => action.kind === "tool" && field(action.intent.value, "phase") === "intent",
  );
  const toolResult = tree.find(
    (action) => action.kind === "tool" && field(action.effect.value, "phase") === "result",
  );
  const decisions = tree.filter((action) => action.kind === "policy.decision");

  expect(bodyRuns).toBe(1);
  expect(turn).toBeDefined();
  expect(toolIntent?.parentId).toBe(turn?.id);
  expect(toolResult?.parentId).toBe(toolIntent?.id);
  const core = decisions.filter(
    (action) =>
      ["chat", "session", "eval"].includes(String(field(action.intent.value, "op"))) ||
      String(field(action.intent.value, "hook")).startsWith("prompt."),
  );
  expect(core.map((action) => field(action.intent.value, "hook")).sort()).toEqual([
    "llm.post",
    "llm.post",
    "llm.pre",
    "llm.pre",
        "prompt.pre",
    "tool.post",
    "tool.pre",
    "turn.post",
    "turn.pre",
  ]);
  expect(
    decisions
      .filter((action) => String(field(action.intent.value, "hook")).startsWith("prompt."))
      .every((action) => action.parentId === prompt?.id),
  ).toBe(true);
  expect(
    decisions
      .filter((action) => !String(field(action.intent.value, "hook")).startsWith("prompt."))
      .every(
        (action) =>
          action.parentId === turn?.id ||
          tree.some((parent) => parent.id === action.parentId && parent.kind === "llm"),
      ),
  ).toBe(true);
  expect(eventNames.filter((name) => name === Tool.Events.Started.name)).toHaveLength(1);
  expect(eventNames.filter((name) => name === Tool.Events.Completed.name)).toHaveLength(1);
});
