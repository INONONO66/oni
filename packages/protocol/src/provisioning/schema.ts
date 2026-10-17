import { z } from "zod";
import { Actor } from "../actor/index.js";
import { Channel } from "../channel/index.js";
import { NamedError } from "../error/index.js";
import { PlainValueSchema } from "../json.js";
import { EpochMs } from "../time.js";

/**
 * Provisioning vocabulary (docs/provisioning-and-providers.md §3): the
 * Owner's standing declarations — who people are (Person), which channels
 * exist (ChannelInstance), and the ciphertext credential rows they reference
 * (Secret). Declarations are durable acts with revision + createdBy; derived
 * state (actor rows, channel grants) is materialized from them at reconcile
 * time and is rebuildable. Durable persistence lives in the channels store plane.
 */

const PersonId = z
  .string()
  .regex(/^person:[a-z0-9][a-z0-9-]*$/, "Person id must be person:<slug>");

const ChannelInstanceId = z
  .string()
  .regex(
    /^channel:[a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9-]*$/,
    "ChannelInstance id must be channel:<provider>:<slug>",
  );

const SecretId = z
  .string()
  .regex(/^secret:[a-z0-9][a-z0-9-]*$/, "Secret id must be secret:<slug>");

/**
 * One platform identity bound to a Person. `workspace` is the platform's
 * tenant key where the platform has one (Slack team id, GitHub org) —
 * mandatory per provider contract, not per schema. `externalId` is the
 * platform's stable id (numeric/snowflake), never the mutable username.
 */
const PersonEndpoint = z
  .object({
    channel: z.string().min(1),
    workspace: z.string().min(1).optional(),
    externalId: z.string().min(1),
  })
  .strict();

/**
 * §3.1 identity manifest: the Owner's declaration that a person (or agent)
 * exists, at what standing, reachable at which platform endpoints. Exactly
 * one Person per installation may carry `trustTier: "owner"` — the ledger
 * store enforces it with a typed `owner_exists` refusal.
 */
export const Person = z
  .object({
    id: PersonId,
    displayName: z.string().min(1),
    kind: Actor.Kind,
    trustTier: Actor.TrustTier,
    endpoints: z.array(PersonEndpoint),
    /**
     * #1569 lane 8: the Owner's standing grant — the Resident may write to
     * this Person cold through `send_message`. Absent, the Person is an
     * inbound identity only: a letter to it is `ungranted`.
     */
    reach: z.boolean().optional(),
    revision: z.number().int().nonnegative(),
    createdBy: z.string().min(1),
    updatedAt: EpochMs,
  })
  .strict();
export type Person = z.infer<typeof Person>;

/**
 * §3.2 perimeter policy block: replaces the hardcoded trusted-channel grant —
 * boot materializes the ChannelGrant row from this declaration.
 */
const GrantPolicy = z
  .object({
    defaultTier: Actor.TrustTier.optional(),
    /** The platform ids the surface admits; absent, every sender (an empty list would admit nobody and is refused). */
    allowedSenders: z.array(z.string().min(1)).min(1).optional(),
    provisionalMint: z.boolean().optional(),
    /** #1600: a channel surface routes a channel message only when it addresses the Resident (a DM or a mention always does). */
    mentionOnly: z.boolean().optional(),
    /**
     * #1569: an Owner-identity instance may send on the Owner's behalf only
     * when the Owner declared it here; absent or false, the instance mounts
     * without a delivery route and `send_message … as: owner` is refused as
     * `identity_not_granted`. Meaningless on a bot instance.
     */
    outbound: z.boolean().optional(),
  })
  .strict();

/**
 * #1600: the part of the grant block a declaration writes — who the surface
 * admits and at what tier. The block is the Owner's perimeter decision: a
 * declaration carrying one takes Owner consent and replaces the stored
 * block's three fields (a field left out is cleared), so a tier, an
 * allowlist or a posture is never widened, narrowed or dropped without the
 * Owner. A declaration without the block keeps what was consented to.
 */
export const ChannelGrantDeclaration = GrantPolicy.pick({ defaultTier: true, allowedSenders: true, mentionOnly: true });
export type ChannelGrantDeclaration = z.infer<typeof ChannelGrantDeclaration>;

/**
 * §3.2: the Owner's declaration that a channel exists and how it is mounted.
 * `settings` carries only non-secret knobs; the credential is a vault
 * reference, never inline. `enabled: false` unmounts the stage without
 * deleting the declaration.
 */
export const ChannelInstance = z
  .object({
    id: ChannelInstanceId,
    provider: z.string().min(1),
    /** #1569: which account this instance speaks as; rows declared before the axis existed are bot instances. */
    identity: Channel.Identity.default("bot"),
    enabled: z.boolean(),
    settings: z.record(z.string(), PlainValueSchema),
    credentialRef: SecretId.optional(),
    grant: GrantPolicy.optional(),
    revision: z.number().int().nonnegative(),
    createdBy: z.string().min(1),
    updatedAt: EpochMs,
  })
  .strict();
export type ChannelInstance = z.infer<typeof ChannelInstance>;

const SecretPurpose = z.enum(["channel_credential", "webhook_secret"]);

/**
 * §3.3 vault row: envelope-encrypted ciphertext only. `ciphertext` and
 * `wrappedDek` are packed AES-256-GCM blobs (12-byte IV ‖ 16-byte auth tag ‖
 * data); the DEK is per-secret and wrapped by the KEK named in `kekId`.
 * Plaintext has no field here by construction — the schema is the §8.2 law.
 */
export const Secret = z
  .object({
    id: SecretId,
    ciphertext: z.instanceof(Uint8Array),
    wrappedDek: z.instanceof(Uint8Array),
    kekId: z.string().min(1),
    purpose: SecretPurpose,
    createdAt: EpochMs,
    rotatedAt: EpochMs.optional(),
  })
  .strict();
export type Secret = z.infer<typeof Secret>;

const StoreErrorCode = z.enum([
  /** Durable writes fail closed when the sub-adapter is missing. */
  "adapter_absent",
  /** §8.8: a second `trustTier: "owner"` Person is a typed refusal, never a silent overwrite. */
  "owner_exists",
]);

/** Typed failure taxonomy for durable provisioning persistence. Callers branch on `data.code`. */
export const StoreError = NamedError.create(
  "ProvisioningStoreError",
  z.object({
    message: z.string(),
    code: StoreErrorCode,
    id: z.string().min(1).optional(),
  }),
);
export type StoreError = InstanceType<typeof StoreError>;

const VaultErrorCode = z.enum([
  /** §8.4: no usable KEK — dependent channels do not mount; loopback ws stays up. */
  "vault_locked",
  /** Ciphertext or wrapped DEK failed authentication/shape under the presented KEK. */
  "unopenable",
  /** The row was sealed under a different KEK than the one presented. */
  "kek_mismatch",
]);

/** Typed vault failure: decrypt problems are refusals, never silent empty credentials. */
export const VaultError = NamedError.create(
  "ProvisioningVaultError",
  z.object({
    message: z.string(),
    code: VaultErrorCode,
    secretId: z.string().min(1).optional(),
  }),
);
export type VaultError = InstanceType<typeof VaultError>;
