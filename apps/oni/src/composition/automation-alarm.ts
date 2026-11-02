import { Bundle, type Core } from "@oni/agent";
import { scheduleTickChannel, type GatewayRouter, type ChannelStores } from "@oni/channels";
import { Ingress, PlainValueSchema } from "@oni/protocol";
import { Context, Effect } from "effect";
import { CauseText } from "../thrown";

export const AutomationWake = Context.Reference<Core.AlarmWakeContext | undefined>(
  "@oni/oni/AutomationWake", { defaultValue: () => undefined },
);

export type AlarmIngress = (
  fired: Core.AlarmFired,
  ctx: Core.AlarmWakeContext,
  input: Parameters<Core.AlarmWakeContext["prompt"]>[0],
) => Effect.Effect<void, Core.AlarmWakeError>;

/** The alarm occurrence is already authenticated by the session writer and chain guard. */
export function automationAlarm(router: GatewayRouter, stores: ChannelStores): AlarmIngress {
  if (stores.rules.get("seed:alarm") === undefined) stores.rules.add({
    id: "seed:alarm", position: stores.rules.list().length, enabled: true, createdBy: "owner", seed: true,
    when: { instance: "alarm" }, outcome: { kind: "deliver", target: "session:main", deliveryKind: "action", reply: "none" },
  }, true);
  // One alarm sender per session, registered on its first tick rather than on every tick.
  const registered = new Set<string>();
  const register = (sessionId: string, externalId: string) => {
    if (registered.has(sessionId)) return;
    const actorId = `alarm:${sessionId}`;
    stores.actors.registerIdentity({ id: actorId, kind: "service", trustTier: "observer" });
    stores.actors.registerEndpoint({ id: actorId, actorId, channel: "alarm", externalId });
    registered.add(sessionId);
  };
  return (fired, ctx, prompt) => Effect.gen(function* () {
    const malformed = (cause: string) =>
      new Bundle.AlarmWakeError({ purpose: fired.purpose, reason: `malformed_payload: ${cause}` });
    const payload = yield* Effect.try({ try: () => PlainValueSchema.parse(JSON.parse(fired.payload)), catch: (error) => malformed(CauseText.parse(error)) });
    const expr = payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? payload.expr : undefined;
    const input = yield* Effect.try({
      try: () => Ingress.Input.parse({
        surface: "alarm", instance: "alarm", event: "schedule", eventId: fired.occurrenceId,
        channelId: typeof expr === "string" ? scheduleTickChannel(expr) : `monitor:${fired.alarmId}`,
        threadId: ctx.sessionId, author: { externalId: `session:${ctx.sessionId}`, isBot: true },
        dm: false, mentionsBot: false, body: prompt.content, receivedAt: ctx.now,
      }),
      catch: (error) => malformed(CauseText.parse(error)),
    });
    register(ctx.sessionId, input.author.externalId);
    yield* router.ingest(
      { kind: "external", surface: input.surface, externalId: input.author.externalId },
      {
        eventId: input.eventId, surface: input.surface, instance: input.instance, event: input.event,
        channelId: input.channelId ?? `monitor:${fired.alarmId}`, author: input.author,
        reply: { chain: [], threadId: input.threadId }, dm: input.dm, addressees: [],
        render: input.body, payload: { receivedAt: input.receivedAt },
      },
    ).pipe(
      Effect.provideService(AutomationWake, ctx),
      Effect.mapError((error) => new Bundle.AlarmWakeError({ purpose: fired.purpose, reason: error._tag })),
    );
  });
}
