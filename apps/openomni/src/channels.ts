/**
 * Channel profile — the declarative row list of external channel components.
 *
 * Each configured channel is one row: a provider from the shipped registry
 * plus the credential payload and trigger policy this installation mounts it
 * with. The profile is data — boot mounts each row as its own composition
 * stage, so what the app composes is readable here in one place, and
 * disposing a stage revokes exactly that channel's listening, deliverability,
 * and trusted-channel authority.
 *
 * A row exists only for a configured channel. There is no disabled-row state
 * and no default credential — absence of config is absence of the component.
 */

import type { ChannelProvider, EffectRunner, MediaResolver, OwnerArm, ProviderDeliveryRoute, ProviderTypingRoute } from "@openomni/channels";
import { ChannelProviders, createWebhookProvider, OwnerPosture } from "@openomni/channels";
import type { BusEvent, Channel, PlainValue, Provisioning } from "@openomni/protocol";
import { Result } from "effect";

/**
 * Injected runtime seams for provider construction (#1245): observation
 * publish plus wall clock, UUID source, and jitter source — drivers never
 * reach for a process singleton or ambient time/entropy.
 */
export interface ChannelRuntimeDeps {
  readonly publish: BusEvent.Sink["publish"];
  readonly now: () => number;
  readonly id: () => string;
  readonly random: () => number;
  /** Executes driver Effect programs (retry schedules, reconnect fibers, deadlines) on the app runtime. */
  readonly run: EffectRunner;
  /** Resolves an image or file part's reference to bytes at delivery time; absent, media parts stay as reference lines. */
  readonly media?: MediaResolver;
}

export interface BuiltChannel {
  readonly surface: Channel.Surface;
  /** Outbound seam, keyed by `surface.id`: present only for channels the Resident can message into. */
  readonly deliveryRoute?: ProviderDeliveryRoute;
  readonly typingRoute?: ProviderTypingRoute;
  /** Ingress seam: present only for webhook-fed channels. */
  readonly webhookHandler?: (request: Request) => Promise<Response>;
}

export interface ChannelComponent {
  readonly id: keyof typeof ChannelProviders;
  /** The account this instance speaks as (#1569); the surface mounts under `<id>:<identity>`. */
  readonly identity: Channel.Identity;
  /**
   * Whether this instance reads inbound (#1569 lane 6): every bot instance
   * does; an Owner instance only under an intake posture on an arm that
   * listens. A reading instance needs the platform's ingress grant.
   */
  readonly listens: boolean;
  /** Constructs the surface and binds the Resident handler. Called once per boot. */
  build(handler: Channel.MessageHandler): BuiltChannel;
}

type RuntimeFactory = (options: Parameters<ChannelProvider<never>["create"]>[3]) => ProviderRuntime;
type ProviderRuntime = ReturnType<ChannelProvider<never>["create"]>;

/**
 * One row: construct the provider runtime with the installation's typed
 * credential and bind the Resident handler. Credential admission happens
 * through the provider schema when the declared vault payload is opened.
 */
function providerRow(
  id: keyof typeof ChannelProviders,
  identity: Channel.Identity,
  listens: boolean,
  create: RuntimeFactory,
  deps: ChannelRuntimeDeps,
  /** #1569: an Owner instance without a declared outbound grant mounts no delivery route. */
  outbound = true,
): ChannelComponent {
  return {
    id,
    identity,
    listens,
    build(handler) {
      const runtime = create({
        now: deps.now,
        id: deps.id,
        random: deps.random,
        run: deps.run,
        ...(deps.media === undefined ? {} : { media: deps.media }),
      });
      runtime.surface.onMessage(handler);
      return {
        surface: runtime.surface,
        ...(runtime.deliveryRoute === undefined || !outbound ? {} : { deliveryRoute: runtime.deliveryRoute }),
        ...(runtime.typingRoute === undefined || !outbound ? {} : { typingRoute: runtime.typingRoute }),
        ...(runtime.webhookHandler === undefined ? {} : { webhookHandler: runtime.webhookHandler }),
      };
    },
  };
}

type DeclaredChannelState =
  | "ready"
  | "disabled"
  | "vault_locked"
  | "unknown_provider"
  | "identity_unsupported"
  | "missing_credential"
  | "credential_invalid";

