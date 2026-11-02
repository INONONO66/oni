import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { Outbound, type PlainObject } from "@oni/protocol";
import { bundleTools, testToolPorts } from "./helpers/tool-ports";
import { dispatcherFixture } from "./helpers/dispatcher-fixture";
import { runEffect } from "./helpers/effect";
import { executor } from "./helpers/executor";
import { dispatchModelTool } from "./helpers/tool-dispatch";
import type { SpeechCall } from "../src/bundles/tools/speech/index";

const SPEECH_TOOL_NAME = "speech";
const MAX_SPEECH_CALLS = 32;
const MAX_SPEECH_BYTES = 25 * 1024 * 1024;
const RESIDENT = { role: "resident", sessionId: "session-origin" } as const;

const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
const MP3_REF = `sha256:${createHash("sha256").update(MP3).digest("hex")}`;

function recorder() {
  const calls: SpeechCall[] = [];
  const stored: Array<{ sessionId: string; outputId: string; mediaType: string; bytes: Uint8Array }> = [];
  const ports = {
    speech: async (call: SpeechCall) => {
      calls.push(call);
      return { bytes: MP3, mediaType: "audio/mpeg" };
    },
    putOutput: (sessionId: string, write: { outputId: string; bytes: Uint8Array; mediaType: string }) => {
      stored.push({ sessionId, ...write });
    },
  };
  return { calls, stored, ports };
}

describe("the speech tool", () => {
  it("is on the model door for the resident and its children, and in cells", () => {
    const definition = bundleTools(testToolPorts).find((tool) => tool.name === SPEECH_TOOL_NAME);
    expect(definition?.visibility).toEqual({ model: ["resident", "child"], cell: ["resident", "child"] });
  });

  it("stores the audio under the sha256 of its bytes and returns the ready audio part", async () => {
    const { calls, stored, ports } = recorder();
    const run = dispatchModelTool(SPEECH_TOOL_NAME, ports, RESIDENT);
    const result = await run({ text: "hello there" });
    const part = { kind: "audio" as const, ref: MP3_REF, mime: "audio/mpeg", voice: true as const };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(part);
    expect(result.content).toBe(JSON.stringify(part));
    expect(stored).toEqual([{ sessionId: RESIDENT.sessionId, outputId: MP3_REF, mediaType: "audio/mpeg", bytes: MP3 }]);
    // The returned part is a letter part as send_message reads it, not a copy of its shape.
    expect(Outbound.Part.parse(part)).toEqual(part);
    // Omitted options are not forwarded, so the port's row defaults apply; given ones are, verbatim.
    expect(calls).toEqual([{ text: "hello there" }]);
    await run({ text: "again", voice: "echo", format: "opus", model: "tts-1-hd" });
    expect(calls[1]).toEqual({ text: "again", voice: "echo", format: "opus", model: "tts-1-hd" });
  });

  it("classifies a malformed call as invalid input without touching the port", async () => {
    const { calls, stored, ports } = recorder();
    const run = dispatchModelTool(SPEECH_TOOL_NAME, ports, RESIDENT);
    const malformed: PlainObject[] = [
      { text: "" },
      { text: "x", format: "flac" },
      { text: "x", voice: "" },
      { text: "x", extra: true },
      {},
    ];
    for (const input of malformed) expect(await run(input)).toMatchObject({ isError: true, errorKind: "invalid_input" });
    expect(calls).toEqual([]);
    expect(stored).toEqual([]);
  });

  it("refuses typed while the speech port or the output store is not composed", async () => {
    const { ports } = recorder();
    const refusal = { isError: true, errorKind: "precondition_failed", content: "speech refused: speech port is not composed" };
    expect(await dispatchModelTool(SPEECH_TOOL_NAME, {}, RESIDENT)({ text: "x" })).toMatchObject(refusal);
    expect(await dispatchModelTool(SPEECH_TOOL_NAME, { speech: ports.speech }, RESIDENT)({ text: "x" })).toMatchObject(refusal);
    expect(await dispatchModelTool(SPEECH_TOOL_NAME, { putOutput: ports.putOutput }, RESIDENT)({ text: "x" })).toMatchObject(refusal);
  });

  it("refuses audio above the per-call byte cap before storing anything", async () => {
    const { stored, ports } = recorder();
    const oversized = new Uint8Array(MAX_SPEECH_BYTES + 1);
    const run = dispatchModelTool(
      SPEECH_TOOL_NAME,
      { ...ports, speech: async () => ({ bytes: oversized, mediaType: "audio/wav" }) },
      RESIDENT,
    );
    expect(await run({ text: "a very long book" })).toMatchObject({
      isError: true,
      errorKind: "precondition_failed",
      content: `speech refused: the audio is ${MAX_SPEECH_BYTES + 1} bytes; one call stores at most ${MAX_SPEECH_BYTES}`,
    });
    expect(stored).toEqual([]);
  });

  it(`serves ${MAX_SPEECH_CALLS} calls per cell, then refuses that cell without invoking the port`, async () => {
    const { calls, ports } = recorder();
    const dispatcher = dispatcherFixture(bundleTools({ ...testToolPorts, ...ports }), { executor });
    let nextId = 0;
    const run = (cellId: string, text: string) =>
      runEffect(
        dispatcher.executeCell(
          { id: `cell:${cellId}:${++nextId}`, tool: SPEECH_TOOL_NAME, input: { text } },
          { sessionId: RESIDENT.sessionId, turnId: cellId },
        ),
      );
    const refusal = {
      isError: true,
      errorKind: "precondition_failed",
      content: `speech refused: the per-cell budget of ${MAX_SPEECH_CALLS} speech calls is spent`,
    };

    for (let i = 1; i <= MAX_SPEECH_CALLS; i++) expect((await run("cell-a", `q${i}`)).isError).toBeUndefined();
    expect(await run("cell-a", "one too many")).toMatchObject(refusal);
    expect(calls).toHaveLength(MAX_SPEECH_CALLS);

    // A second cell on the same catalog starts with its own full budget; the first stays spent.
    for (let i = 1; i <= MAX_SPEECH_CALLS; i++) expect((await run("cell-b", `q${i}`)).isError).toBeUndefined();
    expect(await run("cell-b", "one too many")).toMatchObject(refusal);
    expect(await run("cell-a", "still spent")).toMatchObject(refusal);
    expect(calls).toHaveLength(2 * MAX_SPEECH_CALLS);
  });
});
