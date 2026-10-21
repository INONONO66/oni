import { describe, test, expect } from "bun:test";
import { ZodError } from "zod";
import { Tool, toolResultText, toolOutputRefSchema, toolWireName } from "../src/tool/index.js";
import { TOOL_OUTPUT_PREVIEW_MAX_BYTES } from "../src/tool/result.js";
import type { PlainValue } from "../src/json.js";

function expectInvalidState<State>(state: State): void {
  expect(() => Tool.State.parse(state)).toThrow(ZodError);
}

describe("Tool.StatePending", () => {
  test("parses valid pending state with empty input", () => {
    const state = Tool.State.parse({
      status: "pending",
      input: {},
    });

    expect(state.status).toBe("pending");
    expect(state.input).toEqual({});
  });

  test("rejects missing input", () => {
    expect(() => Tool.State.parse({ status: "pending" })).toThrow(ZodError);
  });

  test("rejects missing status", () => {
    expect(() => Tool.State.parse({ input: {} })).toThrow(ZodError);
  });

  test("rejects wrong status", () => {
    expect(() =>
      Tool.State.parse({
        status: "running",
        input: {},
      }),
    ).toThrow(ZodError);
  });
});
describe("Tool.StateRunning", () => {
  test("refuses a negative start time — timestamps share the EpochMs contract", () => {
    const negative = Tool.State.safeParse({
      status: "running",
      input: { task: "demo" },
      time: { start: -5 },
    });
    expect(negative.success).toBe(false);

    const state = Tool.State.parse({
      status: "running",
      input: { task: "demo" },
      time: { start: 1_700_000_000_000 },
    });
    expect(state.status).toBe("running");
    if (state.status !== "running") throw new Error("shape");
    expect(state.time.start).toBe(1_700_000_000_000);
  });

  test("rejects missing time", () => {
    expect(() =>
      Tool.State.parse({
        status: "running",
        input: {},
      }),
    ).toThrow(ZodError);
  });

  test("rejects missing input", () => {
    expect(() =>
      Tool.State.parse({
        status: "running",
        time: { start: 1 },
      }),
    ).toThrow(ZodError);
  });
});

describe("Tool.StateCompleted", () => {
  test("parses valid completed state with time.end set to 0", () => {
    const state = Tool.State.parse({
      status: "completed",
      input: { task: "demo" },
      output: "done",
      title: "Demo Task",
      metadata: { nullable: null, nested: [[], {}] },
      time: { start: 1, end: 0 },
    });

    expect(state.status).toBe("completed");
    if (state.status !== "completed") throw new Error("shape");
    expect(state.time.end).toBe(0);
    const metadata: Record<string, PlainValue> = state.metadata;
    expect(metadata).toEqual({ nullable: null, nested: [[], {}] });
  });

  test("rejects non-plain metadata values", () => {
    const base = {
      status: "completed",
      input: {},
      output: "done",
      title: "Demo Task",
      time: { start: 1, end: 2 },
    };
    for (const metadata of [
      { nested: () => "nope" },
      { nested: new Date() },
      { nested: new (class Example {})() },
    ]) {
      expect(Tool.State.safeParse({ ...base, metadata }).success).toBe(false);
    }
  });

  test("rejects missing output", () => {
    expect(() =>
      Tool.State.parse({
        status: "completed",
        input: {},
        title: "Demo Task",
        metadata: {},
        time: { start: 1, end: 2 },
      }),
    ).toThrow(ZodError);
  });

  test("rejects missing title", () => {
    expect(() =>
      Tool.State.parse({
        status: "completed",
        input: {},
        output: "done",
        metadata: {},
        time: { start: 1, end: 2 },
      }),
    ).toThrow(ZodError);
  });

  test("rejects missing time", () => {
    expectInvalidState({
      status: "completed",
      input: {},
      output: "done",
      title: "Demo Task",
      metadata: {},
    });
  });
});

describe("Tool.StateError", () => {
  test("parses valid error state", () => {
    const state = Tool.State.parse({
      status: "error",
      input: { task: "demo" },
      error: "failed",
      time: { start: 1, end: 2 },
    });

    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("shape");
    expect(state.error).toBe("failed");
  });

  test("rejects missing error", () => {
    expect(() =>
      Tool.State.parse({
        status: "error",
        input: {},
        time: { start: 1, end: 2 },
      }),
    ).toThrow(ZodError);
  });

  test("rejects missing time", () => {
    expectInvalidState({ status: "error", input: {}, error: "failed" });
  });
});

