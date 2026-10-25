import { z } from "zod";

const Id = z.string().min(1).max(512);
const Cursor = z.string().min(1).max(512);

/** Platform metadata only: reading history never downloads or admits a message. */
export const HistoryAttachment = z.object({
  kind: z.enum(["image", "audio", "video", "file"]),
  ref: Id,
  name: z.string().optional(),
  mime: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  voice: z.boolean().optional(),
}).strict().readonly();
export type HistoryAttachment = z.infer<typeof HistoryAttachment>;

export const HistoryMessage = z.object({
  chatId: Id,
  messageId: Id,
  senderId: Id,
  outgoing: z.boolean(),
  text: z.string(),
  timestampMs: z.number().int().nonnegative(),
  attachments: z.array(HistoryAttachment).readonly(),
  replyToMessageId: Id.optional(),
  threadId: Id.optional(),
}).strict().readonly();
export type HistoryMessage = z.infer<typeof HistoryMessage>;

/** Newest first. `before` is an opaque exclusive cursor; absent at exhaustion. */
export const HistoryPage = z.object({
  messages: z.array(HistoryMessage).max(100).readonly(),
  before: Cursor.optional(),
}).strict().refine((page) => page.messages.length > 0 || page.before === undefined, {
  path: ["before"], message: "an empty history page has no cursor",
}).readonly();
export type HistoryPage = z.infer<typeof HistoryPage>;

export const HistoryQuery = z.object({
  chatId: Id,
  before: Cursor.optional(),
  limit: z.number().int().min(1).max(100),
}).strict();
export type HistoryQuery = z.infer<typeof HistoryQuery>;

/** `instanceId` is the mounted surface id, such as `telegram:owner`. */
export const HistoryRequest = HistoryQuery.extend({
  type: z.literal("channel_history"),
  requestId: Id,
  instanceId: Id,
}).strict();
export type HistoryRequest = z.infer<typeof HistoryRequest>;

export const HistoryRefusalReason = z.enum([
  "owner_auth_required",
  "owner_not_ready",
  "session_in_use",
  "session_lost",
  "login_action_required",
  "history_unavailable",
  "invalid_request",
]);
export type HistoryRefusalReason = z.infer<typeof HistoryRefusalReason>;

export const HistoryRefused = z.object({
  type: z.literal("channel_history_refused"),
  requestId: Id,
  instanceId: Id.optional(),
  reason: HistoryRefusalReason,
  detail: z.string(),
}).strict();
export type HistoryRefused = z.infer<typeof HistoryRefused>;

export const HistoryResponse = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("channel_history_page"),
    requestId: Id,
    instanceId: Id,
    page: HistoryPage,
  }).strict(),
  HistoryRefused,
]);
export type HistoryResponse = z.infer<typeof HistoryResponse>;
