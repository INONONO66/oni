import type { Channel } from "@oni/protocol";

/** Providers report availability; the composing gateway authenticates the reader. */
export type ProviderHistoryResult =
  | { readonly status: "ok"; readonly page: Channel.HistoryPage }
  | {
      readonly status: "refused";
      readonly reason: Exclude<Channel.HistoryRefusalReason, "owner_auth_required" | "invalid_request">;
    };

export type ProviderHistoryRoute = (
  query: Channel.HistoryQuery,
) => Promise<ProviderHistoryResult>;
