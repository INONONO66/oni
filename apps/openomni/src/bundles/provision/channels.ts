import type { ActorRegistry, ChannelInstanceStore, PersonStore, SecretStore } from "@openomni/channels";
import { Vault } from "@openomni/channels";
import { type Channel, canonicalDigest, Provisioning } from "@openomni/protocol";
import { z } from "zod";
import { CONTACT_ONLY_PROVIDERS, validateProviderCredential, validateProviderSettings } from "../../channels";
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
    identity: z
      .enum(["bot", "owner"])
      .optional()
      .describe(
        "Which account this instance speaks as: the bot or the Owner's own account. A re-declaration keeps the stored identity; a fresh one is the bot.",
      ),
    outbound: z
      .boolean()
      .optional()
      .describe("Owner instances only: whether the Resident may send from the Owner's account on explicit instruction."),
    grant: Provisioning.ChannelGrantDeclaration.optional().describe(
      "Who this surface admits — the Owner's decision, so any grant block takes Owner consent: defaultTier is the tier every sender on it gets who is not a declared Person (absent, only Persons at manager or above are admitted); allowedSenders admits those platform ids alone; mentionOnly routes channel messages only when they address the Resident. A block replaces the stored one (a field left out is cleared); a declaration without a block keeps it.",
    ),
    enabled: z.boolean().default(true),
    settings: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe("Non-secret knobs; an Owner instance's intake posture. A re-declaration keeps the stored settings."),
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
  /**
   * #1512: the `cli:` contact's declaration door — validates `{dialect,
   * machine, cwd?}` against the registered dialect packs and the known
   * machines; absent, a `cli` declaration is refused.
   */
  readonly cli?: { readonly declare: (settings: Provisioning.ChannelInstance["settings"]) => string | undefined };
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

/**
 * An Owner-instance declaration, and any change to its outbound grant, is the
 * Owner's call (#1569): the invocation suspends for Owner approval and the
 * row lands only on the consented path, bound to the instance revision the
 * consent was given against.
 */
export function channelConsentRequired(
  identity: Channel.Identity,
  outbound: boolean | undefined,
  /** #1569 lane 9: a webhook target's or an a2a peer's `url` is an outbound destination — never the Resident's own choice; #1512: so is a cli contact's machine. */
  declaration?: {
    readonly provider: string;
    readonly credential?: Readonly<Record<string, string>>;
    /** #1600: the grant block — tier, allowlist, posture — is the Owner's perimeter decision, whichever field it carries. */
    readonly grant?: Provisioning.ChannelGrantDeclaration;
  },
): boolean {
  return (
    identity === "owner" ||
    outbound !== undefined ||
    declaration?.grant !== undefined ||
    (declaration !== undefined && CONTACT_ONLY_PROVIDERS.has(declaration.provider)) ||
    (declaration !== undefined && URL_IS_A_DESTINATION.has(declaration.provider) && declaration.credential?.url !== undefined)
  );
}

/** The providers whose credential `url` is where the Resident's letters go (#1569 lane 9). */
const URL_IS_A_DESTINATION: ReadonlySet<string> = new Set(["webhook", "a2a"]);

/** The domain-revision CAS an Owner's channel consent is bound to: the declared row's revision, `-1` when none. */
export function channelDomainRevisions(
  instances: Pick<ChannelInstanceStore, "get"> | undefined,
  id: string,
): Readonly<Record<string, number>> {
  return { [id]: instances?.get(id)?.revision ?? -1 };
}

/** A re-declaration keeps the stored identity; a fresh declaration is the bot unless the Owner says otherwise. */
export function declaredIdentity(
  input: Pick<z.output<typeof CHANNEL_DECLARE_INPUT>, "identity">,
  existing: Pick<Provisioning.ChannelInstance, "identity"> | undefined,
): Channel.Identity {
  return input.identity ?? existing?.identity ?? "bot";
}

/** The settings gate by provider: a contact row's by its own door (#1512), a channel's by the provider schema. */
function settingsRefusal(
  port: ProvisionPort,
  input: z.output<typeof CHANNEL_DECLARE_INPUT>,
  settings: Provisioning.ChannelInstance["settings"],
  identity: Channel.Identity,
): string | undefined {
  return CONTACT_ONLY_PROVIDERS.has(input.provider)
    ? contactDeclarationRefusal(port, input, settings, identity)
    : validateProviderSettings(input.provider, settings, identity);
}

/** The cli contact's declaration gate (#1512): bot identity, no credential, settings the contact door accepts. */
function contactDeclarationRefusal(
  port: ProvisionPort,
  input: z.output<typeof CHANNEL_DECLARE_INPUT>,
  settings: Provisioning.ChannelInstance["settings"],
  identity: Channel.Identity,
): string | undefined {
  if (identity !== "bot") return `${input.provider} contacts have no Owner-account arm`;
  if (input.credential !== undefined) return `${input.provider} contacts carry no credential; the machine and dialect are settings`;
  if (port.cli === undefined) return `${input.provider} contacts are not composed`;
  return port.cli.declare(settings);
}

