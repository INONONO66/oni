import { describe, expect, test } from "bun:test";
import { uiMessagesToTranscript } from "../src/renderer/chat/adapter";
import type { OniUIMessage } from "../src/renderer/chat/message";

/**
 * The adapter is the ONE place the AI SDK's message shape meets the design
 * system's transcript shape, and it is the only place either vocabulary is
 * allowed to know the other exists. `@oni/ui` never imports `ai`; the SDK
 * never learns what a `TranscriptTool` is.
 *
 * What is asserted here is therefore a translation contract rather than a
 * rendering one: the ORDER parts arrived in, the state each tool call ended in,
 * and the fact that a blocked call produces a decision keyed by the approval —
 * never by the tool call, because one call can be asked about twice and the
 * response the SDK expects back carries the approval's id.
 */

const user = (id: string, text: string): OniUIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

describe("uiMessagesToTranscript", () => {
  test.each([
    { input: "raw command", target: "raw command" },
    { input: { command: 9, path: "fallback.ts" }, target: "fallback.ts" },
    { input: { command: "first", path: "second" }, target: "first" },
    { input: { target: "last" }, target: "last" },
    { input: { unrelated: true }, target: "" },
    { input: null, target: "" },
    { input: ["not a target"], target: "" },
  ])("dynamic input is parsed before target projection: $target", ({ input, target }) => {
    const result = uiMessagesToTranscript([{
      id: "dynamic", role: "assistant", parts: [{
        type: "dynamic-tool", toolName: "inspect", toolCallId: "call",
        state: "input-available", input,
      }],
    }]);
    expect(result.nodes).toEqual([{ kind: "tool", id: "call", tool: "inspect", target, status: "running" }]);
  });

  test.each([[999, "999ms"], [1000, "1.0s"], [61_200, "1m 1s"]] as const)(
    "cost duration %i preserves unit boundaries", (elapsedMs, elapsed) => {
      const result = uiMessagesToTranscript([user("prompt", "question"), {
        id: "answer", role: "assistant", metadata: { startedAt: 0, elapsedMs },
        parts: [{ type: "text", text: "answer" }],
      }]);
      expect(result.costs[1]?.elapsed).toBe(elapsed);
    },
  );
  test("an empty ledger is empty, not a shape with holes in it", () => {
    expect(uiMessagesToTranscript([])).toEqual({ nodes: [], costs: {}, pending: [] });
  });

  test("a user text part becomes the prompt node, keyed by the message", () => {
    const { nodes } = uiMessagesToTranscript([user("m1", "refactor the lease")]);

    expect(nodes).toEqual([{ kind: "prompt", id: "m1", text: "refactor the lease" }]);
  });

  test("assistant parts keep arrival order: text, tool, text, tool", () => {
    const { nodes } = uiMessagesToTranscript([
      {
        id: "m2",
        role: "assistant",
        parts: [
          { type: "text", text: "Reading the append path." },
          {
            type: "tool-bash",
            toolCallId: "c1",
            state: "output-available",
            input: { command: "rg lease.acquire" },
            output: { stdout: "138: let lease" },
          },
          { type: "text", text: "Now the guard." },
          {
            type: "dynamic-tool",
            toolName: "read",
            toolCallId: "c2",
            state: "input-available",
            input: { path: "guard.rs" },
          },
        ],
      },
    ]);

    expect(nodes.map((node) => node.kind)).toEqual(["assistant", "tool", "assistant", "tool"]);
    expect(nodes[0]).toMatchObject({ blocks: [{ kind: "p", text: "Reading the append path." }] });
    expect(nodes[1]).toMatchObject({ id: "c1", tool: "bash", target: "rg lease.acquire" });
    expect(nodes[2]).toMatchObject({ blocks: [{ kind: "p", text: "Now the guard." }] });
    expect(nodes[3]).toMatchObject({ id: "c2", tool: "read", status: "running" });
  });

  test("adjacent text parts merge into one answer, so paragraphs are one turn's prose", () => {
    const { nodes } = uiMessagesToTranscript([
      {
        id: "m3",
        role: "assistant",
        parts: [
          { type: "text", text: "First." },
          { type: "text", text: "Second." },
        ],
      },
    ]);

    expect(nodes).toEqual([
      {
        kind: "assistant",
        id: "m3.0",
        streaming: false,
        blocks: [
          { kind: "p", text: "First." },
          { kind: "p", text: "Second." },
        ],
      },
    ]);
  });

  test("a streaming text part marks the answer as still being written", () => {
    const { nodes } = uiMessagesToTranscript([
      {
        id: "m4",
        role: "assistant",
        parts: [{ type: "text", text: "Thinking", state: "streaming" }],
      },
    ]);

    expect(nodes[0]).toMatchObject({ kind: "assistant", streaming: true });
  });

  test("every tool state maps onto exactly one call outcome", () => {
    const { nodes } = uiMessagesToTranscript([
      {
        id: "m5",
        role: "assistant",
        parts: [
          {
            type: "tool-bash",
            toolCallId: "s1",
            state: "input-streaming",
            input: { command: "npm te" },
          },
          {
            type: "tool-bash",
            toolCallId: "s2",
            state: "input-available",
            input: { command: "npm test" },
          },
          {
            type: "tool-bash",
            toolCallId: "s3",
            state: "approval-requested",
            input: { command: "rm -rf dist" },
            approval: { id: "a3", requestReason: "outside declared scope" },
          },
          {
            type: "tool-bash",
            toolCallId: "s4",
            state: "approval-responded",
            input: { command: "npm run build" },
            approval: { id: "a4", approved: true },
          },
          {
            type: "tool-bash",
            toolCallId: "s5",
            state: "output-error",
            input: { command: "cargo test" },
            errorText: "exit 101",
          },
          {
            type: "tool-bash",
            toolCallId: "s6",
            state: "output-denied",
            input: { command: "curl example.com" },
            approval: { id: "a6", approved: false },
          },
          {
            type: "tool-bash",
            toolCallId: "s7",
            state: "output-available",
            input: { command: "ls" },
            output: { stdout: "dist" },
          },
        ],
      },
    ]);

    expect(
      nodes.map((node) => (node.kind === "tool" ? [node.id, node.status] : node.kind)),
    ).toEqual([
      ["s1", "running"],
      ["s2", "running"],
      // A blocked row is addressed by its APPROVAL — see the tray test below.
      ["a3", "waiting"],
      ["s4", "running"],
      ["s5", "failed"],
      ["s6", "denied"],
      // `done` is the transcript's implicit default and stays unspoken.
      ["s7", undefined],
    ]);
  });

  test("a rejected approval is denied even before a terminal tool chunk arrives", () => {
    const { nodes } = uiMessagesToTranscript([
      {
        id: "m5-rejected",
        role: "assistant",
        parts: [
          {
            type: "tool-bash",
            toolCallId: "rejected",
            state: "approval-responded",
            input: { command: "curl example.com" },
            approval: { id: "approval-rejected", approved: false },
          },
        ],
      },
    ]);

    expect(nodes[0]).toMatchObject({ kind: "tool", id: "rejected", status: "denied" });
  });

  test("a failed call carries its error text as the payload the chevron reveals", () => {
    const { nodes } = uiMessagesToTranscript([
      {
        id: "m6",
        role: "assistant",
        parts: [
          {
            type: "tool-bash",
            toolCallId: "e1",
            state: "output-error",
            input: { command: "cargo test" },
            errorText: "exit 101",
          },
        ],
      },
    ]);

    expect(nodes[0]).toMatchObject({ kind: "tool", status: "failed", payload: ["exit 101"] });
  });

  test("a blocked call docks a decision keyed by the APPROVAL, never the tool call", () => {
    const { nodes, pending } = uiMessagesToTranscript([
      {
        id: "m7",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "shell",
            toolCallId: "c9",
            state: "approval-requested",
            input: { command: "npm test" },
            approval: { id: "ap9", requestReason: "outside declared scope" },
          },
        ],
      },
    ]);

    expect(nodes[0]).toMatchObject({ kind: "tool", id: "ap9", status: "waiting" });
    expect(pending).toEqual([
      {
        toolId: "ap9",
        summary: "shell wants to run npm test",
        reason: "outside declared scope",
      },
    ]);
  });

  test("parts the transcript has no row for are dropped, not thrown on", () => {
    const { nodes, pending } = uiMessagesToTranscript([
      {
        id: "m9",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "reasoning", text: "internal" },
          { type: "source-url", sourceId: "s", url: "https://example.com" },
          { type: "file", mediaType: "text/plain", url: "data:,x" },
          { type: "text", text: "Done." },
        ],
      },
    ]);

    expect(nodes).toEqual([
      { kind: "assistant", id: "m9.4", streaming: false, blocks: [{ kind: "p", text: "Done." }] },
    ]);
    expect(pending).toEqual([]);
  });

  test("a system message contributes nothing to the ledger", () => {
    const { nodes } = uiMessagesToTranscript([
      { id: "m10", role: "system", parts: [{ type: "text", text: "you are an agent" }] },
    ]);

    expect(nodes).toEqual([]);
  });

  test("metadata becomes the turn's cost, keyed by the turn the answer landed in", () => {
    const { costs } = uiMessagesToTranscript([
      user("m11", "first question"),
      {
        id: "m12",
        role: "assistant",
        metadata: { startedAt: Date.UTC(2026, 8, 3, 14, 32, 0), elapsedMs: 18_400 },
        parts: [{ type: "text", text: "first answer" }],
      },
      user("m13", "second question"),
      {
        id: "m14",
        role: "assistant",
        metadata: { startedAt: Date.UTC(2026, 8, 3, 14, 33, 0), elapsedMs: 54_000 },
        parts: [{ type: "text", text: "second answer" }],
      },
    ]);

    expect(costs).toEqual({
      1: { at: formatClock(Date.UTC(2026, 8, 3, 14, 32, 0)), elapsed: "18.4s" },
      2: { at: formatClock(Date.UTC(2026, 8, 3, 14, 33, 0)), elapsed: "54.0s" },
    });
  });

  test("an answer with no metadata costs nothing rather than costing zero", () => {
    const { costs } = uiMessagesToTranscript([
      user("m15", "question"),
      { id: "m16", role: "assistant", parts: [{ type: "text", text: "answer" }] },
    ]);

    expect(costs).toEqual({});
  });
});

/**
 * The expected clock reading, computed the way the adapter must: in the
 * READER'S timezone. Hard-coding `14:32` would pass in UTC and fail in Seoul,
 * which is a test asserting where the machine is rather than what the code does.
 */
function formatClock(at: number): string {
  const local = new Date(at);
  const hours = String(local.getHours()).padStart(2, "0");
  const minutes = String(local.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}
