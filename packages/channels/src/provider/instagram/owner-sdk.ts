import { InstagramClient, InstagramError, InstagramHybridListener } from "agent-messenger/instagram";
import type { InstagramHybridListenerEventMap, InstagramMessageSummary } from "agent-messenger/instagram";

/**
 * The slice of the agent-messenger Instagram SDK the Owner instance speaks
 * (#1569 lane 7): the account session the Owner's login produced, restored
 * from the vault; the inbox listener (realtime with a polling fallback);
 * sends into a thread or to a user. The SDK persists a session only where a
 * session path is set, so the surface restores through a file it removes
 * at once and then clears the path (`setSessionPath("")`): the vault stays
 * the one copy. The SDK classes satisfy these shapes structurally; tests
 * pass scripted fakes.
 */
export interface InstagramOwnerApi {
  loadSession(path: string): Promise<void>;
  setSessionPath(path: string): void;
  /** The account the restored session speaks as; `null` until a session is loaded. */
  getUserId(): string | null;
  sendMessage(threadId: string, text: string): Promise<{ id: string }>;
  /** Opens (or reuses) the direct thread with a user and posts into it. */
  sendMessageToUser(userPk: string, text: string): Promise<{ id: string }>;
}

/** One inbox message as the SDK summarizes it. */
export type InstagramMessage = InstagramMessageSummary;

/** The SDK's hybrid listener event map, re-exported so the surface never imports the SDK itself. */
export type InstagramOwnerEventMap = InstagramHybridListenerEventMap;

export interface InstagramOwnerEvents {
  on<K extends keyof InstagramHybridListenerEventMap>(
    event: K,
    listener: (...args: InstagramHybridListenerEventMap[K]) => void,
  ): this;
  start(): Promise<void>;
  stop(): void;
}

/** Construction seams: the real SDK in production, scripted fakes in tests. */
export interface InstagramOwnerSdk {
  client(): InstagramOwnerApi;
  listener(client: InstagramOwnerApi, options: { readonly pollInterval: number }): InstagramOwnerEvents;
}

export function instagramOwnerSdk(): InstagramOwnerSdk {
  return {
    client: () => new InstagramClient(),
    // The listener only ever receives the client this same factory built.
    listener: (client, options) =>
      new InstagramHybridListener(client as InstagramClient, { pollInterval: options.pollInterval }),
  };
}

/** The SDK's error class: `code` names the platform refusal (`rate_limited`, `send_failed`, `not_authenticated`, …). */
export { InstagramError as InstagramOwnerError };
