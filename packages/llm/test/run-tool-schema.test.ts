import { describe, expect, test } from "bun:test";
import { useStreamCapture } from "./helpers/stream-capture";

const breakpoint = { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } };
const tool = {
  name: "test_tool",
  description: "A test tool",
  inputSchema: { type: "object" as const, properties: { x: { type: "string" as const } } },
};

describe("run schema-only tools and cache breakpoints", () => {
  const capture = useStreamCapture();

  test("maps the advertised schema without installing an execution closure", async () => {
    await capture.run({ tools: [tool] });
    expect(capture.args.tools.test_tool).toMatchObject({
      type: "function",
      description: tool.description,
      inputSchema: { jsonSchema: tool.inputSchema },
      providerOptions: breakpoint,
    });
    expect(capture.args.tools.test_tool?.execute).toBeUndefined();
  });

  test("marks only the last tool definition", async () => {
    await capture.run({
      tools: [
        { ...tool, name: "first" },
        { ...tool, name: "last" },
      ],
    });
    expect(capture.args.tools.first?.providerOptions).toBeUndefined();
    expect(capture.args.tools.last?.providerOptions).toEqual(breakpoint);
  });

  test("does not add Anthropic breakpoints for OpenAI models", async () => {
    await capture.run({
      tools: [tool],
      model: { id: "gpt-4o", providerID: "openai", name: "GPT", api: { npm: "@ai-sdk/openai" } },
    });
    expect(capture.args.tools.test_tool?.providerOptions).toBeUndefined();
  });

  test("marks the system instructions with the Anthropic breakpoint", async () => {
    await capture.run({ system: "system fixture" });
    expect(capture.args.instructions).toEqual([
      {
        role: "system",
        content: "system fixture",
        providerOptions: breakpoint,
      },
    ]);
    expect(capture.args.messages).toEqual([]);
  });
});
