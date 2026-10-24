const PREFLIGHT = new Set([
  "not_authenticated",
  "missing_token",
  "invalid_token",
  "empty_message",
  "file_too_large",
]);
const NEVER_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ConnectionRefused"]);

export type TransportFailure = "rejected" | "not_connected" | "uncertain";

export function transportFailure(evidence: {
  readonly code: string;
  readonly httpStatus?: number;
  readonly transportCode?: string;
}): TransportFailure {
  // A response proves a connection, even when its description quotes a network error.
  if (evidence.httpStatus !== undefined)
    return evidence.httpStatus >= 400 && evidence.httpStatus < 500 ? "rejected" : "uncertain";
  if (evidence.transportCode !== undefined && NEVER_CONNECTED.has(evidence.transportCode))
    return "not_connected";
  return PREFLIGHT.has(evidence.code) ? "rejected" : "uncertain";
}
