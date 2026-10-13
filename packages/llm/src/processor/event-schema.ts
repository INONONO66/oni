import { PlainObjectSchema } from "@openomni/protocol";
import { z } from "zod";
import type { SDKToolValue } from "../message";
import { Reported } from "../token/schema";

const SDKValueSchema = z.custom<SDKToolValue>(() => true);

/** Only consumed wire fields cross into transcript projection. Accounting has its own decoder. */
export const ProviderEvent = z.object({
  type: z.string(),
  id: z.string().optional(),
  text: z.string().optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  input: PlainObjectSchema.optional(),
  output: SDKValueSchema.optional(),
  isError: z.boolean().optional(),
  message: z.string().optional(),
  finishReason: z.string().optional(),
  providerMetadata: z.record(z.string(), Reported).optional(),
  usage: Reported.optional(),
  error: z.union([z.instanceof(Error), SDKValueSchema]).optional(),
});
export type ProviderEvent = z.infer<typeof ProviderEvent>;
/** The wire shape the SDK stream yields before the processor decodes it. */
export type StreamEvent = z.input<typeof ProviderEvent>;

export const OutputPayload = z.object({
  output: SDKValueSchema.optional(),
  isError: z.boolean().optional(),
});

export const Signature = z.object({ signature: z.string().optional() });
