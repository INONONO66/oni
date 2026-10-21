import { Effect } from "effect";
import { Core } from "@oni/agent";
import { type BusEvent, Component, type ObservationSink, type TraceContext } from "@oni/protocol";

export interface ObservedComponent {
  readonly events: BusEvent.Sink;
  run<T, E, R>(operation: Effect.Effect<T, E, R>): Effect.Effect<T, E, R>;
}

interface ComponentIdentity extends TraceContext.Type {
  readonly actorId?: string;
  readonly pluginName?: string;
  readonly pluginVersion?: string;
  readonly configRevision?: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly componentId: string;
  readonly componentGeneration: number;
}

/** App-owned component observation sink behind the protocol port. */
export function observeComponent(trace: ComponentIdentity, sink: ObservationSink): ObservedComponent {
  const events =
    sink.scope?.({
      traceId: trace.traceId,
      sessionId: trace.sessionId,
      runId: trace.runId,
      actorId: trace.actorId,
      agentName: trace.agentName,
      componentId: trace.componentId,
      componentGeneration: trace.componentGeneration,
      pluginName: trace.pluginName,
      pluginVersion: trace.pluginVersion,
      configRevision: trace.configRevision,
    }) ?? sink;

  return {
    events,
    run(operation) {
      return Effect.suspend(() => {
        events.publish(Component.Events.Active, componentPayload(trace));
        return operation.pipe(Effect.onExit((exit) => Effect.sync(() => {
          if (exit._tag === "Failure")
            events.publish(Component.Events.Failed, { ...componentPayload(trace), error: Core.pretty(exit.cause) });
          events.publish(Component.Events.Disposed, {
            ...componentPayload(trace), outcome: exit._tag === "Success" ? "completed" : "failed",
          });
        })));
      });
    },
  };
}

function componentPayload(trace: ComponentIdentity) {
  return {
    eventId: "scoped",
    traceId: trace.traceId,
    spanId: trace.parentSpanId ?? trace.traceId.slice(0, 16),
    sessionId: trace.sessionId,
    runId: trace.runId,
    componentId: trace.componentId,
    componentGeneration: trace.componentGeneration,
    time: 0,
  };
}
