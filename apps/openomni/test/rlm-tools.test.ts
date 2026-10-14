import { testToolPorts } from "./helpers/tool-ports";
import { dispatcherFixture } from "./helpers/dispatcher-fixture";
import { Effect } from "effect";
import { runEffect } from "./helpers/effect";
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { catalogDefinitions } from "../src/composition/catalog";
import { Core } from "@openomni/agent";
import { Auth, makeLlmService, ModelsDev } from "@openomni/llm";
/** The lint's full spec surface (#1255 S3): widen the cell-only door for projection alone. */
const toolSpec = (tool: import("@openomni/protocol").AnyToolDefinition) => {
  const widened = tool.visibility.model.length > 0
    ? tool
    : { ...tool, visibility: { ...tool.visibility, model: ["resident" as const] } };
  const spec = Core.projectTools([widened]).specs[0];
  if (spec === undefined) throw new Error(`no spec projected for ${tool.name}`);
  return spec;
};
type Executor = Core.Executor;
import { completionFixture as completionPort } from "./helpers/completion-fixture";
type RunInput = Core.RunInput;

import { assistantMessage } from "./helpers/assistant-message";
import { providerFailure } from "./helpers/provider-failure";
import { executor } from "./helpers/executor";
import { dispatchModelTool, modelToolOutput } from "./helpers/tool-dispatch";

const ABSENT_AUTH_FILE = "/nonexistent/openomni-rlm-tools/auth.json";

afterEach(() => mock.restore());

/** The sealed cell-only tool name and its per-cell call budget (KERNEL §3.4). */
const COMPLETION_TOOL_NAME = "completion";
const MAX_COMPLETION_CALLS = 32;

import { admittedEffect } from "./helpers/admitted-effect";
import { executor as productionExecutor } from "./helpers/executor";

function completionFixture(...args: Parameters<typeof completionPort>) {
  const port = completionPort(...args);
  return (call: string | Parameters<typeof port>[0]) =>
    admittedEffect(port(typeof call === "string" ? { prompt: call } : call));
}

/** The production executor with the llm/text operation's result scripted; tool operations stay real. */
function scriptedLlmExecutor(result: Effect.Success<ReturnType<Executor["run"]>>): Executor {
  return {
    ...productionExecutor,
    run: (request, body) =>
      request.kind === "llm" ? Effect.succeed(result) : productionExecutor.run(request, body),
  };
}

const RESIDENT = { role: "resident", sessionId: "session-origin" } as const;

