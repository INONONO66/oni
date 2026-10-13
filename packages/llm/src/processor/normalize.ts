import type { ProviderEvent } from "./event-schema";
import type { StreamEventContext, StreamEventState } from "./stream-events";

/** Repair block ordering before facts enter the fold; duplicate ends never advance a part. */
export function normalizeEvent(
  event: ProviderEvent,
  state: StreamEventState,
  context: StreamEventContext,
): ProviderEvent[] {
  if (event.type.startsWith("text-")) return normalizeText(event, state, context);
  if (event.type.startsWith("reasoning-")) return normalizeReasoning(event, state, context);
  return [event];
}

function normalizeText(
  event: ProviderEvent,
  state: StreamEventState,
  context: StreamEventContext,
): ProviderEvent[] {
  const open = state.currentText !== undefined;
  switch (event.type) {
    case "text-start":
      if (!open) return [event];
      context.note("stream.normalized", { anomaly: "text-start while a text block is open" });
      return [{ type: "text-end" }, event];
    case "text-delta":
      if (open) return [event];
      context.note("stream.normalized", { anomaly: "text-delta for an unopened block" });
      return [{ type: "text-start", providerMetadata: event.providerMetadata }, event];
    case "text-end":
      if (open) return [event];
      context.note("stream.normalized", { anomaly: "duplicate text-end ignored" });
      return [];
    default:
      return [event];
  }
}

function normalizeReasoning(
  event: ProviderEvent,
  state: StreamEventState,
  context: StreamEventContext,
): ProviderEvent[] {
  const open = state.reasoning.has(String(event.id));
  switch (event.type) {
    case "reasoning-start":
      if (!open) return [event];
      context.note("stream.normalized", { anomaly: "duplicate reasoning-start ignored" });
      return [];
    case "reasoning-delta":
      if (open) return [event];
      context.note("stream.normalized", { anomaly: "reasoning-delta for an unopened block" });
      return [{ type: "reasoning-start", id: event.id }, event];
    case "reasoning-end":
      if (open) return [event];
      context.note("stream.normalized", { anomaly: "duplicate reasoning-end ignored" });
      return [];
    default:
      return [event];
  }
}
