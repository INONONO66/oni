import { Result } from "effect";
import { Vault, type AccountIdentity, type ActorRegistry, type ChannelInstanceStore, type PersonStore, type SecretStore } from "@oni/channels";
import type { Provisioning } from "@oni/protocol";
import { a2aRoster, type ChannelRuntimeDeps, type CredentialReader, declaredChannelProfile } from "../../channels";
import { MOUNTED_CHANNEL_DEFAULT_TIER } from "../../gateway";
import type { DesiredChannels } from "./supervisor";
import type { KekResolution } from "./vault-key";

/**
 * Boot-time reconciliation of the provisioning store
 * (docs/provisioning-and-providers.md §6): ChannelInstanceStore is the sole
 * source of channel truth, including when no instances are declared.
 */

/** Binds the vault seam for `declaredChannelProfile`: store row + KEK → plaintext or a locked reason. */
export function vaultCredentialReader(
  resolution: KekResolution,
  readSecret: SecretStore["get"],
): CredentialReader {
  if (resolution.kind === "locked") {
    return () => ({ kind: "locked", reason: resolution.reason });
  }
  const kek = resolution.kek;
  return (ref) => {
    const secret = readSecret(ref);
    if (secret === undefined) {
      return { kind: "locked", reason: `no vault row for credentialRef ${ref}` };
    }
    const opened = Result.try({ try: () => Vault.open(secret, kek).reveal(), catch: String });
    return Result.isSuccess(opened)
      ? { kind: "ok", plaintext: opened.success }
      : { kind: "locked", reason: opened.failure };
  };
}

/**
 * What the supervisor should be running from ChannelInstance declarations. The
 * bounce key folds the declaration revision with the secret's rotation epoch,
 * so `channel_add` edits and `secret_rotate` both bounce exactly the
 * stages they touch (§8.7) while everything else keeps running.
 */
export function desiredChannels(
  stores: {
    readonly instances: Pick<ChannelInstanceStore, "list">;
    readonly secrets: Pick<SecretStore, "get">;
  },
  // Resolved once in config (#1245): provisioning never reads the environment.
  kek: KekResolution,
  deps: ChannelRuntimeDeps,
): DesiredChannels {
  const instances = stores.instances.list();
  const secrets = new Map<string, ReturnType<SecretStore["get"]>>();
  const readSecret: SecretStore["get"] = (ref) => {
    if (!secrets.has(ref)) secrets.set(ref, stores.secrets.get(ref));
    return secrets.get(ref);
  };
  const reader = vaultCredentialReader(kek, readSecret);
  // The A2A door's roster reads the store and the vault as they are at request time, never this reconcile's snapshot.
  const roster = a2aRoster(() => stores.instances.list(), vaultCredentialReader(kek, (ref) => stores.secrets.get(ref)));
  const { rows, statuses } = declaredChannelProfile(instances, reader, deps, undefined, roster);
  const byId = new Map(instances.map((instance) => [instance.id, instance]));
  return {
    source: "declared",
    rows: rows.map((row) => {
      const instance = byId.get(row.instanceId);
      const secret =
        instance?.credentialRef === undefined ? undefined : readSecret(instance.credentialRef);
      const rotation = secret?.rotatedAt ?? secret?.createdAt ?? 0;
      return {
        instanceId: row.instanceId,
        key: `${instance?.revision ?? 0}:${rotation}`,
        component: row.component,
        // §3.2 grant block: the declaration is where the Owner raises a
        // surface's tier; absent, the row mounts at the mount tier (#931).
        defaultTier: instance?.grant?.defaultTier ?? MOUNTED_CHANNEL_DEFAULT_TIER,
        // #1600: the declaration's allowlist and mention-only posture ride the row to the grant.
        ...(instance?.grant?.allowedSenders === undefined ? {} : { allowedSenders: instance.grant.allowedSenders }),
        ...(instance?.grant?.mentionOnly === undefined ? {} : { mentionOnly: instance.grant.mentionOnly }),
      };
    }),
    statuses,
  };
}