describe("Tool.State", () => {
  test("parses each variant by status", () => {
    expect(
      Tool.State.parse({
        status: "pending",
        input: {},
      }).status,
    ).toBe("pending");

    expect(
      Tool.State.parse({
        status: "running",
        input: {},
        time: { start: 1 },
      }).status,
    ).toBe("running");

    expect(
      Tool.State.parse({
        status: "completed",
        input: {},
        output: "done",
        title: "done",
        metadata: {},
        time: { start: 1, end: 2 },
      }).status,
    ).toBe("completed");

    expect(
      Tool.State.parse({
        status: "error",
        input: {},
        error: "failed",
        time: { start: 1, end: 2 },
      }).status,
    ).toBe("error");
  });

  test("rejects wrong status value", () => {
    expect(() =>
      Tool.State.parse({
        status: "done",
        input: {},
      }),
    ).toThrow(ZodError);
  });

  test("rejects missing status field", () => {
    expect(() => Tool.State.parse({ input: {} })).toThrow(ZodError);
  });
});

describe("Tool.Call", () => {
  test("parses valid call", () => {
    const call = Tool.Call.parse({
      id: "call-1",
      tool: "search",
      input: { query: "oni" },
    });

    expect(call.id).toBe("call-1");
    expect(call.tool).toBe("search");
    expect(call.input).toEqual({ query: "oni" });
  });

  test("rejects missing id", () => {
    expect(() =>
      Tool.Call.parse({
        tool: "search",
        input: {},
      }),
    ).toThrow(ZodError);
  });

  test("rejects missing tool", () => {
    expect(() =>
      Tool.Call.parse({
        id: "call-1",
        input: {},
      }),
    ).toThrow(ZodError);
  });
});

describe("Tool.Result", () => {
  test("parses a historical output-only result and reads it through toolResultText", () => {
    const result = Tool.Result.parse({
      id: "res-1",
      toolCallId: "call-1",
      output: "ok",
    });

    expect(result.id).toBe("res-1");
    expect(result.toolCallId).toBe("call-1");
    expect(result.output).toBe("ok");
    expect(result.content).toBeUndefined();
    expect(result.isError).toBeUndefined();
    expect(toolResultText(result)).toBe("ok");
  });

  test("parses a D5 result with content, details and structuredContent", () => {
    const result = Tool.Result.parse({
      id: "res-1",
      toolCallId: "call-1",
      toolName: "demo",
      content: "two rows",
      details: { errorKind: "execution_failed" },
      structuredContent: { rows: [1, 2] },
      isError: false,
    });

    expect(result.content).toBe("two rows");
    expect(result.output).toBeUndefined();
    expect(result.details).toEqual({ errorKind: "execution_failed" });
    expect(result.structuredContent).toEqual({ rows: [1, 2] });
    expect(toolResultText(result)).toBe("two rows");
  });

  test("content wins over output in toolResultText", () => {
    expect(toolResultText({ content: "new", output: "old" })).toBe("new");
  });

  test("rejects a result with neither content nor output", () => {
    expect(() =>
      Tool.Result.parse({
        id: "res-1",
        toolCallId: "call-1",
      }),
    ).toThrow(ZodError);
  });

  test("refuses oversize details and structuredContent JSON typed", () => {
    // One byte over the 262_144-byte JSON bound (two quote bytes + payload).
    const oversize = "x".repeat(262_143);
    for (const field of ["details", "structuredContent"]) {
      const refused = Tool.Result.safeParse({
        id: "res-1",
        toolCallId: "call-1",
        content: "ok",
        [field]: oversize,
      });
      expect(refused.success).toBe(false);
      if (refused.success) throw new Error("shape");
      expect(refused.error).toBeInstanceOf(ZodError);
      expect(refused.error.issues[0]?.message).toContain("exceeds");
    }
    const bounded = Tool.Result.safeParse({
      id: "res-1",
      toolCallId: "call-1",
      content: "ok",
      structuredContent: "x".repeat(262_142),
    });
    expect(bounded.success).toBe(true);
  });

  test("refuses non-plain JSON in the D5 data fields", () => {
    expect(
      Tool.Result.safeParse({
        id: "res-1",
        toolCallId: "call-1",
        content: "ok",
        structuredContent: { when: new Date() },
      }).success,
    ).toBe(false);
  });
});

