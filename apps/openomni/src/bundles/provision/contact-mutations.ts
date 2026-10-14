import type { ActorRegistry } from "@openomni/channels";
import { type Actor, canonicalDigest, PlainValueSchema } from "@openomni/protocol";
import { z } from "zod";

const CONTACT_PROMOTE_INPUT = z.object({ actorId: z.string().min(1) }).strict();
const CONTACT_MERGE_INPUT = z
  .object({ endpointId: z.string().min(1), toActorId: z.string().min(1) })
  .strict();

/** The consent-gated address-book operations; the provision tool spreads these into its union. */
export const ContactOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("contact_promote"), args: CONTACT_PROMOTE_INPUT }).strict(),
  z.object({ op: z.literal("contact_merge"), args: CONTACT_MERGE_INPUT }).strict(),
]);
type ContactOperation = z.output<typeof ContactOperation>;

export const ContactResult = z.discriminatedUnion("op", [
  z.object({ op: z.literal("contact_promote"), id: z.string(), trustTier: z.string() }).strict(),
  z.object({ op: z.literal("contact_merge"), id: z.string(), actorId: z.string() }).strict(),
]);

const digestKey = (kind: string, id: string, row: Actor.Identity | Actor.Endpoint | undefined) =>
  `${kind}:${id}:${canonicalDigest(PlainValueSchema.parse(row ?? null))}`;

/** Actor rows carry no monotonic revision, so every participating row binds by digest. */
export function contactDomainRevisions(
  actors: ActorRegistry,
  operation: ContactOperation,
): Record<string, number> {
  if (operation.op === "contact_promote") {
    const { actorId } = operation.args;
    return { [digestKey("identity", actorId, actors.getIdentity(actorId))]: 0 };
  }
  const { endpointId, toActorId } = operation.args;
  const endpoint = actors.getEndpoint(endpointId);
  const source = endpoint === undefined ? undefined : actors.getIdentity(endpoint.actorId);
  return {
    [digestKey("endpoint", endpointId, endpoint)]: 0,
    [digestKey("identity", toActorId, actors.getIdentity(toActorId))]: 0,
    [digestKey("source", endpoint?.actorId ?? endpointId, source)]: 0,
  };
}