/** The Owner Person as the store holds it, or the one this binding creates. */
function ownerPerson(persons: Pick<PersonStore, "list">, now: number): Provisioning.Person {
  return (
    persons.list().find((person) => person.trustTier === "owner") ?? {
      id: "person:owner",
      displayName: "Owner",
      kind: "human",
      trustTier: "owner",
      endpoints: [],
      reach: true,
      revision: -1,
      createdBy: "oni",
      updatedAt: now,
    }
  );
}

/**
 * #1600: an Owner instance's account IS the Owner. When the instance mounts
 * and names its account, that platform identity becomes an endpoint of the
 * Owner Person (created as `person:owner`, reachable, when no owner-tier
 * Person exists yet), so the Owner writing to the bot on that platform is
 * owner-tier and `as: owner` can be authorized from there. Idempotent: an
 * endpoint already on the Person leaves the row untouched.
 */
export function bindOwnerAccount(
  stores: { readonly persons: Pick<PersonStore, "list" | "put"> },
  platform: string,
  account: AccountIdentity,
  now: number,
): { readonly bound: Provisioning.Person } | { readonly held: string } | undefined {
  const person = ownerPerson(stores.persons, now);
  const endpoint = { channel: platform, externalId: account.externalId, ...(account.workspace === undefined ? {} : { workspace: account.workspace }) };
  const same = (held: Provisioning.Person["endpoints"][number]) =>
    held.channel === endpoint.channel && held.externalId === endpoint.externalId && held.workspace === endpoint.workspace;
  if (person.endpoints.some(same)) return undefined;
  // Another Person already holds this address: never re-homed by a mount — the Owner resolves it.
  const holder = stores.persons.list().find((other) => other.id !== person.id && other.endpoints.some(same));
  if (holder !== undefined) return { held: holder.id };
  return {
    bound: stores.persons.put({
      ...person,
      endpoints: [...person.endpoints, endpoint],
      revision: person.revision + 1,
      updatedAt: now,
    }),
  };
}

/**
 * Person manifests become durable identity facts — the one path from a
 * declaration to an actor (#1569 lane 8 retired env actors): an idempotent
 * upsert per boot, one identity per Person and one endpoint per platform
 * binding. The sole-owner invariant was already enforced at
 * write time (PersonStore.put) — materialization just replays the manifest.
 */
export function materializePersons(stores: {
  readonly persons: Pick<PersonStore, "list">;
  readonly actors: ActorRegistry;
}): void {
  for (const person of stores.persons.list()) {
    stores.actors.registerIdentity({
      id: person.id,
      kind: person.kind,
      trustTier: person.trustTier,
      ...(person.displayName === undefined ? {} : { displayName: person.displayName }),
    });
    for (const endpoint of person.endpoints) {
      stores.actors.registerEndpoint({
        id: `${endpoint.channel}:${endpoint.externalId}`,
        actorId: person.id,
        channel: endpoint.channel,
        externalId: endpoint.externalId,
        ...(endpoint.workspace === undefined ? {} : { workspace: endpoint.workspace }),
      });
    }
  }
}

/** What the booted composition lends the binder (#1600 lane R1): the Person store, the clock, the actor rebuild, and the Owner's ear. */
interface OwnerAccountBinderDeps {
  readonly persons: Pick<PersonStore, "list" | "put">;
  readonly now: () => number;
  /** Rebuilds the actor rows after the Owner Person gained an endpoint. */
  readonly rebuildActors: () => void;
  readonly warn: (msg: string, context: Readonly<Record<string, string>>) => void;
}

/**
 * The supervisor's `bindAccount` (#1600 lane R1): a mounted Owner instance's
 * account joins the Owner Person and the actors are rebuilt. A failure here
 * is the Owner's to hear, never the mount's to fail — an address another
 * Person holds is named, a thrown binding is reported — and the instance
 * stays up either way.
 */
export function ownerAccountBinder(deps: OwnerAccountBinderDeps): (platform: string, account: AccountIdentity) => void {
  return (platform, account) => {
    try {
      const outcome = bindOwnerAccount({ persons: deps.persons }, platform, account, deps.now());
      if (outcome === undefined) return;
      if ("bound" in outcome) {
        deps.rebuildActors();
        return;
      }
      deps.warn("owner account address held by another person", { platform, externalId: account.externalId, holder: outcome.held });
    } catch (error) {
      deps.warn("owner account binding failed", {
        platform,
        externalId: account.externalId,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