/** Per-declaration reconcile verdict — the honest boot record of why a row did or did not mount. */
export interface DeclaredChannelStatus {
  readonly id: string;
  readonly provider: string;
  readonly state: DeclaredChannelState;
  readonly detail?: string;
}

/** Vault read seam: `locked` covers both a missing/unusable KEK and a missing/unopenable row. */
export type CredentialReader = (
  ref: string,
) => { kind: "ok"; plaintext: Uint8Array } | { kind: "locked"; reason: string };

/**
 * Vault plaintexts are JSON credential payloads. The provider's own
 * `credentials` schema is THE validation layer for DB-sourced credentials —
 * the trust boundary where ciphertext from the provisioning store becomes
 * the provider's typed credential.
 */
function credentialRow<TCredentials, TId extends keyof typeof ChannelProviders>(
  provider: Pick<ChannelProvider<TCredentials, TId>, "id" | "credentials" | "create">,
  plaintext: Uint8Array,
  deps: ChannelRuntimeDeps,
): ChannelComponent | { readonly invalid: string } {
  const decoded = Result.try({
    try: (): PlainValue => JSON.parse(new TextDecoder().decode(plaintext)),
    catch: String,
  });
  if (Result.isFailure(decoded)) {
    return { invalid: `credential payload is not JSON (${decoded.failure})` };
  }
  const parsed = provider.credentials.safeParse(decoded.success);
  if (!parsed.success) return { invalid: parsed.error.message };
  return providerRow(
    provider.id,
    "bot",
    true,
    (options) => provider.create(parsed.data, {}, deps.publish, options),
    deps,
  );
}

/**
 * The Owner-identity row (#1569): the provider's `owner` arm validates the
 * account session and builds the `<platform>:owner` surface under the
 * declaration's intake posture (`settings.intake`, lane 6); the delivery
 * route mounts only when the declaration's `grant.outbound` says so, and
 * the instance reads inbound only when the arm listens under a posture.
 */
function ownerRow<TOwner>(
  provider: { readonly id: keyof typeof ChannelProviders; readonly owner?: OwnerArm<TOwner> },
  plaintext: Uint8Array,
  settings: Provisioning.ChannelInstance["settings"],
  deps: ChannelRuntimeDeps,
  outbound: boolean,
): ChannelComponent | { readonly invalid: string } | { readonly unsupported: string } {
  const arm = provider.owner;
  if (arm === undefined) return { unsupported: `${provider.id} has no Owner-account arm` };
  const decoded = Result.try({
    try: (): PlainValue => JSON.parse(new TextDecoder().decode(plaintext)),
    catch: String,
  });
  if (Result.isFailure(decoded)) {
    return { invalid: `credential payload is not JSON (${decoded.failure})` };
  }
  const parsed = arm.credentials.safeParse(decoded.success);
  if (!parsed.success) return { invalid: parsed.error.message };
  const posture = OwnerPosture.safeParse(settings);
  if (!posture.success) return { invalid: `settings: ${posture.error.message}` };
  return providerRow(
    provider.id,
    "owner",
    arm.listen && posture.data.intake !== "none",
    (options) => arm.create(parsed.data, posture.data, deps.publish, options),
    deps,
    outbound,
  );
}

function declaredRow(
  instance: Provisioning.ChannelInstance & { readonly provider: keyof typeof ChannelProviders },
  plaintext: Uint8Array,
  providers: typeof ChannelProviders,
  deps: ChannelRuntimeDeps,
  readCredential: CredentialReader,
): ChannelComponent | { readonly invalid: string } | { readonly unsupported: string } {
  const key = instance.provider;
  if (instance.identity === "owner") {
    return ownerRow(providers[key], plaintext, instance.settings, deps, instance.grant?.outbound === true);
  }
  if (key === "telegram") {
    return credentialRow(providers.telegram, plaintext, deps);
  }
  if (key === "discord") {
    return credentialRow(providers.discord, plaintext, deps);
  }
  if (key === "slack") {
    return credentialRow(providers.slack, plaintext, deps);
  }
  if (key === "webhook") {
    // Webhook has no static secret in the row's own credential payload: the
    // signing secret lives behind `secretRef` and is only resolvable through
    // the vault, so this is the one provider built fresh here rather than
    // taken from the shipped `providers` registry.
    const resolveSecret = async (ref: string) => {
      const secret = readCredential(ref);
      return secret.kind === "ok" ? new TextDecoder().decode(secret.plaintext) : undefined;
    };
    return credentialRow(createWebhookProvider(resolveSecret), plaintext, deps);
  }
  return credentialRow(providers.github, plaintext, deps);
}

