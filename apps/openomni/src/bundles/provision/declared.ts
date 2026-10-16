import { Result } from "effect";
import { Vault, type ActorRegistry, type ChannelInstanceStore, type PersonStore, type SecretStore } from "@openomni/channels";
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
      };
    }),
    statuses,
  };
}

/**
 * Person manifests become durable identity facts the way env actors do:
 * an idempotent upsert per boot, one identity per Person and one endpoint
 * per platform binding. The sole-owner invariant was already enforced at
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
