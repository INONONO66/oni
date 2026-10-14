import { describe, expect, it } from "bun:test";
import { scopeObservation } from "../../src/core/observation/bus";
import { newTraceId } from "../helpers/bus";
import { ObservationDeliveryFailed } from "../../src/core/observation/bus";
import { collector } from "../helpers/observation-collector";
import { BusEvent, type ObservationSink } from "@openomni/protocol";
import { z } from "zod";

const TestEvent = BusEvent.define(
  "test.scope",
  z.object({ component: z.string(), msg: z.string() }).passthrough(),
);

const identity = {
  traceId: "trace-1",
  sessionId: "session-1",
  runId: "run-1",
  actorId: "actor-1",
};

/** Required stamp sources for scopes that do not assert on them. */
function stamps() {
  let n = 0;
  return { now: () => 0, id: () => `event-${++n}` };
}

describe("scoped observations", () => {
  it("stamps authoritative identity, event id, and time onto payloads", () => {
    const sink = collector();
    const scoped = scopeObservation(sink, identity, {
      now: () => 42,
      id: () => "event-1",
    });

    scoped.publish(TestEvent, {
      traceId: "forged",
      time: 1,
      component: "test",
      msg: "observed",
    });

    expect(sink.named(TestEvent.name)).toEqual([
      {
        traceId: "trace-1",
        sessionId: "session-1",
        runId: "run-1",
        actorId: "actor-1",
        eventId: "event-1",
        time: 42,
        component: "test",
        msg: "observed",
      },
    ]);
  });

  it("preserves strict descriptor payload fields while stamping scope identity", () => {
    const StrictEvent = BusEvent.define(
      "test.scope.strict",
      z.object({ component: z.string(), msg: z.string() }).strict(),
    );
    const received: Array<z.infer<typeof StrictEvent> & { extra: string }> = [];
    const scoped = scopeObservation({
      publish: (_event, data) => received.push(z.object({
        component: z.string(),
        msg: z.string(),
        extra: z.string(),
      }).parse(data)),
      scope: () => scoped,
    }, identity, { now: () => 42, id: () => "event-strict" });
    scoped.publish(StrictEvent, { component: "test", msg: "strict", extra: "kept" } as never);
    expect(received[0]).toMatchObject({ component: "test", msg: "strict", extra: "kept" });
  });

  it("merges child identity while retaining parent fields", () => {
    const sink = collector();
    const parent = scopeObservation(sink, identity, {
      now: () => 42,
      id: () => "event-2",
    });
    const child = parent.scope?.({ runId: "run-2" });
    if (child === undefined) throw new Error("scoped sink must support child scopes");

    child.publish(TestEvent, { component: "test", msg: "child" });

    expect(sink.events[0]?.data).toMatchObject({
      traceId: "trace-1",
      sessionId: "session-1",
      runId: "run-2",
      actorId: "actor-1",
    });
  });

  it("reports invalid payloads and sink failures without escaping", () => {
    const errors: Array<{ name: string; type: string }> = [];
    const hostile: ObservationSink = {
      publish() {
        throw new Error("sink failed");
      },
      scope() {
        return hostile;
      },
    };
    const scoped = scopeObservation(hostile, identity, {
      now: () => 0,
      id: () => "event-error",
      onError: (error, name) => errors.push({ name, type: error.name }),
    });

    Reflect.apply(scoped.publish, scoped, [TestEvent, null]);
    Reflect.apply(scoped.publish, scoped, [TestEvent, []]);
    scoped.publish(TestEvent, { component: "test", msg: "valid" });

    expect(errors).toEqual([
      { name: TestEvent.name, type: "TypeError" },
      { name: TestEvent.name, type: "TypeError" },
      { name: TestEvent.name, type: "Error" },
    ]);
  });

  // Each row pins the diagnostic the bus is expected to retain for that thrown
  // value, written as a literal: String() for most, the object tag when
  // String() itself throws. The function row is `() => 0` because String() of
  // a function returns its source text, and that literal survives Bun's
  // transpiler verbatim.
  it.each([
    [new Error("reporter failed"), "Error: reporter failed"],
    [Symbol("reporter"), "Symbol(reporter)"],
    [{ toString: 0 }, "[object Object]"],
    [null, "null"],
    [undefined, "undefined"],
    [false, "false"],
    [1, "1"],
    [1n, "1"],
    ["reporter", "reporter"],
    [() => 0, "() => 0"],
  ])("exposes a reporter failure as data without throwing: %p", (reporterFailure, expected) => {
    // The sink refuses domain events but still accepts the failure report itself.
    const failures: { eventName: string; error: string; reporterError?: string }[] = [];
    const hostile: ObservationSink = {
      publish(event, data) {
        if (event.name !== ObservationDeliveryFailed.name) throw new Error("sink failed");
        failures.push(ObservationDeliveryFailed.schema.parse(data));
      },
      scope() {
        return hostile;
      },
    };

    scopeObservation(hostile, identity, stamps()).publish(TestEvent, { component: "test", msg: "default reporter" });
    expect(failures).toEqual([{ eventName: TestEvent.name, error: "Error: sink failed" }]);
    failures.length = 0;

    const scoped = scopeObservation(hostile, identity, {
      ...stamps(),
      onError() {
        throw reporterFailure;
      },
    });
    scoped.publish(TestEvent, { component: "test", msg: "custom reporter" });
    expect(failures).toEqual([
      { eventName: TestEvent.name, error: "Error: sink failed", reporterError: expected },
    ]);
  });

  it("drops the failure when the sink refuses the failure report too", () => {
    const attempted: string[] = [];
    const hostile: ObservationSink = {
      publish(event) {
        attempted.push(event.name);
        throw new Error("sink failed");
      },
      scope() {
        return hostile;
      },
    };
    scopeObservation(hostile, identity, stamps()).publish(TestEvent, { component: "test", msg: "dropped" });
    expect(attempted).toEqual([TestEvent.name, ObservationDeliveryFailed.name]);
  });

  it("forwards subscriptions when the underlying sink supports them", () => {
    let subscribed = false;
    const sink: ObservationSink = {
      publish: () => undefined,
      scope() {
        return sink;
      },
      subscribe() {
        subscribed = true;
        return () => {
          subscribed = false;
        };
      },
    };
    const scoped = scopeObservation(sink, identity, stamps());

    const unsubscribe = scoped.subscribe?.(TestEvent, () => undefined);
    expect(subscribed).toBe(true);
    unsubscribe?.();
    expect(subscribed).toBe(false);
  });

  it("collector groups and resets observations", () => {
    const sink = collector();
    const OtherEvent = BusEvent.define("test.scope.other", z.object({ value: z.number() }));
    sink.publish(TestEvent, { component: "a", msg: "one" });
    sink.publish(OtherEvent, { value: 2 });

    expect(sink.named(TestEvent.name)).toHaveLength(1);
    expect(sink.named(OtherEvent.name)).toHaveLength(1);
    sink.reset();
    expect(sink.events).toEqual([]);
  });

  it("generates compact trace identifiers", () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });
});
