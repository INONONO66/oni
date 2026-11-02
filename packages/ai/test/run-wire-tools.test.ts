import { describe, expect, test } from "bun:test";
import { useStreamCapture } from "./helpers/stream-capture";
import { capturingSink } from "./helpers/processor";

const NATIVE_TOOL_NAMES = [
  "message.send",
  "engagement.open",
  "engagement.transition",
  "engagement.list",
  "grep.search",
  "recall.output",
];

describe("run wire tool identity", () => {
  const capture = useStreamCapture();

  test("serializes dotted names into the provider wire pattern", async () => {
    await capture.run({
      tools: NATIVE_TOOL_NAMES.map((name) => ({
        name,
        description: name,
        inputSchema: { type: "object" },
      })),
    });
    const names = Object.keys(capture.args.tools);
    expect(names).toEqual([
      "message_send",
      "engagement_open",
      "engagement_transition",
      "engagement_list",
      "grep_search",
      "recall_output",
    ]);
    for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
  });

  test("records original dotted identity when the provider echoes a wire name", async () => {
    capture.stream([
      {
        type: "tool-call",
        toolCallId: "call-send",
        toolName: "message_send",
        input: { body: "hi" },
      },
      { type: "tool-result", toolCallId: "call-send", toolName: "message_send", output: "sent" },
      { type: "finish" },
    ]);
    const output = capturingSink();
    await capture.run(
      { tools: [{ name: "message.send", description: "send", inputSchema: { type: "object" } }] },
      output.sink,
    );
    expect(output.toolCalls.map((call) => call.tool)).toEqual(["message.send"]);
    expect(output.finalParts().find((part) => part.type === "tool")?.tool).toBe("message.send");
  });
});