export function isRegisteredProvider(provider: string): provider is keyof typeof ChannelProviders {
  return provider in ChannelProviders;
}

/**
 * The pre-persist credential gate for `channel_add`/`secret_rotate`
 * (docs/provisioning-and-providers.md §5): the payload must parse under the
 * provider's credential schema BEFORE any row lands — an invalid credential
 * is a typed refusal string, and nothing is sealed or mounted.
 */
export function validateProviderCredential(
  provider: string,
  payload: Record<string, string>,
  identity: Channel.Identity = "bot",
): string | undefined {
  if (!isRegisteredProvider(provider)) {
    return `unknown provider ${provider}`;
  }
  const registered = ChannelProviders[provider];
  // #1569: an Owner-account credential parses under the provider's owner arm.
  const schema = identity === "owner" ? registered.owner?.credentials : registered.credentials;
  if (schema === undefined) return `${provider} has no Owner-account arm`;
  const parsed = schema.safeParse(payload);
  return parsed.success ? undefined : parsed.error.message;
}

/**
 * The pre-persist settings gate for `channel_add`: knobs must parse under
 * the provider's `settings` schema before the row lands. No shipped provider
 * carries knobs yet, so any settings key is a typed refusal — never
 * accepted-and-ignored.
 */
export function validateProviderSettings(
  provider: string,
  settings: Provisioning.ChannelInstance["settings"],
  identity: Channel.Identity = "bot",
): string | undefined {
  if (!isRegisteredProvider(provider)) {
    return `unknown provider ${provider}`;
  }
  // #1569 lane 6: an Owner instance's knobs are its intake posture.
  const schema = identity === "owner" ? OwnerPosture : ChannelProviders[provider].settings;
  const parsed = schema.safeParse(settings);
  return parsed.success ? undefined : parsed.error.message;
}

/** A declaration the profile could mount: the instance it came from plus its built row. */
export interface DeclaredChannelRow {
  readonly instanceId: string;
  readonly component: ChannelComponent;
}

/**
 * The declared path (docs/provisioning-and-providers.md §8.1): one row per
 * ChannelInstance declaration, credentials opened through the vault seam.
 * Fail-closed per row — a declaration that cannot mount is a status, never a
 * half-wired driver, and never a reason to stop the rest of the boot (§8.4:
 * the credential-less loopback surface must survive a locked vault).
 */
export function declaredChannelProfile(
  instances: readonly Provisioning.ChannelInstance[],
  readCredential: CredentialReader,
  deps: ChannelRuntimeDeps,
  providers: typeof ChannelProviders = ChannelProviders,
): { rows: DeclaredChannelRow[]; statuses: DeclaredChannelStatus[] } {
  const rows: DeclaredChannelRow[] = [];
  const statuses: DeclaredChannelStatus[] = [];
  const record = (
    instance: Provisioning.ChannelInstance,
    state: DeclaredChannelState,
    detail?: string,
  ) => {
    statuses.push({
      id: instance.id,
      provider: instance.provider,
      state,
      ...(detail === undefined ? {} : { detail }),
    });
  };

  for (const instance of instances) {
    if (!instance.enabled) {
      record(instance, "disabled");
      continue;
    }
    if (!isRegisteredProvider(instance.provider)) {
      record(instance, "unknown_provider");
      continue;
    }
    if (instance.credentialRef === undefined) {
      record(instance, "missing_credential");
      continue;
    }
    const credential = readCredential(instance.credentialRef);
    if (credential.kind === "locked") {
      record(instance, "vault_locked", credential.reason);
      continue;
    }
    const row = declaredRow(
      { ...instance, provider: instance.provider },
      credential.plaintext,
      providers,
      deps,
      readCredential,
    );
    if ("unsupported" in row) {
      record(instance, "identity_unsupported", row.unsupported);
      continue;
    }
    if ("invalid" in row) {
      record(instance, "credential_invalid", row.invalid);
      continue;
    }
    record(instance, "ready");
    rows.push({ instanceId: instance.id, component: row });
  }

  return { rows, statuses };
}
