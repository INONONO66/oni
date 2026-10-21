import type { GatewayEndpoint } from "../../preload/api";
import { bindDurableSession } from "../state/session-actions";
import { createGatewayChatTransport, type GatewayChatTransport } from "./gateway-transport";

/**
 * The gateway endpoint, turned into the wire the renderer speaks — or refused.
 *
 * Pure and separate from `app.tsx` so the refusal can be asserted without a
 * window. A misconfigured gateway is REPORTED, never worked around: the
 * alternative is a shell that looks connected and answers nothing, which is a
 * harder failure to read than one sentence naming the variable to fix.
 */
type SelectedTransport =
  | {
      readonly kind: "gateway";
      readonly transport: GatewayChatTransport;
      readonly protocols?: readonly string[];
    }
  | { readonly kind: "misconfigured"; readonly transport: null; readonly problem: string };

/**
 * An HTTP token, per RFC 9110 §5.6.2 — the grammar a subprotocol name must obey.
 *
 * Checked here rather than left to the platform because `new WebSocket(url,
 * protocols)` THROWS a bare `SyntaxError` on a value outside this set, and it
 * throws from inside the transport's first send: the operator would see "Wrong
 * protocol for WebSocket" on their first message, with nothing naming the
 * variable that caused it. The daemon puts no character constraint on
 * `ONI_WS_TOKEN`, so a space in one is a configuration mistake, not an
 * impossibility.
 */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * The token's place on the wire.
 *
 * `packages/channels/src/authn/websocket.ts` reads the `Sec-WebSocket-Protocol`
 * header, finds the literal `auth`, and takes the NEXT protocol as the
 * credential. So the offer is a pair, in that order; a bare token would be an
 * unrecognised protocol and authenticate nothing.
 */
export function selectChatTransport(
  endpoint: GatewayEndpoint,
  id: () => string,
): SelectedTransport {
  // No token means no offer at all, rather than an empty one: a loopback
  // gateway with no configured token has nothing to match an `auth` pair
  // against, and answers the attempt with a 401.
  if (endpoint.token === undefined || endpoint.token.length === 0) {
    return { kind: "gateway", transport: createGatewayChatTransport({ url: endpoint.url, id, onSessionBound: bindDurableSession }) };
  }

  if (!HTTP_TOKEN.test(endpoint.token)) {
    // The token's VALUE is deliberately not in the message. It is a credential,
    // and this string reaches the screen and a crash report.
    return {
      kind: "misconfigured",
      transport: null,
      problem:
        "ONI_WS_TOKEN cannot be offered as a WebSocket subprotocol: it must contain only unreserved token characters (letters, digits, and !#$%&'*+-.^_`|~)",
    };
  }

  const protocols = ["auth", endpoint.token];
  return {
    kind: "gateway",
    transport: createGatewayChatTransport({ url: endpoint.url, protocols, id, onSessionBound: bindDurableSession }),
    protocols,
  };
}
