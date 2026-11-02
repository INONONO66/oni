import { parseJson, PlainObjectSchema } from "@oni/protocol";
import { z } from "zod";
import { InvalidProviderData } from "../errors";

const text = z.string();
const audio = z.object({
  input: z.object({
    format: z.object({ type: text, rate: z.number() }),
    turn_detection: z.object({ type: text, create_response: z.boolean() }).nullable(),
    transcription: z.object({ model: text }).nullable(),
  }),
  output: z.object({ format: z.object({ type: text, rate: z.number() }), voice: text }),
});
const schemas = {
  "session.created": z.object({ type: z.literal("session.created") }),
  "session.updated": z.object({
    type: z.literal("session.updated"),
    session: z.object({ audio, tools: z.array(z.object({ name: text })) }),
  }),
  "response.created": z.object({ type: z.literal("response.created"), response: z.object({ id: text }) }),
  "response.done": z.object({ type: z.literal("response.done"), response: z.object({ id: text }) }),
  "response.output_item.done": z.object({
    type: z.literal("response.output_item.done"),
    item: z.object({
      type: text, status: text.optional(), call_id: text.optional(),
      name: text.optional(), arguments: text.optional(),
    }),
  }),
  "response.output_audio.delta": z.object({ type: z.literal("response.output_audio.delta"), delta: text }),
  "conversation.item.input_audio_transcription.completed": z.object({
    type: z.literal("conversation.item.input_audio_transcription.completed"), transcript: text,
  }),
  "response.output_audio_transcript.done": z.object({
    type: z.literal("response.output_audio_transcript.done"), transcript: text,
  }),
  error: z.object({ type: z.literal("error"), error: z.object({ message: text }) }),
};

const event = z.union([
  schemas["session.created"], schemas["session.updated"], schemas["response.created"],
  schemas["response.done"], schemas["response.output_item.done"], schemas["response.output_audio.delta"],
  schemas["conversation.item.input_audio_transcription.completed"],
  schemas["response.output_audio_transcript.done"], schemas.error,
]);
export type ServerEvent = z.infer<typeof event>;

export function decodeFrame(data: string):
  | { readonly ok: true; readonly frame: ServerEvent | undefined }
  | { readonly ok: false; readonly failure: InvalidProviderData } {
  const frame = parseJson(z.object({ type: text }).catchall(z.json()), data);
  if (frame === undefined) return { ok: false, failure: new InvalidProviderData({
    operation: "realtime.frame", message: "Invalid realtime frame", cause: "invalid JSON event",
  }) };
  // A server can send additional event kinds. They are not instructions.
  if (!Object.keys(schemas).includes(frame.type)) return { ok: true, frame: undefined };
  const result = event.safeParse(frame);
  if (!result.success) return { ok: false, failure: new InvalidProviderData({
    operation: "realtime.frame", message: `Invalid realtime ${frame.type} frame`, cause: "invalid event fields",
  }) };
  return { ok: true, frame: result.data };
}

export function decodeArguments(textValue: string) {
  return PlainObjectSchema.safeParse(parseJson(z.json(), textValue) ?? null);
}
