import { newTraceId } from "../support/trace";
import { createHash, timingSafeEqual } from "node:crypto";
import { Operational } from "@oni/protocol";
import type { Policy } from "@oni/protocol";
import { evaluateChannelPermission, recordDecision } from "./decision";
import type { ChannelAuthnDecisionObserver } from "./types";
import type { PublishPort } from "../types";

interface WebSocketAuthResult {
  readonly verdict: Policy.PolicyDecision;
  readonly protocol?: string;
  readonly response?: Response;
}

interface WebSocketAuthState {
  readonly request: Request;
  readonly publish: PublishPort;
  readonly now: () => number;
  /** The upgrade attempt's trace (D11 origin, one per upgrade) — both auth warns inherit it. */
  readonly traceId: string;
  readonly token?: string;
  protocol?: string;
  response?: Response;
}

function readSubprotocolAuth(
  req: Request,
): { readonly token: string; readonly selected: string } | undefined {
  const header = req.headers.get("sec-websocket-protocol");
  const protocols = header
    ?.split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
  if (!protocols) return undefined;

  const authIndex = protocols.indexOf("auth");
  const token = authIndex >= 0 ? protocols[authIndex + 1] : undefined;
  return token ? { token, selected: "auth" } : undefined;
}

/** Constant-time token check — hash both sides so length differences leak nothing. */
function tokensEqual(provided: string, expected: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(provided).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

function evaluateWebSocketToken(state: WebSocketAuthState): Policy.PolicyDecision {
  const policyId = "channel.authn.websocket-token";
  if (!state.token) {
    return evaluateChannelPermission({
      action: policyId,
      resource: "websocket.upgrade",
      field: "authenticated",
      allowed: true,
      allowReason: "websocket token auth not configured",
      denyReason: "websocket token missing or invalid",
    });
  }

  const subprotocolAuth = readSubprotocolAuth(state.request);
  const provided = subprotocolAuth?.token;
  if (
    subprotocolAuth === undefined ||
    provided === undefined ||
    !tokensEqual(provided, state.token)
  ) {
    state.publish(Operational.Events.Warn, {
      traceId: state.traceId,
      time: state.now(),
      component: "server",
      msg: "websocket auth failure",
    });
    state.response = new Response("Unauthorized", { status: 401 });
    return evaluateChannelPermission({
      action: policyId,
      resource: "websocket.upgrade",
      field: "authenticated",
      allowed: false,
      allowReason: "websocket token accepted",
      denyReason: "websocket token missing or invalid",
    });
  }

  state.protocol = subprotocolAuth.selected;
  return evaluateChannelPermission({
    action: policyId,
    resource: "websocket.upgrade",
    field: "authenticated",
    allowed: true,
    allowReason: "websocket subprotocol token accepted",
    denyReason: "websocket token missing or invalid",
  });
}

export function authenticateWebSocketUpgrade(input: {
  readonly request: Request;
  readonly publish: PublishPort;
  readonly now: () => number;
  readonly id: () => string;
  readonly token?: string;
  readonly onDecision?: ChannelAuthnDecisionObserver;
}): WebSocketAuthResult {
  const startedAt = input.now();
  const state: WebSocketAuthState = {
    request: input.request,
    publish: input.publish,
    now: input.now,
    // Origin: an inbound upgrade attempt is a genuine trace root — ONE mint per
    // upgrade; the two auth warns (mutually exclusive per upgrade) inherit it.
    // Deliberately NOT shared with per-frame traces: an accepted connection's
    // frames mint their own message origins (channel/websocket.ts).
    traceId: newTraceId(input.id),
    ...(input.token !== undefined ? { token: input.token } : {}),
  };
  const verdict = evaluateWebSocketToken(state);
  void recordDecision(
    "channel-authn:websocket-token",
    verdict,
    input.now() - startedAt,
    input.onDecision,
  );

  return {
    verdict,
    ...(state.protocol !== undefined ? { protocol: state.protocol } : {}),
    ...(state.response !== undefined ? { response: state.response } : {}),
  };
}