describe("the completion tool", () => {
  it("returns the port's answer", async () => {
    const run = modelToolOutput(
      COMPLETION_TOOL_NAME,
      { llm: async (call) => `answered: ${call.prompt}` },
      RESIDENT,
    );
    expect(await run({ prompt: "summarize this" })).toBe("answered: summarize this");
  });

  it("classifies a malformed call as invalid input without touching the port", async () => {
    let invoked = 0;
    const run = dispatchModelTool(
      COMPLETION_TOOL_NAME,
      {
        llm: async () => {
          invoked += 1;
          return "x";
        },
      },
      RESIDENT,
    );
    expect(await run({ prompt: "" })).toMatchObject({
      isError: true,
      errorKind: "invalid_input",
    });
    expect(await run({ prompt: "ok", extra: true })).toMatchObject({
      isError: true,
      errorKind: "invalid_input",
    });
    expect(invoked).toBe(0);
  });

  it("forwards system and model to the port and validates a schema-shaped answer", async () => {
    const seen: Array<Parameters<NonNullable<Parameters<typeof catalogDefinitions>[0]["llm"]>>[0]> = [];
    const answers = ['```json\n{"n": 7}\n```', '{"n": "seven"}', "not json at all"];
    const run = dispatchModelTool(
      COMPLETION_TOOL_NAME,
      {
        llm: async (call) => {
          seen.push(call);
          return answers[seen.length - 1] ?? "";
        },
      },
      RESIDENT,
    );
    const schema = {
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
      additionalProperties: false,
    };
    // The fenced answer is unwrapped, validated, and returned as canonical JSON text.
    expect(await run({ prompt: "count", system: "terse", model: "mini", schema })).toMatchObject({
      content: '{"n":7}',
    });
    expect(seen[0]).toMatchObject({ prompt: "count", model: "mini" });
    expect(seen[0]?.system).toStartWith("terse\n\n");
    expect(seen[0]?.system).toContain(JSON.stringify(schema));
    for (const message of ["does not satisfy the schema", "is not JSON"]) {
      const result = await run({ prompt: "count", schema });
      expect(result).toMatchObject({ isError: true, errorKind: "precondition_failed" });
      expect(result.content).toContain(message);
    }
    expect(seen).toHaveLength(3);
    // Without a schema nothing is added to the system text and nothing is parsed.
    expect(await run({ prompt: "free" })).toMatchObject({ content: "" });
    expect(seen[3]).toEqual({ prompt: "free" });
    // Options are typed: an unsupported option is invalid input, never forwarded.
    expect(await run({ prompt: "x", temperature: 1 })).toMatchObject({
      isError: true,
      errorKind: "invalid_input",
    });
    expect(seen).toHaveLength(4);
  });

  it(`serves ${MAX_COMPLETION_CALLS} calls per cell, then refuses that cell without invoking the port`, async () => {
    // The defect this pins: the budget counter lived in the tool closure, and
    // the catalog is cached per ports object, so every cell of every session
    // drew from ONE process-wide budget. The cell door dispatches with
    // turnId = cellId; the budget must be keyed by that identity.
    let invoked = 0;
    const entries = catalogDefinitions(
      { ...testToolPorts,
        llm: async () => {
          invoked += 1;
          return `call ${invoked}`;
        },
      },
    );
    const dispatcher = dispatcherFixture(entries, { executor });
    let nextId = 0;
    const run = (cellId: string, prompt: string) =>
      runEffect(
        dispatcher.executeCell(
          { id: `cell:${cellId}:${++nextId}`, tool: COMPLETION_TOOL_NAME, input: { prompt } },
          { sessionId: RESIDENT.sessionId, turnId: cellId },
        ),
      );
    const refusal = {
      isError: true,
      errorKind: "precondition_failed",
      content: `completion refused: the per-cell budget of ${MAX_COMPLETION_CALLS} sub-model calls is spent`,
    };

    for (let i = 1; i <= MAX_COMPLETION_CALLS; i++) {
      const result = await run("cell-a", `q${i}`);
      expect(result.structuredContent).toBe(`call ${i}`);
      expect(result.isError).toBeUndefined();
    }
    expect(await run("cell-a", "one too many")).toMatchObject(refusal);
    expect(invoked).toBe(MAX_COMPLETION_CALLS);

    // A second cell on the same catalog starts with its own full budget.
    for (let i = 1; i <= MAX_COMPLETION_CALLS; i++) {
      const result = await run("cell-b", `q${i}`);
      expect(result.isError).toBeUndefined();
    }
    expect(await run("cell-b", "one too many")).toMatchObject(refusal);
    // The first cell's refusal is durable: its budget does not refill.
    expect(await run("cell-a", "still spent")).toMatchObject(refusal);
    expect(invoked).toBe(2 * MAX_COMPLETION_CALLS);
  });

  it("surfaces a failure as an error RESULT through the dispatcher, never as data", async () => {
    // The defect this pins: a failing llm call returned as a completed string
    // lets cell code store failure text as if it were model output. The
    // dispatcher must mark it isError so the cell door raises ToolError.
    const entries = catalogDefinitions(
      { ...testToolPorts,
        llm: async () => {
          throw new Error("llm failed: provider on fire");
        },
      },
    );
    const dispatcher = dispatcherFixture(entries, { executor });

    const result = await runEffect(
      dispatcher.execute(
        { id: "1", tool: COMPLETION_TOOL_NAME, input: { prompt: "hi" } },
        { sessionId: "rlm-session", turnId: "rlm-turn" },
      ),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("Error: llm failed: provider on fire");
  });

  it("refuses an unlisted model instead of guessing an SDK for it", async () => {
    // The defect this pins: a bare fallback model dropped the provider's npm
    // wiring, and the LLM package then routed an anthropic credential to the
    // OpenAI SDK. Unlisted must be a per-call error.
    const catalog = {
      anthropic: {
        id: "anthropic",
        name: "Anthropic",
        api: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
        env: [],
        models: {
          listed: { id: "listed", name: "Listed" },
        },
      },
    };
    spyOn(ModelsDev, "get").mockReturnValue(Effect.succeed(catalog));
    spyOn(Auth, "get").mockReturnValue(Effect.succeed(undefined));
    const resolveModel = makeLlmService(ABSENT_AUTH_FILE).resolveModel;
    const run = mock(() => Effect.succeed({ type: "stop" as const }));
    expect(
      await runEffect(resolveModel({ provider: "anthropic", id: "listed" }, () => 0)),
    ).toMatchObject({
      id: "listed",
      providerID: "anthropic",
      api: { npm: "@ai-sdk/anthropic" },
    });
    for (const [provider, id] of [
      ["anthropic", "claude-unlisted"],
      ["nowhere", "listed"],
    ] as const) {
      await expect(
        completionFixture({ provider, id, apiKey: "key" }, { run })("hello"),
      ).rejects.toMatchObject({
        _tag: "AgentFailure",
        operation: "completion.resolve",
        cause: String(await runEffect(Effect.flip(resolveModel({ provider, id }, () => 0)))),
      });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("dispatches the cell door without a target eligibility fold", async () => {
    const entries = catalogDefinitions({ ...testToolPorts, llm: async () => "ok" });
    const dispatcher = dispatcherFixture(entries, { executor });
    const result = await runEffect(
      dispatcher.executeCell(
        { id: "1", tool: COMPLETION_TOOL_NAME, input: { prompt: "hi" } },
        { sessionId: "rlm-session", turnId: "rlm-turn" },
      ),
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual("ok");
  });
});

describe("the completion port", () => {
  const MODEL = { provider: "fake", id: "port-test", apiKey: "port-key" } as const;
  const resolveModel = (model: { provider: string; id: string }) =>
    Effect.succeed({
      id: model.id,
      name: model.id,
      providerID: model.provider,
    });

  /** A completion port whose run records its input and answers with the given text. */
  function recordingPort(text: string) {
    const inputs: RunInput[] = [];
    const port = completionFixture(MODEL, {
      resolveModel,
      run: (input, sink) =>
        Effect.sync(() => {
          inputs.push(input);
          sink.onMessage(assistantMessage(input, { id: "sub-reply", text }));
          return { type: "stop" as const };
        }),
    });
    const input = (): RunInput => {
      const [first] = inputs;
      if (first === undefined) throw new Error("the port never ran");
      return first;
    };
    return { port, input };
  }

  it("runs one toolless step under its own trace and returns the assistant text", async () => {
    const { port, input } = recordingPort("the answer");
    expect(await port("summarize")).toBe("the answer");
    const seen = input();
    expect(seen.tools).toEqual([]);
    expect(seen.toolChoice).toBe("none");
    expect(seen.auth).toEqual({ type: "api", key: "port-key" });
    expect(seen.model).toMatchObject({ id: "port-test", providerID: "fake" });
    // A nested run must never borrow the turn's identity: the trace is its own.
    expect(seen.trace.sessionId).toBe("completion");
    expect(seen.messages[0]?.parts[0]).toMatchObject({ type: "text", text: "summarize" });
  });

  it("carries a system text and a model id override on the configured provider", async () => {
    const { port, input } = recordingPort("shaped");
    expect(await port({ prompt: "shape it", system: "answer as JSON", model: "port-mini" })).toBe(
      "shaped",
    );
    const seen = input();
    expect(seen.system).toBe("answer as JSON");
    expect(seen.model).toMatchObject({ id: "port-mini", providerID: "fake" });
    // The override never changes whose credential is used.
    expect(seen.auth).toEqual({ type: "api", key: "port-key" });
    expect(seen.messages[0]?.info).toMatchObject({
      role: "user",
      model: { providerID: "fake", modelID: "port-mini" },
    });
  });

  it("ignores non-assistant messages when reading the answer", async () => {
    const port = completionFixture(MODEL, {
      resolveModel,
      run: (input, sink) =>
        Effect.sync(() => {
          const echo = input.messages[0];
          if (echo !== undefined) sink.onMessage(echo);
          // The port discards tool activity too: a one-step toolless run has no
          // executor, so these projections must be inert.
          sink.onToolCall({ id: "call-1", tool: "noop", input: {} });
          sink.onToolResult({ id: "result-1", toolCallId: "call-1", output: "ignored" });
          return { type: "stop" as const };
        }),
    });

    expect(await port("anything")).toBe("");
  });

  it("throws the provider's failure instead of returning it as data", async () => {
    const port = completionFixture(MODEL, {
      resolveModel,
      run: () =>
        Effect.succeed({ type: "error" as const, error: providerFailure("provider on fire") }),
    });

    await expect(port("q")).rejects.toThrow("provider on fire");
  });

  it("names the outcome when a non-stop run carries no error", async () => {
    const port = completionFixture(MODEL, {
      resolveModel,
      run: () => Effect.succeed({ type: "aborted" as const }),
    });

    await expect(port("q")).rejects.toMatchObject({ _tag: "Interrupted" });
  });

  it("rejects a run that asks to continue: a one-step toolless call has nothing to continue", async () => {
    const port = completionFixture(MODEL, {
      resolveModel,
      run: () => Effect.succeed({ type: "continue" as const }),
    });

    await expect(port("q")).rejects.toMatchObject({
      _tag: "AgentFailure",
      operation: "completion",
      cause: "sub-model returned continue",
    });
  });

  it("refuses without the session's attempt authority instead of running unrecorded", async () => {
    let invoked = 0;
    const port = completionPort(MODEL, {
      resolveModel,
      run: () =>
        Effect.sync(() => {
          invoked += 1;
          return { type: "stop" as const };
        }),
    });
    const withoutAttempts: Executor = {
      run: (request, body) => productionExecutor.run(request, body),
    };

    await expect(admittedEffect(port({ prompt: "q" }), withoutAttempts)).rejects.toMatchObject({
      _tag: "AgentFailure",
      operation: "completion",
    });
    expect(invoked).toBe(0);
  });

  it("surfaces a refused llm operation as the refusal's reason", async () => {
    const port = completionPort(MODEL, {
      resolveModel,
      run: () => Effect.succeed({ type: "stop" as const }),
    });
    const refused = scriptedLlmExecutor({ terminal: "blocked_pre", reason: "llm.text denied" });

    await expect(admittedEffect(port({ prompt: "q" }), refused)).rejects.toMatchObject({
      _tag: "AgentFailure",
      operation: "completion",
    });
  });

  it("rejects an executed value that is not the text record the run produces", async () => {
    const port = completionPort(MODEL, {
      resolveModel,
      run: () => Effect.succeed({ type: "stop" as const }),
    });

    for (const value of ["bare text", { answer: "no text field" }] as const) {
      const executed = scriptedLlmExecutor({ terminal: "executed", value });
      await expect(admittedEffect(port({ prompt: "q" }), executed)).rejects.toMatchObject({
        _tag: "AgentFailure",
        operation: "completion",
        cause: "invalid sub-model result",
      });
    }
  });
});

describe("catalog gating for the rlm tools", () => {
  it("lists the completion spec in the shippable surface the lint reads", () => {
    const names = catalogDefinitions(testToolPorts).map(toolSpec).map((spec) => spec.name);
    expect(names).toContain(COMPLETION_TOOL_NAME);
  });

  it("stays in the static catalog without a wired port and refuses at execution", async () => {
    const names = catalogDefinitions(testToolPorts).map((entry) => entry.name);
    expect(names).toContain(COMPLETION_TOOL_NAME);
    const result = await runEffect(
      dispatcherFixture(catalogDefinitions(testToolPorts), { executor }).executeCell(
        { id: "unwired", tool: COMPLETION_TOOL_NAME, input: { prompt: "x" } },
        { sessionId: RESIDENT.sessionId, turnId: "turn" },
      ),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("completion refused: sub-model port is not composed");
  });

  it("projects completion without target metadata", () => {
    const specs = catalogDefinitions({ ...testToolPorts, llm: async () => "" }).map((entry) => toolSpec(entry));
    expect(specs.map((spec) => spec.name)).toContain(COMPLETION_TOOL_NAME);
  });
});
