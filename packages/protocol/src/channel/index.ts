/**
 * Channel — the band-facing DRIVER contract (#499, renamed from Adapter).
 *
 * This is the {protocol, ipc}-implementable, import-free vocabulary a channel
 * driver (Discord/Telegram/GitHub surface in the app) speaks: normalize a
 * platform payload into an in-process envelope, hand it to one handler, start
 * and stop. It is DISTINCT from the gateway↔brain seam (`Gateway.Deliver` /
 * `Gateway.Send*`), which is the stage-3 outbound/inbound successor.
 *
 * Disambiguation — both are wire-format words, the namespaces disambiguate:
 *   - `Channel.InboundMessage`: the driver's in-process envelope (plain TS
 *     interface, never persisted, never crosses a process boundary).
 *   - `Gateway.InboundMessage`: the gateway→brain zod delivery schema
 *     (gateway/schema.ts), validated at the trust boundary.
 */
import { z } from "zod";
import { NamedError } from "../error/index.js";
import * as History from "./history.js";

/**
 * Typed refusal for a malformed or empty surface key: the wire-format
 * invariant lives in `Channel.SurfaceKey`, and every violation is this one
 * concern regardless of which validator caught it.
 */
export const SurfaceKeyError = NamedError.create(
  "SurfaceKeyError",
  z.object({ message: z.string() }),
);
export type SurfaceKeyError = InstanceType<typeof SurfaceKeyError>;

export namespace Channel {
  export const HistoryAttachment = History.HistoryAttachment;
  export type HistoryAttachment = History.HistoryAttachment;
  export const HistoryMessage = History.HistoryMessage;
  export type HistoryMessage = History.HistoryMessage;
  export const HistoryPage = History.HistoryPage;
  export type HistoryPage = History.HistoryPage;
  export const HistoryQuery = History.HistoryQuery;
  export type HistoryQuery = History.HistoryQuery;
  export const HistoryRequest = History.HistoryRequest;
  export type HistoryRequest = History.HistoryRequest;
  export const HistoryRefusalReason = History.HistoryRefusalReason;
  export type HistoryRefusalReason = History.HistoryRefusalReason;
  export const HistoryRefused = History.HistoryRefused;
  export type HistoryRefused = History.HistoryRefused;
  export const HistoryResponse = History.HistoryResponse;
  export type HistoryResponse = History.HistoryResponse;

  /**
   * The identity a mounted instance speaks as (#1569): the bot account, or the
   * Owner's own account. A surface's id is `<platform>:<identity>` for the
   * messenger instances; identity-less surfaces (ws, github, webhook) keep
   * their platform id and are reached as the bot.
   */
  export const Identity = z.enum(["bot", "owner"]);
  export type Identity = z.infer<typeof Identity>;

  /** The surface id one `(platform, identity)` instance mounts under. */
  export function instanceId(platform: string, identity: Identity): string {
    return `${platform}:${identity}`;
  }

  export interface InboundMessage {
    sender: import("../gateway/index.js").Gateway.IngestSender & { kind: "external" };
    facts: import("../gateway/index.js").Gateway.IngressFacts;
  }

  export type MessageHandler = (message: InboundMessage) => Promise<void>;

  export type Config = Record<string, never>;

  export interface Surface {
    readonly id: string;
    readonly config: Config;

    start(traceId: string): Promise<void>;
    stop(traceId: string): void;

    onMessage(handler: MessageHandler): void;
  }

  /**
   * Pure string codec for surface keys — the wire vocabulary channel
   * drivers and routing share. Moved here from the old ledger package (#499
   * precursor): the codec is channel vocabulary; storage semantics
   * (register/claim/lookup) stay in the session surface-key store, which
   * imports this codec for format validation.
   *
   * Key format: `<surface-type>:<surface-specific-path>`
   *
   * Channel/peer kind encoding:
   *   - DM:      slack:workspaceA:dm:U123
   *   - Group:   slack:workspaceA:group:C123
   *   - Thread:  slack:workspaceA:group:C123:thread:171000
   *   - Channel: slack:workspaceA:channel:C123
   *   - TUI:     tui:/srv/workspaces/example
   *   - Chat:    telegram:botId:chat:chatId
   */
  export namespace SurfaceKey {
    // "thread" is NOT a kind: threads are sub-keys under a channel (the
    // `:thread:<id>` marker pair) — see the encoding examples above.
    export type ChannelKind = "dm" | "group" | "channel" | "chat";

    export interface ChannelDescriptor {
      /** Surface type (e.g., "slack", "telegram", "tui") */
      surface: string;
      /** Namespace/workspace/bot identifier */
      namespace: string;
      kind: ChannelKind;
      id: string;
      /** Optional thread identifier (creates a sub-key under the channel) */
      threadId?: string;
    }

    /**
     * Assert the surfaceKey wire-format invariant. The single validation
     * authority: `create` and the session store's register/claim call this.
     * @returns the key unchanged when well-formed
     */
    export function assertWellFormed(key: string): string {
      if (!key.includes(":")) {
        throw new SurfaceKeyError({
          message: `Invalid surfaceKey format: "${key}". Must include surface type prefix (e.g., "slack:...")`,
        });
      }
      return key;
    }

    /**
     * Create a surfaceKey from parts.
     * @param parts - Array of strings to join with colons
     * @returns Formatted surfaceKey
     * @throws Error if parts is empty or validation fails
     */
    export function create(parts: string[]): string {
      if (parts.length === 0) {
        throw new SurfaceKeyError({ message: "SurfaceKey parts cannot be empty" });
      }

      return assertWellFormed(parts.join(":"));
    }

    export function fromChannel(descriptor: ChannelDescriptor): string {
      const parts = [descriptor.surface, descriptor.namespace, descriptor.kind, descriptor.id];
      if (descriptor.threadId) {
        parts.push("thread", descriptor.threadId);
      }
      return create(parts);
    }
  }
}
