import { messageSource } from "./helpers/message-source";
import { expect, test } from "bun:test";
import {
  type LedgerAction,
  type Message,
  PlainValueSchema,
  type PlainValue,
} from "@oni/protocol";
import { createAssistantMessage } from "../src/core/journal/message-factory";
import { foldSessionHistory } from "../src/inspect/history";

for (const terminal of [undefined, "interrupted", "error"] as const) {
  test(`positional settlements survive ${terminal ?? "open crash"} history and do not cross turns`, () => {
    const actions: LedgerAction.Node[] = [];
    function append(
      id: string,
      parentId: string | null,
      kind: LedgerAction.Kind,
      intent: PlainValue,
      effect: PlainValue,
    ) {
      actions.push({
        id,
        parentId,
        kind,
        sessionId: "history",
        intent: { encodingVersion: 1, value: intent },
        effect: { encodingVersion: 1, value: effect },
        ts: actions.length + 1,
        ordinal: actions.length + 1,
        prevHash: "fixture-prev",
        actionHash: "fixture-hash",
        irreversible: true,
      });
    }
    function assistant(turn: string): Message.WithParts {
      const message = createAssistantMessage("", "", "history", messageSource, undefined, 1);
      message.info.id = `${turn}-message`;
      message.parts.push(
        ...["A", "B", "C"].map(
          (tool): Message.ToolPart => ({
            type: "tool",
            id: `${turn}-${tool}`,
            messageID: message.info.id,
            sessionID: "history",
            tool,
            callID: `call-${tool}`,
            state: { status: "pending", input: { tool } },
          }),
        ),
      );
      append(turn, null, "turn", { phase: "intent" }, { phase: "pending" });
      append(
        `${turn}-message-intent`,
        turn,
        "message",
        { phase: "intent", op: "assistant" },
        { phase: "pending" },
      );
      append(
        `${turn}-snapshot`,
        `${turn}-message-intent`,
        "message",
        { phase: "result", op: "assistant" },
        { terminal: "executed", result: PlainValueSchema.parse(message) },
      );
      return message;
    }
    function settle(turn: string, tool: string, output: string, isError: boolean) {
      append(
        `${turn}-${tool}-intent`,
        turn,
        "tool",
        { phase: "intent", op: tool },
        { phase: "pending" },
      );
      append(
        `${turn}-${tool}-result`,
        `${turn}-${tool}-intent`,
        "tool",
        { phase: "result", op: tool },
        {
          terminal: "executed",
          callId: `call-${tool}`,
          toolResult: {
            id: `call-${tool}`,
            toolCallId: `call-${tool}`,
            toolName: tool,
            output,
            isError,
          },
        },
      );
    }
    const previous = assistant("previous");
    const current = assistant("current");
    settle("current", "A", "rendered-completion", false);
    settle("current", "B", "rendered-error", true);
    if (terminal !== undefined)
      append(
        "terminal",
        "current",
        "turn",
        { phase: "stop" },
        {
          phase: "terminal",
          turnId: "current",
          kind: terminal,
          text: "",
          boundaryActionId: null,
          resumeCount: 0,
        },
      );
    const original = structuredClone(actions);
    const projected = foldSessionHistory("history", actions);
    const tools = projected
      .find((message) => message.info.id === current.info.id)
      ?.parts.filter((part) => part.type === "tool");
    expect(tools).toMatchObject([
      {
        id: "current-A",
        callID: "call-A",
        state: { status: "completed", output: "rendered-completion", input: { tool: "A" } },
      },
      {
        id: "current-B",
        callID: "call-B",
        state: { status: "error", error: "rendered-error", input: { tool: "B" } },
      },
      {
        id: "current-C",
        callID: "call-C",
        state: { status: "error", error: terminal ?? "tool execution cancelled" },
      },
    ]);
    expect(
      projected
        .find((message) => message.info.id === previous.info.id)
        ?.parts.filter((part) => part.type === "tool")
        .every((part) => part.state.status === "error"),
    ).toBe(true);
    expect(actions).toEqual(original);
  });
}
