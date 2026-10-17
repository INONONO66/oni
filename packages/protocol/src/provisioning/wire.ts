import { z } from "zod";
import { Channel } from "../channel/index.js";
import { ChannelGrantDeclaration } from "./schema.js";

const Id = z.string().min(1);
const Correlation = z.object({ requestId: Id });

/**
 * The Owner's channel declaration over the ws wire (#1569 lane 5b): the
 * login helper seals an account session into the vault through the same
 * `channel_add` the Resident's provision tool runs, with the Owner as the
 * caller — so the declaration passes Owner consent by construction. The
 * shape mirrors the provision tool's `channel_add` arguments.
 */
export const ChannelDeclareRequest = Correlation.extend({
  type: z.literal("channel_add"),
  id: Id,
  provider: Id,
  identity: Channel.Identity.optional(),
  enabled: z.boolean().optional(),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  outbound: z.boolean().optional(),
  /** #1600: who the surface admits and at what tier; the Owner's socket consents by the call itself. */
  grant: ChannelGrantDeclaration.optional(),
  credential: z.record(z.string(), z.string()).optional(),
}).strict();
export type ChannelDeclareRequest = z.infer<typeof ChannelDeclareRequest>;

/** One mounted-or-not verdict per declared instance, as the supervisor reports it. */
const ChannelDeclareStatus = z
  .object({ id: Id, surface: z.string(), state: z.string(), detail: z.string().optional() })
  .strict();

const ChannelDeclared = Correlation.extend({
  type: z.literal("channel_declared"),
  id: Id,
  statuses: z.array(ChannelDeclareStatus),
}).strict();

const ChannelDeclareRefusalReason = z.enum([
  /** Only the Owner's own socket declares a channel this way. */
  "owner_only",
  "store_unconfigured",
  "invalid_record",
  /** The declaration's own refusal (credential, settings, consent), verbatim in `detail`. */
  "refused",
]);

export const ChannelDeclareRefused = Correlation.extend({
  type: z.literal("channel_add_refused"),
  reason: ChannelDeclareRefusalReason,
  detail: z.string(),
}).strict();
export type ChannelDeclareRefused = z.infer<typeof ChannelDeclareRefused>;

export const ChannelDeclareResponse = z.discriminatedUnion("type", [ChannelDeclared, ChannelDeclareRefused]);
export type ChannelDeclareResponse = z.infer<typeof ChannelDeclareResponse>;
