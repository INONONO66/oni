import { type ChannelError, type ChannelStores, decodeChannelFailure, webSocketSenderTier } from "@oni/channels";
import type { Gateway, SessionTransition } from "@oni/protocol";
import { Effect } from "effect";

export interface OwnerAnswerDeps {
  /** The configured socket token; empty or absent is a tokenless loopback boot. */
  readonly wsToken: string | undefined;
  readonly stores: ChannelStores;
  /** The token rule: the Owner's credential against the configured token, or a thrown unauthenticated refusal. */
  readonly byToken: (credential: string, requestId: string) => SessionTransition.Principal;
}

/**
 * Who may answer a request (#1245; #1600 lane R3): with a token configured,
 * the token, as before. On a tokenless loopback boot nothing could ever
 * present one, so the socket is the evidence under the one rule chat already
 * admits it by (`webSocketSenderTier`: the ws bootstrap grant makes every
 * loopback socket the Owner, which `assertWsExposure` confines to loopback);
 * a sender on any other surface still goes to the token rule and is refused.
 * The in-process approvals facade (`authorizeApproval`, reached by tests
 * alone) keeps the token rule.
 */
export function ownerAnswerAuthentication(
  deps: OwnerAnswerDeps,
): (
  sender: Gateway.IngestSender & { kind: "external" },
  credential: string,
  requestId: string,
) => Effect.Effect<SessionTransition.Principal, ChannelError> {
  const tokenless = (deps.wsToken ?? "").length === 0;
  return (sender, credential, requestId) =>
    Effect.try({
      try: () =>
        tokenless && sender.surface === "ws" && webSocketSenderTier(deps.stores, sender.externalId) === "owner"
          ? { kind: "owner" as const, principalId: "owner", evidenceId: `ws-loopback:${sender.externalId}:${requestId}` }
          : deps.byToken(credential, requestId),
      catch: decodeChannelFailure("answer.authenticate"),
    });
}
