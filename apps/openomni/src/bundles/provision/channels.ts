import type { ActorRegistry, ChannelInstanceStore, PersonStore, SecretStore } from "@openomni/channels";
import { Vault } from "@openomni/channels";
import type { Provisioning } from "@openomni/protocol";
import { z } from "zod";
import { validateProviderCredential, validateProviderSettings } from "../../channels";
import type { ChannelSupervisor } from "./supervisor";
import type { KekResolution } from "./vault-key";
import { refusal, storeRefusal } from "./contacts";
import type { BundlePort } from "./bundles";
import { Statuses } from "./status";
import type { AutomationPort } from "./automation";
import type { MachinePort } from "./machines";

export const CHANNEL_DECLARE_INPUT = z
  .object({
    id: z.string().min(1).describe("Instance id, channel:<provider>:<slug>."),
    provider: z.string().min(1),
    enabled: z.boolean().default(true),
    settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    credential: z
      .record(z.string(), z.string())
      .optional()
      .describe("Plaintext credential payload; sealed into the vault, never stored bare."),
  })
  .strict();
const INSTANCE_INPUT = z.object({ instanceId: z.string().min(1) }).strict();
export const SECRET_ROTATE_INPUT = z
  .object({
    secretId: z.string().min(1),
    credential: z.record(z.string(), z.string()).describe("Replacement plaintext payload."),
  })
  .strict();

export const ChannelOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("channel_add"), args: CHANNEL_DECLARE_INPUT }).strict(),
  z.object({ op: z.literal("channel_enable"), args: INSTANCE_INPUT }).strict(),
  z.object({ op: z.literal("channel_disable"), args: INSTANCE_INPUT }).strict(),
  z.object({ op: z.literal("secret_rotate"), args: SECRET_ROTATE_INPUT }).strict(),
]);
export const ChannelResult = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("channel_add"),
      id: z.string(),
      action: z.literal("declared"),
      statuses: Statuses,
    })
    .strict(),
  z
    .object({
      op: z.literal("channel_enable"),
      id: z.string(),
      action: z.literal("enabled"),
      statuses: Statuses,
    })
    .strict(),
  z
    .object({
      op: z.literal("channel_disable"),
      id: z.string(),
      action: z.literal("disabled"),
      statuses: Statuses,
    })
    .strict(),
  z
    .object({
      op: z.literal("secret_rotate"),
      id: z.string(),
      kekId: z.string(),
      statuses: Statuses,
    })
    .strict(),
]);

export interface ProvisionPort {
  readonly machines?: MachinePort;
  readonly automations?: AutomationPort;
  readonly persons: Pick<PersonStore, "put" | "get" | "list" | "remove">;
  readonly instances: Pick<ChannelInstanceStore, "put" | "get" | "list">;
  readonly secrets: Pick<SecretStore, "put" | "get">;
  /** The catalog's actor plane; contact mutations and digests read/write here. */
  readonly actors: ActorRegistry;
  /** The catalog's synchronous transaction: body-entry CAS units run inside it. */
  readonly transaction: <T>(operation: () => T) => T;
  /** Boot's KEK resolution: sealing refuses while the vault is locked. */
  readonly kek: KekResolution;
  readonly supervisor: Pick<ChannelSupervisor, "reconcile" | "resume" | "status" | "source">;
  /** Replays Person manifests into actor identity/endpoint facts (boot's materializer). */
  readonly materialize: () => void;
  /** The composition recompose seam (#1255 P4): bundle_enable/bundle_disable run here. */
  readonly bundles: BundlePort;
  readonly removeIdentity: (id: string) => boolean;
}

function sealCredential(
  port: ProvisionPort,
  secretId: string,
  credential: Record<string, string>,
  existing: Provisioning.Secret | undefined,
  at: number,
): Provisioning.Secret | string {
  if (port.kek.kind === "locked") {
    return `vault is locked (${port.kek.reason}) — cannot seal a credential`;
  }
  const envelope = Vault.seal(new TextEncoder().encode(JSON.stringify(credential)), port.kek.kek);
  return {
    id: secretId,
    ciphertext: envelope.ciphertext,
    wrappedDek: envelope.wrappedDek,
    kekId: envelope.kekId,
    purpose: existing?.purpose ?? "channel_credential",
    createdAt: existing?.createdAt ?? at,
    ...(existing === undefined ? {} : { rotatedAt: at }),
  };
}

