import { z } from "zod";

export const InputRequestId = z.string().regex(/^[1-9]\d*-[1-9]\d*$/);
export type InputRequestId = z.infer<typeof InputRequestId>;

export const InputStatusRequest = z.object({ requestId: InputRequestId }).strict();
export type InputStatusRequest = z.infer<typeof InputStatusRequest>;

export const InputStatusResult = z.union([
  z.object({
    status: z.literal("ok"),
    requestId: InputRequestId,
    dispatched: z.boolean(),
    state: z.enum(["not_started", "dispatched", "completed"]),
  }).strict(),
  z.object({
    status: z.literal("ok"),
    requestId: InputRequestId,
    dispatched: z.boolean(),
    state: z.literal("cancelled"),
    eventsDelivered: z.number().int().nonnegative(),
  }).strict(),
  z.object({ status: z.literal("refused"), reason: z.enum(["request_unknown", "request_busy"]) }).strict(),
]);
export type InputStatusResult = z.infer<typeof InputStatusResult>;
