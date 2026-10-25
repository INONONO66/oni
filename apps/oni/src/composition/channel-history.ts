import type { OwnerWithdrawal, ProviderHistoryRoute } from "@oni/channels";
import { Channel, parseJson, PlainValueSchema } from "@oni/protocol";
import { Effect } from "effect";
import type { ChannelSupervisor } from "../bundles/provision/supervisor";

export interface ChannelHistoryAccess {
  readonly authenticated: boolean;
  readonly caller: "owner" | `session:${string}`;
}

export type ChannelHistoryLookup = (
  instanceId: string,
) =>
  | { readonly status: "ready"; readonly history: ProviderHistoryRoute }
  | { readonly status: "refused"; readonly reason: "owner_not_ready" | "history_unavailable" | OwnerWithdrawal };

/** A ready route serves; a withdrawn mount names its latched cause; a mounted one without history is unavailable. */
export function channelHistoryLookup(
  routes: ReadonlyMap<string, ProviderHistoryRoute>,
  supervisor: Pick<ChannelSupervisor, "status" | "withdrawal">,
): ChannelHistoryLookup {
  return (instanceId) => {
    const history = routes.get(instanceId);
    if (history !== undefined) return { status: "ready", history };
    const withdrawn = supervisor.withdrawal(instanceId);
    if (withdrawn !== undefined) return { status: "refused", reason: withdrawn };
    return {
      status: "refused",
      reason: supervisor.status().some((row) => row.surface === instanceId && row.state === "mounted")
        ? "history_unavailable" : "owner_not_ready",
    };
  };
}

const DETAILS = {
  owner_auth_required: "Owner authentication is required",
  owner_not_ready: "Channel instance is not ready",
  history_unavailable: "Channel history is unavailable",
  invalid_request: "Invalid channel history request",
  session_in_use: "Channel session is in use",
  session_lost: "Channel session was lost",
  login_action_required: "Channel login is required",
} satisfies Record<Channel.HistoryRefusalReason, string>;

function refused(
  requestId: string,
  reason: Channel.HistoryRefusalReason,
  instanceId?: string,
): Channel.HistoryRefused {
  return {
    type: "channel_history_refused",
    requestId,
    ...(instanceId === undefined ? {} : { instanceId }),
    reason,
    detail: DETAILS[reason],
  };
}

/** Recognize the operation before validating it, so invalid history never reaches chat. */
export function channelHistoryWire(
  data: string | Buffer,
  access: ChannelHistoryAccess,
  lookup: ChannelHistoryLookup,
): Effect.Effect<Channel.HistoryResponse> | undefined {
  const document = parseJson(PlainValueSchema, typeof data === "string" ? data : data.toString());
  if (document === null || typeof document !== "object" || Array.isArray(document) ||
      document.type !== "channel_history") return undefined;
  const request = Channel.HistoryRequest.safeParse(document);
  const requestId = typeof document.requestId === "string" &&
    Channel.HistoryRequest.shape.requestId.safeParse(document.requestId).success
    ? document.requestId : "invalid";
  const instanceId = typeof document.instanceId === "string" &&
    Channel.HistoryRequest.shape.instanceId.safeParse(document.instanceId).success
    ? document.instanceId : undefined;
  if (!access.authenticated || access.caller !== "owner")
    return Effect.succeed(refused(requestId, "owner_auth_required", instanceId));
  if (!request.success) return Effect.succeed(refused(requestId, "invalid_request", instanceId));
  const available = lookup(request.data.instanceId);
  if (available.status === "refused")
    return Effect.succeed(refused(requestId, available.reason, request.data.instanceId));
  return Effect.tryPromise({
    try: () => available.history(request.data),
    catch: () => "history_unavailable" as const,
  }).pipe(Effect.match({
    onFailure: (reason): Channel.HistoryResponse => refused(requestId, reason, request.data.instanceId),
    onSuccess: (result): Channel.HistoryResponse => result.status === "ok"
      ? { type: "channel_history_page", requestId, instanceId: request.data.instanceId, page: result.page }
      : refused(requestId, result.reason, request.data.instanceId),
  }));
}
