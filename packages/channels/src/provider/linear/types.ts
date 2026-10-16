import { z } from "zod";

/** Who acted, as Linear names them on the envelope; null for a system or integration action. */
const LinearActorSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  type: z.string().nullish(),
});

/**
 * Wire schemas for the webhook payloads the surface consumes — THE typed
 * boundary where a signature-verified body becomes data. An envelope or a
 * payload that does not parse is an unsupported event, never a duck-typed
 * walk. Linear mirrors its GraphQL entities and sends explicit nulls for
 * absent relations, so only the fields read here are declared and each
 * may be null; extra keys pass.
 */
export const LinearWebhookEnvelope = z.object({
  action: z.string(),
  type: z.string(),
  actor: LinearActorSchema.nullish(),
  data: z.record(z.string(), z.json()),
  url: z.string().nullish(),
  /** Unix milliseconds the delivery was signed at; Linear's retries keep it. */
  webhookTimestamp: z.number(),
  organizationId: z.string().nullish(),
});
export type LinearWebhookEnvelope = z.infer<typeof LinearWebhookEnvelope>;

export const LinearWebhookPayloadSchemas = {
  Issue: z.object({
    id: z.string(),
    identifier: z.string().nullish(),
    title: z.string(),
    description: z.string().nullish(),
    creatorId: z.string().nullish(),
    /** Set when an integration or bot created the entity. */
    botActor: z.string().nullish(),
    teamId: z.string().nullish(),
  }),
  Comment: z.object({
    id: z.string(),
    body: z.string(),
    /** Null on a document or project-update comment: not an issue's, not read. */
    issueId: z.string().nullish(),
    userId: z.string().nullish(),
    botActor: z.string().nullish(),
    issue: z.object({ id: z.string(), identifier: z.string().nullish(), title: z.string().nullish() }).nullish(),
  }),
};

/**
 * The Owner's own Linear access (#1569 lane 9b): the webhook's signing
 * secret, the Owner's personal API key for commenting back (absent leaves
 * the instance ingress-only), and the Owner's user id when the key cannot
 * say — the account's own actions are never an outside event, and a
 * mention of the Owner is what `mentions_and_dms` admits.
 */
export interface LinearOwnerCredentials {
  readonly secret: string;
  readonly token?: string;
  readonly ownerUserId?: string;
}

/** The account the key belongs to, as Linear names it. */
export interface LinearViewer {
  readonly id: string;
  readonly name?: string;
  readonly displayName?: string;
}
