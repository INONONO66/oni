import type { ActorRegistry } from "@openomni/channels";
import { type Actor, canonicalDigest, type Provisioning } from "@openomni/protocol";
import { Core } from "@openomni/agent";
const ToolRefused = Core.ToolRefused;
import {
  type ContactOperation,
  type ContactResult,
  contactDomainRevisions,
} from "../tools/core/contact-mutations";
import { z } from "zod";
import type { ProvisionPort } from "./channels";
const MANIFEST_INPUT = z
  .object({
    id: z.string().min(1).describe("Person id, person:<slug>."),
    displayName: z.string().min(1).optional(),
    kind: z.enum(["human", "ai_agent", "service"]).describe("What this Person is."),
    trustTier: z
      .enum(["owner", "co_owner", "manager", "collaborator", "observer", "assigned_worker"])
      .describe("Standing trust tier for every bound endpoint."),
    endpoints: z
      .array(
        z
          .object({
            channel: z.string().min(1),
            externalId: z.string().min(1),
            workspace: z.string().min(1).optional(),
          })
          .strict(),
      )
      .describe("Platform identities this Person speaks through."),
  })
  .strict();
export const PERSON_DECLARE_INPUT = z
  .object({
    manifest: MANIFEST_INPUT,
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Answer window for a guard-opened approval request (default 24h)."),
  })
  .strict();
export const PERSON_REMOVE_INPUT = z.object({ personId: z.string().min(1) }).strict();
export const PersonDeclareResult = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("declared"),
      id: z.string(),
      trustTier: z.string(),
      revision: z.number(),
    })
    .strict(),
]);

const TIER_ORDER: readonly Actor.TrustTier[] = [
  "assigned_worker",
  "observer",
  "collaborator",
  "manager",
  "co_owner",
  "owner",
];

const tierRank = (tier: Actor.TrustTier): number => TIER_ORDER.indexOf(tier);

type ManifestInput = z.infer<typeof MANIFEST_INPUT>;

type PersonManifest = Omit<ManifestInput, "displayName"> & { readonly displayName: string };

/**
 * The approval guard (§5): a raise above collaborator — measured against the
 * Person's current tier, so lateral and downward edits stay direct — and ANY
 * mutation touching the reigning owner Person route through the lane.
 */
export function approvalRequirement(
  existing: Provisioning.Person | undefined,
  next: PersonManifest,
): string | undefined {
  if (existing?.trustTier === "owner") {
    return "any mutation of the owner Person requires Owner approval (§8.6)";
  }
  const from = existing === undefined ? tierRank("observer") : tierRank(existing.trustTier);
  if (tierRank(next.trustTier) > from && tierRank(next.trustTier) > tierRank("collaborator")) {
    return `raising ${next.id} to ${next.trustTier} requires Owner approval (§8.5)`;
  }
  return undefined;
}

export function refusal(tool: string, reason: string): never {
  throw new ToolRefused(tool, reason);
}

/** Store failures become tool refusals; existing refusals pass through. */
export function storeRefusal(tool: string, error: Error): never {
  if (error instanceof ToolRefused) throw error;
  return refusal(tool, error.message);
}

/** The declaration is stale when the manifest the Owner saw no longer matches the store. */
function declarationIsStale(
  existing: Provisioning.Person | undefined,
  manifest: PersonManifest,
  domainRevisions: Readonly<Record<string, number>> | undefined,
): boolean {
  if (domainRevisions === undefined) return approvalRequirement(existing, manifest) !== undefined;
  return domainRevisions[manifest.id] !== (existing?.revision ?? -1);
}

function declarePerson(
  port: ProvisionPort,
  input: z.output<typeof PERSON_DECLARE_INPUT>,
  domainRevisions: Readonly<Record<string, number>> | undefined,
  now: () => number,
) {
  const { displayName, ...rest } = input.manifest;
  const manifest: PersonManifest = { ...rest, displayName: displayName ?? rest.id };
  const existing = port.persons.get(manifest.id);
  if (declarationIsStale(existing, manifest, domainRevisions))
    return refusal("contact_add", "domain revision changed");
  const person = port.persons.put({
    ...manifest,
    revision: (existing?.revision ?? -1) + 1,
    createdBy: "resident",
    updatedAt: now(),
  });
  port.materialize();
  return {
    kind: "declared" as const,
    id: person.id,
    trustTier: person.trustTier,
    revision: person.revision,
  };
}

export function executePersonDeclare(port: ProvisionPort, now: () => number) {
  return (
    input: z.output<typeof PERSON_DECLARE_INPUT>,
    domainRevisions?: Readonly<Record<string, number>>,
  ) =>
    Promise.resolve()
      .then(() => port.transaction(() => declarePerson(port, input, domainRevisions, now)))
      .catch((error: Error) => storeRefusal("contact_add", error));
}

export function executePersonRemove(port: ProvisionPort) {
  return async (input: z.output<typeof PERSON_REMOVE_INPUT>) => {
    const existing = port.persons.get(input.personId);
    if (existing === undefined) {
      return refusal("contact_remove", `person ${input.personId} does not exist`);
    }
    if (existing.trustTier === "owner") {
      return refusal("contact_remove", "the sole owner Person cannot be removed");
    }
    port.persons.remove(existing.id);
    port.removeIdentity(existing.id);
    return { id: existing.id };
  };
}

type ContactMutation = z.output<typeof ContactOperation>;
type ContactOutcome = z.output<typeof ContactResult>;

function promoteContact(
  actors: ActorRegistry,
  operation: ContactMutation & { op: "contact_promote" },
): ContactOutcome {
  const identity = actors.getIdentity(operation.args.actorId);
  if (identity?.standing !== "provisional")
    throw new ToolRefused(operation.op, "contact is missing or already registered");
  const promoted = actors.promote(operation.args.actorId);
  return { op: operation.op, id: promoted.id, trustTier: promoted.trustTier };
}

function mergeContactEndpoint(
  actors: ActorRegistry,
  operation: ContactMutation & { op: "contact_merge" },
): ContactOutcome {
  const { endpointId, toActorId } = operation.args;
  const endpoint = actors.getEndpoint(endpointId);
  const bindable =
    endpoint !== undefined &&
    endpoint.actorId !== toActorId &&
    actors.getIdentity(toActorId) !== undefined;
  if (!bindable)
    throw new ToolRefused(operation.op, "endpoint or target is missing, or already bound");
  const merged = actors.mergeEndpoint(endpointId, toActorId);
  return { op: operation.op, id: merged.id, actorId: merged.actorId };
}

/**
 * Body-entry domain CAS inside one transaction. Consent itself is the kernel
 * request the `require_approval` policy row opened; this layer only refuses to
 * spend it on rows that changed since the Owner saw them.
 */
export function mutateContact(
  port: Pick<ProvisionPort, "actors" | "transaction">,
  operation: ContactMutation,
  revisions: Readonly<Record<string, number>> | undefined,
): ContactOutcome {
  return port.transaction(() => {
    const seen = revisions === undefined ? undefined : canonicalDigest({ ...revisions });
    if (seen !== canonicalDigest(contactDomainRevisions(port.actors, operation)))
      throw new ToolRefused(operation.op, "domain revision changed");
    return operation.op === "contact_promote"
      ? promoteContact(port.actors, operation)
      : mergeContactEndpoint(port.actors, operation);
  });
}
