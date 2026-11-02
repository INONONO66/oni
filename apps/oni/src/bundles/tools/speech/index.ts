import { createHash } from "node:crypto";
import type { ToolExecutionContext } from "@oni/protocol";
import { z } from "zod";
import { Bundle, Core } from "@oni/agent";
import { boundTool, ToolCapabilityPort } from "../../seams";
import { ABSENT_MACHINE_PORTS, type MachineToolPortsSource } from "../core/ports";
const defineTool = Core.defineTool;
const ToolRefused = Core.ToolRefused;

/** What one text-to-speech call asks for: the text, and optionally a voice, container and model id. */
export interface SpeechCall {
  readonly text: string;
  readonly voice?: string;
  readonly format?: "mp3" | "opus" | "wav";
  /** A speech model id on the port's configured provider; the port owns that provider's credential. */
  readonly model?: string;
}

/** One synthesis, without knowing how the host is composed: text in, the audio container bytes out. */
export type SpeechPort = (call: SpeechCall) => Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }>;

/** Stores one tool output under its `sha256:<hex>` id in the session that made the call. */
export type OutputPort = (
  sessionId: string,
  write: { readonly outputId: string; readonly bytes: Uint8Array; readonly mediaType: string },
) => void;

/** The per-cell call budget: how many speech calls one cell may make. */
const MAX_SPEECH_CALLS = 32;

/** The largest audio one call may store; the session file holds the bytes, so the cap bounds it per call. */
const MAX_SPEECH_BYTES = 25 * 1024 * 1024;

const SPEECH_TOOL_NAME = "speech";

const Input = z
  .object({
    text: z.string().min(1).describe("The text to speak."),
    voice: z.string().min(1).optional().describe("A voice name on the provider; the configured voice when omitted."),
    format: z.enum(["mp3", "opus", "wav"]).optional().describe("The audio container; mp3 when omitted."),
    model: z.string().min(1).optional().describe("A speech model id on the configured provider; the default model when omitted."),
  })
  .strict();

/** The ready letter part: the `send_message` audio part naming the stored output, flagged as a voice note. */
const Output = z
  .object({
    kind: z.literal("audio"),
    ref: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    mime: z.string().min(1),
    voice: z.literal(true),
  })
  .strict();

/**
 * Budgets keyed by the cell that spends them, as `completion` does: the cell
 * door dispatches with `turnId` = cell id and one catalog serves every cell
 * of a generation.
 */
function executeSpeech(speech: SpeechPort | undefined, putOutput: OutputPort | undefined) {
  const spent = new Map<string, number>();
  return async (input: z.output<typeof Input>, ctx: ToolExecutionContext): Promise<z.output<typeof Output>> => {
    if (speech === undefined || putOutput === undefined)
      throw new ToolRefused(SPEECH_TOOL_NAME, "speech port is not composed");
    const calls = spent.get(ctx.turnId) ?? 0;
    if (calls >= MAX_SPEECH_CALLS) {
      throw new ToolRefused(SPEECH_TOOL_NAME, `the per-cell budget of ${MAX_SPEECH_CALLS} speech calls is spent`);
    }
    spent.set(ctx.turnId, calls + 1);
    const audio = await speech({
      text: input.text,
      ...(input.voice === undefined ? {} : { voice: input.voice }),
      ...(input.format === undefined ? {} : { format: input.format }),
      ...(input.model === undefined ? {} : { model: input.model }),
    });
    if (audio.bytes.byteLength > MAX_SPEECH_BYTES) {
      throw new ToolRefused(SPEECH_TOOL_NAME, `the audio is ${audio.bytes.byteLength} bytes; one call stores at most ${MAX_SPEECH_BYTES}`);
    }
    const ref = `sha256:${createHash("sha256").update(audio.bytes).digest("hex")}`;
    putOutput(ctx.sessionId, { outputId: ref, bytes: audio.bytes, mediaType: audio.mediaType });
    return { kind: "audio", ref, mime: audio.mediaType, voice: true };
  };
}

function createSpeechTool(speech: SpeechPort | undefined, putOutput: OutputPort | undefined) {
  return defineTool({
    name: SPEECH_TOOL_NAME,
    category: "execution",
    description:
      "Speak text aloud: synthesize it with the configured speech model and store the audio as one of your tool outputs. Returns the audio part to put in a send_message letter as is (its ref names the stored audio; voice marks it a voice note). Options: voice, format (mp3 default, opus, wav), model.",
    input: Input,
    output: Output,
    visibility: { model: ["resident", "child"], cell: ["resident", "child"] },
    execute: executeSpeech(speech, putOutput),
    render: (_args, value) => JSON.stringify(value),
  });
}

/** The `speech` bundle: text-to-speech into the session's own output store. */
export function speechBundle(ports: MachineToolPortsSource): Bundle.BundleContract<"speech"> {
  return Bundle.define({
    name: "speech",
    requires: [ToolCapabilityPort],
    tools: [boundTool(ports, ABSENT_MACHINE_PORTS, (live) => createSpeechTool(live.speech, live.putOutput))],
  });
}
