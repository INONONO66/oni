import { traceIdFromUuid } from "@oni/protocol";

/** Channel-driver trace origin over the injected UUID source; entropy stays with the caller. */
export function newTraceId(id: () => string): string {
  return traceIdFromUuid(id());
}
