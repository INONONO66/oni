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

import type { ChannelProvider, EffectRunner, MediaResolver, ProviderDeliveryRoute } from "@openomni/channels";
import { ChannelProviders, createWebhookProvider } from "@openomni/channels";
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
  /** Ingress seam: present only for webhook-fed channels. */
  readonly webhookHandler?: (request: Request) => Promise<Response>;
}

export interface ChannelComponent {
  readonly id: keyof typeof ChannelProviders;
  /** Constructs the surface and binds the Resident handler. Called once per boot. */
  build(handler: Channel.MessageHandler): BuiltChannel;
}

/**
 * One row: construct the provider runtime with the installation's typed
 * credential and bind the Resident handler. Credential admission happens
 * through the provider schema when the declared vault payload is opened.
 */
function providerRow<TCredentials, TId extends keyof typeof ChannelProviders>(
  provider: ChannelProvider<TCredentials, TId>,
  credentials: TCredentials,
  config: Channel.Config,
  deps: ChannelRuntimeDeps,
): ChannelComponent {
  return {
    id: provider.id,
    build(handler) {
      const runtime = provider.create(credentials, config, deps.publish, {
        now: deps.now,
        id: deps.id,
        random: deps.random,
        run: deps.run,
        ...(deps.media === undefined ? {} : { media: deps.media }),
      });
      runtime.surface.onMessage(handler);
      return {
        surface: runtime.surface,
        ...(runtime.deliveryRoute === undefined ? {} : { deliveryRoute: runtime.deliveryRoute }),
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
  provider: ChannelProvider<TCredentials, TId>,
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
  return providerRow(provider, parsed.data, {}, deps);
}

function declaredRow(
  key: keyof typeof ChannelProviders,
  plaintext: Uint8Array,
  providers: typeof ChannelProviders,
  deps: ChannelRuntimeDeps,
  readCredential: CredentialReader,
): ChannelComponent | { readonly invalid: string } {
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
): string | undefined {
  if (!isRegisteredProvider(provider)) {
    return `unknown provider ${provider}`;
  }
  const parsed = ChannelProviders[provider].credentials.safeParse(payload);
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
  settings: Record<string, string | number | boolean>,
): string | undefined {
  if (!isRegisteredProvider(provider)) {
    return `unknown provider ${provider}`;
  }
  const parsed = ChannelProviders[provider].settings.safeParse(settings);
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
      instance.provider,
      credential.plaintext,
      providers,
      deps,
      readCredential,
    );
    if ("invalid" in row) {
      record(instance, "credential_invalid", row.invalid);
      continue;
    }
    record(instance, "ready");
    rows.push({ instanceId: instance.id, component: row });
  }

  return { rows, statuses };
}
