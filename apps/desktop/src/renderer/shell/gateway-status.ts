import { selectChatTransport } from "../chat/select-transport";
import type { useGatewayEndpoint } from "../state/queries";

/** The footer row's second line and its glyph tone; the first line is always "Gateway". */
export type GatewayStatus = {
  readonly detail: string;
  readonly tone: "muted" | "accent" | "danger";
};

/** `null` only while the query is pending; an absent gateway is a `muted` row, not `null`. */
export function gatewayStatus(
  endpoint: ReturnType<typeof useGatewayEndpoint>,
): GatewayStatus | null {
  if (endpoint.isPending) return null;
  if (endpoint.isError) return { detail: endpoint.error.message, tone: "danger" };
  if (endpoint.data === null) return { detail: "Not configured", tone: "muted" };
  const selected = selectChatTransport(endpoint.data, () => "");
  if (selected.kind === "misconfigured") return { detail: selected.problem, tone: "danger" };
  // The full wire URL is the state the row reports; the token never reaches the DOM.
  return { detail: endpoint.data.url, tone: "accent" };
}
