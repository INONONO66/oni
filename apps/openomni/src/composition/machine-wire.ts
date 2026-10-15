import type { MachineHost } from "@openomni/machines";
import { Machine, parseJson, PlainValueSchema } from "@openomni/protocol";

/** The upgrade gate already authenticated the socket; this read never enters a session. */
export function machineWire(data: string | Buffer, host: Pick<MachineHost, "list"> | undefined): Machine.Response | undefined {
  const document = parseJson(PlainValueSchema, typeof data === "string" ? data : data.toString());
  if (document === null || typeof document !== "object" || Array.isArray(document) || document.type !== "machine_list")
    return undefined;
  const request = Machine.Request.safeParse(document);
  if (!request.success) {
    return {
      type: "machine_list_refused",
      requestId: typeof document.requestId === "string" && document.requestId.length > 0 ? document.requestId : "invalid",
      reason: "invalid_request",
      detail: "Invalid machine list request",
    };
  }
  return host === undefined
    ? { type: "machine_list_refused", requestId: request.data.requestId, reason: "unavailable", detail: "Machine host is not configured" }
    : { type: "machine_listed", requestId: request.data.requestId, rows: host.list() };
}