export function executeChannelDeclare(port: ProvisionPort, now: () => number) {
  return async (input: z.output<typeof CHANNEL_DECLARE_INPUT>) => {
    // §4: knobs must parse under the provider's settings declaration before the row lands.
    const badSettings = validateProviderSettings(input.provider, input.settings);
    if (badSettings !== undefined) return refusal("channel_add", badSettings);
    const existing = port.instances.get(input.id);
    if (input.id.startsWith("channel:machine:"))
      return refusal("channel_add", "machine declarations require machine_add");
    let credentialRef = existing?.credentialRef;
    if (input.credential !== undefined) {
      // §5: the provider schema gates BEFORE any row lands.
      const invalid = validateProviderCredential(input.provider, input.credential);
      if (invalid !== undefined) return refusal("channel_add", invalid);
      const secretId = credentialRef ?? `secret:${input.id.replaceAll(":", "-")}`;
      const sealed = sealCredential(
        port,
        secretId,
        input.credential,
        port.secrets.get(secretId),
        now(),
      );
      if (typeof sealed === "string") return refusal("channel_add", sealed);
      port.secrets.put(sealed);
      credentialRef = secretId;
    }
    await Promise.resolve()
      .then(() =>
        port.instances.put({
          id: input.id,
          provider: input.provider,
          enabled: input.enabled,
          settings: input.settings,
          ...(credentialRef === undefined ? {} : { credentialRef }),
          revision: (existing?.revision ?? -1) + 1,
          createdBy: "resident",
          updatedAt: now(),
        }),
      )
      .catch((error: Error) => storeRefusal("channel_add", error));
    return { id: input.id, action: "declared" as const, statuses: await port.supervisor.reconcile() };
  };
}

function channelToggleExecutor(port: ProvisionPort, enabled: boolean, now: () => number) {
  const tool = enabled ? "channel_enable" : "channel_disable";
  return async (input: z.output<typeof INSTANCE_INPUT>) => {
    const existing = port.instances.get(input.instanceId);
    if (existing === undefined) {
      return refusal(tool, `channel ${input.instanceId} is not declared`);
    }
    if (existing.provider === "machine")
      return refusal(tool, "machine declarations require machine_add or machine_remove");
    if (enabled) {
      // Manual breaker re-arm (§5): enabling is the operator saying "try again".
      port.supervisor.resume(existing.id);
    }
    port.instances.put({ ...existing, enabled, revision: existing.revision + 1, updatedAt: now() });
    return {
      id: existing.id,
      action: enabled ? ("enabled" as const) : ("disabled" as const),
      statuses: await port.supervisor.reconcile(),
    };
  };
}

export function executeChannelEnable(port: ProvisionPort, now: () => number) {
  return channelToggleExecutor(port, true, now);
}

export function executeChannelDisable(port: ProvisionPort, now: () => number) {
  return channelToggleExecutor(port, false, now);
}

export function executeSecretRotate(port: ProvisionPort, now: () => number) {
  return async (input: z.output<typeof SECRET_ROTATE_INPUT>) => {
    const existing = port.secrets.get(input.secretId);
    if (existing === undefined) {
      return refusal("secret_rotate", `secret ${input.secretId} does not exist`);
    }
    // The rotated payload must still satisfy every consumer's provider schema.
    for (const instance of port.instances.list()) {
      if (instance.credentialRef !== existing.id) continue;
      const invalid = validateProviderCredential(instance.provider, input.credential);
      if (invalid !== undefined) {
        return refusal("secret_rotate", `${instance.id}: ${invalid}`);
      }
    }
    const sealed = sealCredential(port, existing.id, input.credential, existing, now());
    if (typeof sealed === "string") return refusal("secret_rotate", sealed);
    port.secrets.put(sealed);
    return { id: existing.id, kekId: sealed.kekId, statuses: await port.supervisor.reconcile() };
  };
}
