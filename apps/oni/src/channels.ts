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

import type { AccountIdentity, ChannelProvider, EffectRunner, MediaResolver, OwnerArm, ProviderDeliveryRoute, ProviderTypingRoute } from "@oni/channels";
import { A2ACredentials, ChannelProviders, createA2AProvider, createWebhookProvider, OwnerPosture } from "@oni/channels";
import type { BusEvent, Channel, PlainValue, Provisioning } from "@oni/protocol";
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
  /** #1569 lane 7: an Owner instance whose declaration lets the reply door answer through the account. */
  readonly autoReply?: boolean;
  /** Outbound seam, keyed by `surface.id`: present only for channels the Resident can message into. */
  readonly deliveryRoute?: ProviderDeliveryRoute;
  readonly typingRoute?: ProviderTypingRoute;
  /** Ingress seam: present only for webhook-fed channels. */
  readonly webhookHandler?: (request: Request) => Promise<Response>;
  /** #1600: the account the runtime speaks as, known after start; an Owner instance's becomes the Owner Person's endpoint. */
  readonly account?: () => AccountIdentity | undefined;
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
  /** #1600 lane R3: the key the webhook table holds this instance's handler under; absent, the platform's. */
  readonly webhookKey?: string;
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
  /** #1569 lane 7: an Owner instance whose posture lets the reply door answer through the account. */
  autoReply = false,
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
        ...(autoReply && outbound ? { autoReply: true } : {}),
        ...(runtime.deliveryRoute === undefined || !outbound ? {} : { deliveryRoute: runtime.deliveryRoute }),
        ...(runtime.typingRoute === undefined || !outbound ? {} : { typingRoute: runtime.typingRoute }),
        ...(runtime.webhookHandler === undefined ? {} : { webhookHandler: runtime.webhookHandler }),
        ...(runtime.account === undefined ? {} : { account: runtime.account }),
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
function ownerRow(
  provider: (typeof ChannelProviders)[keyof typeof ChannelProviders],
  plaintext: Uint8Array,
  settings: Provisioning.ChannelInstance["settings"],
  deps: ChannelRuntimeDeps,
  outbound: boolean,
): ChannelComponent | { readonly invalid: string } | { readonly unsupported: string } {
  // Each platform's arm carries its own credential type; the arm's schema is
  // what admits the vault payload, so the row reads it as plain data.
  const arm = provider.owner as OwnerArm<PlainValue> | undefined;
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
    posture.data.autoReply,
  );
}

/** What the A2A door says about this agent; the url is the door a request came through. */
const A2A_CARD = {
  name: "Oni Resident",
  description: "One Resident, delegating through durable contracts and evidence.",
  // The app's own version (apps/oni/package.json); the card is the one place it is published.
  version: "0.1.0",
};

/** The one A2A door's row id (#1569 lane 9c): mounted while any a2a peer is declared; never a declaration itself. */
export const A2A_DOOR_ID = "channel:a2a";

/** A declared peer's bearer as the door's roster holds it. */
export type A2ARoster = () => Promise<readonly { readonly id: string; readonly token: string }[]>;

/**
 * The declared A2A roster (#1569 lane 9c): every enabled a2a declaration's
 * bearer, the declarations listed and each credential read from the vault
 * at request time, so a peer declared, disabled or rotated mid-run is
 * admitted — or not — by the one door without a remount.
 */
export function a2aRoster(
  list: () => readonly Provisioning.ChannelInstance[],
  readCredential: CredentialReader,
): A2ARoster {
  return async () =>
    list().flatMap((row) => {
      if (row.provider !== "a2a" || row.identity !== "bot" || !row.enabled || row.credentialRef === undefined) return [];
      const opened = readCredential(row.credentialRef);
      if (opened.kind !== "ok") return [];
      const decoded = Result.try({
        try: (): PlainValue => JSON.parse(new TextDecoder().decode(opened.plaintext)),
        catch: String,
      });
      if (Result.isFailure(decoded)) return [];
      const parsed = A2ACredentials.safeParse(decoded.success);
      return parsed.success ? [{ id: row.id.replace(/^channel:a2a:/, ""), token: parsed.data.token }] : [];
    });
}

/**
 * The one A2A door (#1569 lane 9c): every a2a declaration is a peer the
 * door admits from its roster, so the door is one row for all of them —
 * keyed by nothing a peer's revision or rotation changes, since the roster
 * is read at request time — and goes only when no peer is declared.
 */
function a2aDoor(roster: A2ARoster, deps: ChannelRuntimeDeps): ChannelComponent {
  const provider = createA2AProvider(roster, A2A_CARD);
  return providerRow(
    provider.id,
    "bot",
    true,
    // The provider contract hands a credential in; the door reads the roster, never this one.
    (options) => provider.create({ token: "roster" }, {}, deps.publish, options),
    deps,
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
  // #1569 lane 7 (and 9b for Linear, whose key is a person's): an Owner-only platform has no bot account to declare.
  if (key === "instagram" || key === "kakaotalk" || key === "linear") {
    return { unsupported: `${key} has no bot account; declare the instance with identity: owner` };
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
  if (key === "a2a") {
    // A peer declaration is admitted under the door's schema; the row it yields is discarded for the one door.
    return credentialRow(providers.a2a, plaintext, deps);
  }
  return credentialRow(providers.github, plaintext, deps);
}

export function isRegisteredProvider(provider: string): provider is keyof typeof ChannelProviders {
  return provider in ChannelProviders;
}

/**
 * Providers whose declared rows are contacts, not channels (#1512): a
 * `channel:cli:<id>` row names a machine the Resident's letters go to over
 * its pty. The row is declared through `channel_add` under Owner consent
 * and validated by the contact's own door; the profile mounts nothing for it.
 */
export const CONTACT_ONLY_PROVIDERS: ReadonlySet<string> = new Set(["cli"]);

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
  // The door's roster reads the live declarations when the caller has them; the profile's own otherwise.
  roster: A2ARoster = a2aRoster(() => instances, readCredential),
): { rows: DeclaredChannelRow[]; statuses: DeclaredChannelStatus[] } {
  const rows: DeclaredChannelRow[] = [];
  const statuses: DeclaredChannelStatus[] = [];
  let peers = 0;
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
    if (CONTACT_ONLY_PROVIDERS.has(instance.provider)) {
      record(instance, "ready", "contact row: reached over the machine pty, no channel component");
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
    // An a2a peer is a roster entry of the one door, not a row of its own.
    if (instance.provider === "a2a") {
      peers += 1;
      continue;
    }
    // #1600 lane R3: every webhook declaration is its own door, `/webhook/<slug>`, keyed like its outbound contact.
    const component =
      instance.provider === "webhook"
        ? { ...row, webhookKey: `webhook:${instance.id.slice("channel:webhook:".length)}` }
        : row;
    rows.push({ instanceId: instance.id, component });
  }
  if (peers > 0) rows.push({ instanceId: A2A_DOOR_ID, component: a2aDoor(roster, deps) });

  return { rows, statuses };
}
