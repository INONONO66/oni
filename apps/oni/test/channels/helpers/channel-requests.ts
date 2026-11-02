import type { Core } from "@oni/agent";
import { Effect } from "effect";

type SessionRequests = Effect.Success<ReturnType<typeof Core.createSessionRequests>>;
import { decodeChannelFailure } from "../../../../../packages/channels/src/errors.js";
import type { GatewayRouterPorts } from "../../../src/bundles/messaging/index.js";

/** Keep real agent requests and translate only the channel boundary's error union. */
export function channelRequests(requests: SessionRequests): GatewayRouterPorts["requests"] {
  return {
    list: requests.list,
    open: (input: Parameters<GatewayRouterPorts["requests"]["open"]>[0]) =>
      requests.open(input).pipe(Effect.mapError(decodeChannelFailure("request.open"))),
    answer: (input: Parameters<GatewayRouterPorts["requests"]["answer"]>[0]) =>
      requests.answer(input).pipe(Effect.mapError(decodeChannelFailure("request.answer"))),
    receipt: (input: Parameters<GatewayRouterPorts["requests"]["receipt"]>[0]) =>
      requests.receipt(input).pipe(Effect.mapError(decodeChannelFailure("request.receipt"))),
  };
}
