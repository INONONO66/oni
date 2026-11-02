import type { Channel } from "@oni/protocol";

/** Providers report availability; the composing gateway authenticates the reader. */
export type ProviderHistoryResult =
  | { readonly status: "ok"; readonly page: Channel.HistoryPage }
  | {
      readonly status: "refused";
      readonly reason: "not_ready" | "session_in_use" | "session_lost" | "login_action_required" | "history_unavailable";
    };

export type ProviderHistoryRoute = (
  query: Channel.HistoryQuery,
) => Promise<ProviderHistoryResult>;
