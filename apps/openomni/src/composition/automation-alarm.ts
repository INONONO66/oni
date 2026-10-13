import { Bundle, type Core } from "@openomni/agent";
import type { GatewayRouter, ChannelStores } from "@openomni/channels";
import { Ingress, PlainValueSchema } from "@openomni/protocol";
import { Context, Effect } from "effect";

export const AutomationWake = Context.Reference<Core.AlarmWakeContext | undefined>(
  "@openomni/openomni/AutomationWake", { defaultValue: () => undefined },
);

export type AlarmIngress = (
  fired: Core.AlarmFired,
  ctx: Core.AlarmWakeContext,
  input: Parameters<Core.AlarmWakeContext["prompt"]>[0],
) => Effect.Effect<void, Core.AlarmWakeError>;

/** The alarm occurrence is already authenticated by the session writer and chain guard. */
export function automationAlarm(router: GatewayRouter, stores: ChannelStores): AlarmIngress {
  return (fired, ctx, prompt) => Effect.gen(function* () {
    const payload = PlainValueSchema.parse(JSON.parse(fired.payload));
    const expr = payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? payload.expr : undefined;
    const input = Ingress.Input.parse({
      surface: "alarm", event: "schedule", eventId: fired.occurrenceId,
      channelId: typeof expr === "string" ? expr : fired.alarmId,
      threadId: ctx.sessionId, author: { externalId: `session:${ctx.sessionId}`, isBot: true },
      dm: false, mentionsBot: false, body: prompt.content, receivedAt: ctx.now,
    });
    const actorId = `alarm:${ctx.sessionId}`;
    stores.actors.registerIdentity({ id: actorId, kind: "service", trustTier: "observer" });
    stores.actors.registerEndpoint({
      id: actorId, actorId, channel: "alarm", externalId: input.author.externalId,
    });
    const result = yield* router.ingest(
      { kind: "external", surface: input.surface, externalId: input.author.externalId },
      {
        eventId: input.eventId, surface: input.surface, event: input.event,
        channelId: input.channelId ?? fired.alarmId, author: input.author,
        reply: { chain: [], threadId: input.threadId }, dm: input.dm, addressees: [],
        render: input.body, payload: { receivedAt: input.receivedAt },
      },
    ).pipe(
      Effect.provideService(AutomationWake, ctx),
      Effect.mapError((error) => new Bundle.AlarmWakeError({ purpose: fired.purpose, reason: error._tag })),
    );
    // Existing self-addressed alarms retain their prompt when no automation
    // governs the tick. A filtered/refused/grouped record never takes this path.
    if (result.status === "blocked_pre" && result.reasonCode === "message.external.grant_tier" &&
        stores.automations.decisions(input.eventId).length === 0)
      yield* ctx.prompt(prompt);
  });
}