describe("Tool.Spec", () => {
  test("parses valid minimal spec", () => {
    const spec = Tool.Spec.parse({
      name: "search",
      inputSchema: {},
    });

    expect(spec.name).toBe("search");
    expect(spec.inputSchema).toEqual({});
    expect(spec.description).toBeUndefined();
    expect(spec.safe).toBeUndefined();
    expect(spec.prompt).toBeUndefined();
  });

  test("parses valid full spec", () => {
    const spec = Tool.Spec.parse({
      name: "search",
      description: "Search the workspace",
      inputSchema: { type: "object" },
      safe: true,
      prompt: "rules...",
    });

    expect(spec.description).toBe("Search the workspace");
    expect(spec.safe).toBe(true);
    expect(spec.prompt).toBe("rules...");
  });

  test("parses valid spec with prompt only", () => {
    const spec = Tool.Spec.parse({
      name: "bash",
      inputSchema: {},
      prompt: "rules...",
    });

    expect(spec.name).toBe("bash");
    expect(spec.prompt).toBe("rules...");
  });

  test("parses valid spec without prompt", () => {
    const spec = Tool.Spec.parse({
      name: "bash",
      inputSchema: {},
    });

    expect(spec.name).toBe("bash");
    expect(spec.prompt).toBeUndefined();
  });

  test("rejects missing name", () => {
    expect(() =>
      Tool.Spec.parse({
        inputSchema: {},
      }),
    ).toThrow(ZodError);
  });

  test("rejects missing inputSchema", () => {
    expect(() =>
      Tool.Spec.parse({
        name: "search",
      }),
    ).toThrow(ZodError);
  });

  test("rejects non-plain input schemas", () => {
    const values = [() => "nope", new Date(), new (class Example {})(), { [Symbol("key")]: 1 }];
    for (const inputSchema of values) {
      expect(Tool.Spec.safeParse({ name: "x", inputSchema }).success).toBe(false);
    }
  });
});

describe("toolOutputRefSchema (#1305)", () => {
  const schema = toolOutputRefSchema();
  const outputId = `sha256:${"ab".repeat(32)}`;

  test("a ref whose preview sits exactly at the byte bound parses", () => {
    const ref = schema.parse({
      outputId,
      bytes: TOOL_OUTPUT_PREVIEW_MAX_BYTES + 1,
      mediaType: "text/plain",
      preview: "a".repeat(TOOL_OUTPUT_PREVIEW_MAX_BYTES),
    });
    expect(ref.outputId).toBe(outputId);
    expect(ref.preview).toHaveLength(TOOL_OUTPUT_PREVIEW_MAX_BYTES);
  });

  test("a ref under the bound parses and keeps the optional media hint absent", () => {
    const ref = schema.parse({ outputId, bytes: 1, preview: "" });
    expect(ref.mediaType).toBeUndefined();
    expect(ref.bytes).toBe(1);
  });

  test("a preview one MULTIBYTE code point over the bound is refused at parse", () => {
    // 262_143 ASCII bytes plus one 3-byte code point = 262_146 bytes.
    const oversize = `${"a".repeat(TOOL_OUTPUT_PREVIEW_MAX_BYTES - 1)}\u4e2d`;
    expect(() => schema.parse({ outputId, bytes: 1, preview: oversize })).toThrow(ZodError);
  });

  test("a malformed output id is refused — only canonicalDigest hex names an output", () => {
    expect(() => schema.parse({ outputId: "sha256:XYZ", bytes: 1, preview: "" })).toThrow(ZodError);
    expect(() => schema.parse({ outputId: "ab".repeat(32), bytes: 1, preview: "" })).toThrow(ZodError);
  });
});

test("toolWireName normalizes unsafe names and bounds their length", () => {
  expect(toolWireName("my tool/v2!")).toBe("my_tool_v2_");
  expect(toolWireName("a".repeat(200))).toBe("a".repeat(128));
  expect(toolWireName("read_file-2")).toBe("read_file-2");
});
