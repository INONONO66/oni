import type { Channel, Gateway } from "@openomni/protocol";
import type { EffectRunner } from "../types.js";
import type { z } from "zod";
import type { PublishPort } from "../types.js";

/**
 * Existing-agent delivery through this provider, keyed by ActorEndpoint
 * externalId. Structurally identical to the router's `ChannelDeliveryRoute`
 * on purpose: the provider band may not import `src/router/` (S8 banding), so
 * the contract restates the seam and the composition root is where the two
 * meet. Every delivery carries the required gateway idempotency key.
 */
export type ProviderDeliveryRoute = (
  externalId: string,
  body: string,
  idempotencyKey: string,
  conversation?: Gateway.Conversation,
) => Promise<{
  readonly value: "accepted" | "rejected" | "unknown";
  readonly externalMessageId?: string;
}>;

/**
 * How a provider receives platform events. The runner does not interpret the
 * mode — each provider's surface owns its transport — but the mode is part of
 * the declared contract so composition and docs state it instead of readers
 * reverse-engineering it from the driver.
 *
 * - `poll`    — the surface polls the platform API (telegram).
 * - `socket`  — the surface holds an outbound socket the platform pushes
 *               through (discord gateway, slack Socket Mode).
 * - `webhook` — the platform calls into `ProviderRuntime.webhookHandler`
 *               (github).
 */
type IngestMode = "poll" | "socket" | "webhook";

/**
 * Outbound text policy the provider's surface applies before sending: the
 * markdown dialect mapping and the hard per-message length it chunks to.
 * Declared here and consumed by the surface itself (each driver's
 * `format.ts` is the single source), so composition and docs read the
 * policy instead of reverse-engineering the send path.
 */
export interface RenderPolicy {
  /**
   * Maps Resident markdown to the platform dialect; identity where the
   * platform accepts the text as-is (slack mrkdwn, github comments).
   */
  readonly renderMarkdown: (markdown: string) => string;
  /**
   * Hard per-message length the surface chunks outbound text to. `null`
   * where the driver enforces no limit (github comments).
   */
  readonly messageLimit: number | null;
}

/**
 * What a provider's runtime exposes, declared statically so composition and
 * conformance tests can check the runtime against the declaration instead of
 * duck-typing the constructed object.
 */
interface ProviderCapabilities {
  /** The runtime exposes `deliveryRoute` — the Resident can message into it. */
  readonly deliver: boolean;
  /** The runtime exposes `webhookHandler` — ingress arrives over HTTP. */
  readonly webhook: boolean;
  /** Outbound text policy the surface applies (dialect + chunk limit). */
  readonly render: RenderPolicy;
}

/**
 * One constructed channel instance: the surface plus its optional seams. The
 * seams mirror `ProviderCapabilities` — a provider declaring `deliver` MUST
 * return `deliveryRoute`, one declaring `webhook` MUST return
 * `webhookHandler`, and one declaring neither returns neither. The provider
 * conformance suite enforces the correspondence.
 */
export interface ProviderRuntime {
  readonly surface: Channel.Surface;
  readonly deliveryRoute?: ProviderDeliveryRoute;
  readonly webhookHandler?: (request: Request) => Promise<Response>;
}

/**
 * The uniform channel driver contract. A provider is data plus one
 * constructor: adding a platform means implementing this interface and
 * registering it — composition code never grows a platform-specific branch.
 *
 * Providers stay in the driver sub-band: protocol types, their own transport,
 * and the injected `PublishPort` only. Authority (grants, blacklist, tiers,
 * admission) remains router-side.
 */
export interface ChannelProvider<TCredentials, TId extends string = string> {
  readonly id: TId;
  readonly ingest: IngestMode;
  readonly capabilities: ProviderCapabilities;
  /**
   * THE schema for this provider's secret payload — the app's credential
   * gates (boot declared rows, `channel_add`/`secret_rotate`) validate
   * against this declaration instead of owning a parallel table. Shapes are
   * genuinely heterogeneous by platform (telegram: one token; slack: two).
   */
  readonly credentials: z.ZodType<TCredentials, TCredentials>;
  /**
   * Non-secret instance knobs. No shipped provider carries knobs yet, so
   * every schema is the empty record (`z.record(z.never())`) — the seam
   * exists so `ChannelInstance.settings` is validated where it enters
   * (`channel_add`) instead of accepted-and-ignored.
   */
  readonly settings: z.ZodType<Record<string, never>, Record<string, never>>;
  /**
   * Operator checklist the credential cannot carry and the runner cannot
   * verify — portal-side switches (Discord gateway intents, Slack app
   * scopes). `provision` op `status` reports these verbatim; nothing enforces
   * them (they fail loudly at the platform, not here).
   */
  readonly preconditions: readonly string[];
  /**
   * Constructs the surface and seams. Pure construction — no I/O until
   * `surface.start()`. `TCredentials` is this provider's typed secret
   * material, heterogeneous by design (telegram: one bot token; github: a
   * webhook secret plus optional API token). Validation stays where the
   * credential enters the system (the provisioning store's `channel_add`/
   * `secret_rotate` gate) — one enforcement layer per invariant, so the
   * contract takes the already-trusted typed value. `options` injects the
   * wall clock, UUID source, and jitter source — drivers never read ambient
   * time or entropy.
   */
  create(
    credentials: TCredentials,
    config: Channel.Config,
    publish: PublishPort,
    options: {
      readonly now: () => number;
      readonly id: () => string;
      readonly random: () => number;
      /** Executes driver Effect programs (retry, reconnect, heartbeat) on the app runtime. */
      readonly run: EffectRunner;
    },
  ): ProviderRuntime;
}