export function executeChannelDeclare(port: ProvisionPort, now: () => number) {
  return async (
    input: z.output<typeof CHANNEL_DECLARE_INPUT>,
    domainRevisions?: Readonly<Record<string, number>>,
    // The tool path is the Resident's act; the Owner's own socket declares as the Owner (#1569 lane 5b).
    createdBy: "resident" | "owner" = "resident",
  ) => {
    const existing = port.instances.get(input.id);
    const identity = declaredIdentity(input, existing);
    // A re-declaration keeps the stored knobs (an Owner row's posture is not
    // dropped by an unrelated edit); a fresh declaration carries none.
    const settings = input.settings ?? existing?.settings ?? {};
    // §4: knobs must parse under the provider's settings declaration before
    // the row lands — an Owner instance's are its intake posture (#1569); a
    // cli contact's (#1512) are its dialect, machine and cwd, judged by the
    // contact's own door, and it carries no credential.
    const badSettings = settingsRefusal(port, input, settings, identity);
    if (badSettings !== undefined) return refusal("channel_add", badSettings);
    if (channelConsentRequired(identity, input.outbound, input)) {
      if (domainRevisions === undefined)
        return refusal(
          "channel_add",
          `${input.id}: an Owner instance, its outbound grant, a grant block, a webhook target's or a2a peer's url and a cli contact's machine require Owner consent`,
        );
      if (canonicalDigest({ ...domainRevisions }) !== canonicalDigest(channelDomainRevisions(port.instances, input.id)))
        return refusal("channel_add", "domain revision changed");
    }
    let credentialRef = existing?.credentialRef;
    if (input.credential !== undefined) {
      // §5: the provider schema gates BEFORE any row lands — the owner arm's for an Owner instance (#1569).
      const invalid = validateProviderCredential(input.provider, input.credential, identity);
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
          identity,
          enabled: input.enabled,
          settings,
          ...(credentialRef === undefined ? {} : { credentialRef }),
          // The declared perimeter block survives a re-declaration without one; a block
          // given replaces the stored three fields, and `outbound` is its own field —
          // every one of them the Owner's call (#1569, #1600).
          ...(existing?.grant === undefined && input.outbound === undefined && input.grant === undefined
            ? {}
            : {
                grant: {
                  ...(input.grant === undefined
                    ? existing?.grant
                    : { ...(existing?.grant?.outbound === undefined ? {} : { outbound: existing.grant.outbound }), ...input.grant }),
                  ...(input.outbound === undefined ? {} : { outbound: input.outbound }),
                },
              }),
          revision: (existing?.revision ?? -1) + 1,
          createdBy,
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

/**
 * #1600 lane R1: the Owner instances a secret serves. Rotating their session
 * re-points which account the daemon speaks and listens as — the Owner's call,
 * consented against those rows' revisions.
 */
export function secretRotateDomainRevisions(
  instances: Pick<ChannelInstanceStore, "list"> | undefined,
  secretId: string,
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    (instances?.list() ?? [])
      .filter((instance) => instance.credentialRef === secretId && instance.identity === "owner")
      .map((instance) => [instance.id, instance.revision]),
  );
}

/** Why a rotated payload cannot serve one of the secret's consumers, or nothing. */
function rotationRefusal(port: ProvisionPort, secretId: string, credential: Readonly<Record<string, string>>): string | undefined {
  // The rotated payload must still satisfy every consumer's provider schema.
  for (const instance of port.instances.list()) {
    if (instance.credentialRef !== secretId) continue;
    // Each consumer under its own arm's schema: an Owner instance rotates an account session, never bot tokens (#1569).
    const invalid = validateProviderCredential(instance.provider, credential, instance.identity);
    if (invalid !== undefined) return `${instance.id}: ${invalid}`;
    // A webhook target's or a2a peer's url is declared through channel_add under Owner consent; a rotation never introduces one (#1569 lane 9).
    if (URL_IS_A_DESTINATION.has(instance.provider) && credential.url !== undefined)
      return `${instance.id}: a url is declared through channel_add under Owner consent, never by rotation`;
  }
  return undefined;
}

/** #1600 lane R1: an Owner instance's session is rotated only with the Owner's consent bound to those rows. */
function rotationConsentRefusal(
  port: ProvisionPort,
  secretId: string,
  domainRevisions: Readonly<Record<string, number>> | undefined,
): string | undefined {
  const ownerRows = secretRotateDomainRevisions(port.instances, secretId);
  if (Object.keys(ownerRows).length === 0) return undefined;
  if (domainRevisions === undefined) return `${secretId}: an Owner instance's session is rotated only with Owner consent`;
  return canonicalDigest({ ...domainRevisions }) === canonicalDigest(ownerRows) ? undefined : "domain revision changed";
}

export function executeSecretRotate(port: ProvisionPort, now: () => number) {
  return async (input: z.output<typeof SECRET_ROTATE_INPUT>, domainRevisions?: Readonly<Record<string, number>>) => {
    const existing = port.secrets.get(input.secretId);
    if (existing === undefined) {
      return refusal("secret_rotate", `secret ${input.secretId} does not exist`);
    }
    const unfit = rotationRefusal(port, existing.id, input.credential) ?? rotationConsentRefusal(port, input.secretId, domainRevisions);
    if (unfit !== undefined) return refusal("secret_rotate", unfit);
    const sealed = sealCredential(port, existing.id, input.credential, existing, now());
    if (typeof sealed === "string") return refusal("secret_rotate", sealed);
    port.secrets.put(sealed);
    return { id: existing.id, kekId: sealed.kekId, statuses: await port.supervisor.reconcile() };
  };
}
