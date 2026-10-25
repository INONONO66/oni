import type { Channel, Gateway, Outbound } from "@oni/protocol";
import type { AttachmentFetch, EffectRunner, MediaResolver, PublishPort } from "../types.js";
import type { ProviderVoiceRoute } from "./voice.js";
import { z } from "zod";

/**
 * Existing-agent delivery through this provider, keyed by ActorEndpoint
 * externalId. Structurally identical to the router's `ChannelDeliveryRoute`
 * on purpose: the provider band may not import `src/router/` (S8 banding), so
 * the contract restates the seam and the composition root is where the two
 * meet. Every delivery carries the required gateway idempotency key and ONE
 * `Outbound.Payload` (#1497): the surface translates its parts and actions
 * into platform calls from the capabilities it declares below.
 */
export type ProviderDeliveryRoute = (
  externalId: string,
  payload: Outbound.Payload,
  idempotencyKey: string,
  conversation?: Gateway.Conversation,
) => Promise<Outbound.Receipt>;

/**
 * Typing toward an actor: `pulse` makes the platform show "composing" for the
 * window it allows, `everyMs` is how often the composition root repeats it
 * while a turn runs (telegram shows ~5 s, discord ~10 s). `open` resolves the
 * conversation once per turn so a DM pulse does not re-create its channel.
 * The surface never owns the loop.
 */
export interface ProviderTypingRoute {
  readonly everyMs: number;
  readonly open: (externalId: string, conversation?: Gateway.Conversation) => Promise<Gateway.Conversation>;
  readonly pulse: (conversation: Gateway.Conversation) => Promise<void>;
}

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

/** Platform upload limits a surface declares; translation refuses an oversize part or caption before anything is sent. */
export interface MediaLimits {
  readonly imageBytes: number;
  readonly fileBytes: number;
  readonly audioBytes: number;
  readonly videoBytes: number;
  readonly captionLength: number;
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
  /**
   * Image and file parts upload as platform attachments. Where false, a
   * media part stays visible as its reference line inside the text.
   */
  readonly media: MediaLimits | false;
  /**
   * A `react` payload adds the emoji on the named message, swapping out the
   * sender's earlier one when `replaces` names it; a reaction already in the
   * requested state is accepted, so a replayed send changes nothing. Where
   * false, the surface refuses it with a rejected receipt instead of text.
   */
  readonly react: boolean;
  /** The runtime exposes `typingRoute`. */
  readonly typing: boolean;
  /** The runtime exposes `voiceRoute`: a call joins a voice channel and exchanges PCM with one speaker. */
  readonly voice: boolean;
}

/**
 * One constructed channel instance: the surface plus its optional seams. The
 * seams mirror `ProviderCapabilities` — a provider declaring `deliver` MUST
 * return `deliveryRoute`, one declaring `webhook` MUST return
 * `webhookHandler`, and one declaring neither returns neither. The provider
 * conformance suite enforces the correspondence.
 */
/** The platform identity of the account a runtime speaks as (#1600): what the Owner Person's endpoint on that platform is. */
export interface AccountIdentity {
  readonly externalId: string;
  readonly workspace?: string;
}

export interface ProviderRuntime {
  readonly surface: Channel.Surface;
  readonly deliveryRoute?: ProviderDeliveryRoute;
  readonly typingRoute?: ProviderTypingRoute;
  readonly webhookHandler?: (request: Request) => Promise<Response>;
  /** #1600: the account this runtime speaks as, known once the surface started; an Owner instance's is bound to the Owner Person. */
  readonly account?: () => AccountIdentity | undefined;
  /** The platform's authenticated download for the references its normalizer emits; absent when they are public URLs. */
  readonly attachments?: AttachmentFetch;
  /** Joins a voice channel on this started surface; present only where the provider declares voice. */
  readonly voiceRoute?: ProviderVoiceRoute;
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
/**
 * The Owner-identity arm of a provider (#1569): the same platform spoken as
 * the Owner's own account. Its credential is the account session the QR (or
 * remote-auth) login produced, never the bot's; its runtime mounts under
 * `<platform>:owner`. Only the capabilities an account can carry are
 * declared — there is no webhook arm, and typing is the platform's own.
 */
export interface OwnerArm<TCredentials> {
  readonly credentials: z.ZodType<TCredentials, TCredentials>;
  readonly preconditions: readonly string[];
  readonly capabilities: Pick<ProviderCapabilities, "deliver" | "react" | "media" | "typing" | "voice">;
  /** Whether the account's own listener exists (#1569 lane 6); where false the instance only sends. */
  readonly listen: boolean;
  create(
    credentials: TCredentials,
    posture: OwnerPosture,
    publish: PublishPort,
    options: ProviderOptions,
  ): ProviderRuntime;
}

/**
 * The Owner instance's declared intake (#1569 lane 6, `ChannelInstance.settings`
 * of an `identity: owner` row): what the account's listener hands to the
 * Resident. `mentions_and_dms` (the default) is a DM to the Owner or a
 * mention of the Owner; `all` is everything the account can see, the bot
 * posture; `none` mounts no listener at all. The account's own messages are
 * never an outside event; reactions are not intake.
 */
export const OwnerPosture = z
  .object({
    intake: z.enum(["mentions_and_dms", "all", "none"]).default("mentions_and_dms"),
    /**
     * #1569 lane 7: whether the reply door may answer a conversation through
     * this account on its own. False (the default) keeps the Resident's
     * answer a draft the Owner sends; it needs `grant.outbound` as well.
     * Meaningless where a bot instance of the platform answers.
     */
    autoReply: z.boolean().default(false),
  })
  .strict();
export type OwnerPosture = z.infer<typeof OwnerPosture>;

export interface ChannelProvider<TCredentials, TId extends string = string, TOwner = never> {
  readonly id: TId;
  readonly ingest: IngestMode;
  readonly capabilities: ProviderCapabilities;
  /** The Owner-account arm where the platform has one; absent, an `identity: owner` declaration is unsupported. */
  readonly owner?: OwnerArm<TOwner>;
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
   * time or entropy — and the media resolver that turns an outbound
   * image/file reference into bytes (absent: media parts fall back to text).
   */
  create(
    credentials: TCredentials,
    config: Channel.Config,
    publish: PublishPort,
    options: ProviderOptions,
  ): ProviderRuntime;
}

/** The injected sources every driver constructs from. */
export interface ProviderOptions {
  readonly now: () => number;
  readonly id: () => string;
  readonly random: () => number;
  /** Executes driver Effect programs (retry, reconnect, heartbeat) on the app runtime. */
  readonly run: EffectRunner;
  readonly media?: MediaResolver;
}
