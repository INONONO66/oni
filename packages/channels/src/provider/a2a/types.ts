import { z } from "zod";

const Id = z.string().min(1);
const Metadata = z.record(z.string(), z.json()).optional();

/** The A2A revision this door speaks: the JSON-RPC binding with `kind` discriminators. */
export const A2A_PROTOCOL_VERSION = "0.3.0";

/** A part of a message or an artifact; only text is read here, the rest passes through as data. */
export const Part = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string(), metadata: Metadata }),
  z.object({ kind: z.literal("file"), file: z.record(z.string(), z.json()), metadata: Metadata }),
  z.object({ kind: z.literal("data"), data: z.record(z.string(), z.json()), metadata: Metadata }),
]);
export type Part = z.infer<typeof Part>;

export const Message = z.object({
  kind: z.literal("message").optional(),
  role: z.enum(["user", "agent"]),
  parts: z.array(Part).min(1),
  messageId: Id,
  taskId: Id.optional(),
  contextId: Id.optional(),
  metadata: Metadata,
});
export type Message = z.infer<typeof Message>;

export const TaskState = z.enum([
  "submitted",
  "working",
  "input-required",
  "completed",
  "canceled",
  "failed",
  "rejected",
  "auth-required",
  "unknown",
]);
export type TaskState = z.infer<typeof TaskState>;

/** The states a task never leaves. */
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["completed", "canceled", "failed", "rejected"]);

const TaskStatus = z.object({ state: TaskState, message: Message.optional(), timestamp: z.string().optional() });

const Artifact = z.object({ artifactId: Id, name: z.string().optional(), parts: z.array(Part), metadata: Metadata });

export const Task = z.object({
  kind: z.literal("task").optional(),
  id: Id,
  contextId: Id,
  status: TaskStatus,
  artifacts: z.array(Artifact).optional(),
  history: z.array(Message).optional(),
  metadata: Metadata,
});
export type Task = z.infer<typeof Task>;

export const MessageSendParams = z.object({
  message: Message,
  configuration: z
    .object({
      blocking: z.boolean().optional(),
      acceptedOutputModes: z.array(z.string()).optional(),
      historyLength: z.number().int().nonnegative().optional(),
    })
    .optional(),
  metadata: Metadata,
});
export type MessageSendParams = z.infer<typeof MessageSendParams>;

export const TaskIdParams = z.object({ id: Id, historyLength: z.number().int().nonnegative().optional(), metadata: Metadata });
export type TaskIdParams = z.infer<typeof TaskIdParams>;

const JsonRpcId = z.union([z.string(), z.number(), z.null()]);
export const JsonRpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcId.optional(),
  method: z.string(),
  params: z.json().optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequest>;

export const JsonRpcError = z.object({ code: z.number().int(), message: z.string(), data: z.json().optional() });
export type JsonRpcError = z.infer<typeof JsonRpcError>;

export const JsonRpcResponse = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcId,
  result: z.json().optional(),
  error: JsonRpcError.optional(),
});
export type JsonRpcResponse = z.infer<typeof JsonRpcResponse>;

/** The JSON-RPC codes A2A names, and the standard ones this door answers with. */
export const A2A_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotSupported: -32003,
  unsupportedOperation: -32004,
} as const;

/** The 0.3 method names, with the 1.0 spellings accepted as aliases. */
export const A2A_METHODS = {
  send: new Set(["message/send", "SendMessage"]),
  stream: new Set(["message/stream", "SendStreamingMessage", "tasks/resubscribe", "SubscribeToTask"]),
  get: new Set(["tasks/get", "GetTask"]),
  cancel: new Set(["tasks/cancel", "CancelTask"]),
  push: new Set(["tasks/pushNotificationConfig/set", "tasks/pushNotificationConfig/get", "CreateTaskPushNotification", "GetTaskPushNotification"]),
} as const;

/** What a peer publishes about itself; only what the client needs is read. */
export const AgentCard = z.object({
  name: z.string(),
  url: z.string().min(1),
  protocolVersion: z.string().optional(),
  preferredTransport: z.string().optional(),
  version: z.string().optional(),
  description: z.string().optional(),
});
export type AgentCard = z.infer<typeof AgentCard>;

/**
 * The vault-opened declaration of a peer: `token`, the shared bearer a peer
 * presents to this door and this daemon presents when writing to the peer;
 * `url`, the peer's base where its card is served (absent leaves the peer
 * inbound-only); `name`, how the peer is named in observations.
 */
export const A2ACredentials = z
  .object({
    token: z.string().min(1),
    url: z
      .string()
      .url()
      .refine((url) => /^https?:\/\//.test(url), "a peer url is http or https")
      .optional(),
    name: z.string().min(1).optional(),
  })
  .strict();
export type A2ACredentials = z.infer<typeof A2ACredentials>;

/** The text of a message's parts, in order. */
export function textOf(parts: readonly Part[]): string {
  return parts
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join("\n");
}
