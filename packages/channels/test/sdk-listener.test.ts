import { describe, expect, test } from "bun:test";
import { Operational } from "@oni/protocol";
import { z } from "zod";
import {
  listenerCustody,
  RECONNECT_ATTEMPT_BOUND,
  type SdkListener,
  type SdkListenerEventMap,
} from "../src/support/sdk-listener";
import type { PublishPort } from "../src/types";
import { injectedOptions } from "./helpers/injected";

interface Events extends SdkListenerEventMap {
  connected: [info: { id: string }];
}

type Handler = (...args: never[]) => void;

class FakeListener implements SdkListener<Events> {
  readonly handlers = new Map<string, Handler[]>();
  started = 0;
  stopped = 0;

  constructor(private readonly onStart: (self: FakeListener) => void = () => undefined) {}

  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener as Handler);
    this.handlers.set(event, list);
    return this;
  }

  async start(): Promise<void> {
    this.started += 1;
    this.onStart(this);
  }

  stop(): void {
    this.stopped += 1;
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    for (const handler of this.handlers.get(event) ?? [])
      (handler as (...a: Events[K]) => void)(...args);
  }
}

function recorder() {
  const seen: { level: string; msg: string; failures?: number }[] = [];
  const publish: PublishPort = (event, data) => {
    const parsed = z
      .object({
        msg: z.string(),
        context: z.object({ failures: z.number().optional() }).optional(),
      })
      .parse(data);
    seen.push({
      level: event.name,
      msg: parsed.msg,
      ...(parsed.context?.failures === undefined ? {} : { failures: parsed.context.failures }),
    });
  };
  return { seen, publish };
}

function custody(
  listener: FakeListener,
  publish: PublishPort,
  extra: {
    failureBound?: number;
    failOnCloseBeforeConnected?: boolean;
    onConnected?: (info: { id: string }) => void;
    terminal?: (error: Error) => boolean;
    recoverableBeforeConnected?: (error: Error) => boolean;
  } = {},
) {
  const options = injectedOptions();
  return listenerCustody<Events>(listener, {
    label: "fake socket",
    publish,
    now: options.now,
    id: options.id,
    ...extra,
  });
}

const reconnecting = (what: "closed" | "error", failures: number) => ({
  level: Operational.Events.Info.name,
  msg: `fake socket ${what}, sdk reconnecting`,
  failures,
});

describe("listenerCustody", () => {
  test("start settles on the first connected and runs onConnected with the SDK info", async () => {
    const infos: string[] = [];
    const listener = new FakeListener((self) => self.emit("connected", { id: "bot" }));
    const wrapped = custody(listener, () => undefined, {
      onConnected: (info) => infos.push(info.id),
    });
    await wrapped.start();
    expect(listener.started).toBe(1);
    expect(infos).toEqual(["bot"]);
    expect(wrapped.dead).toBe(false);
  });

  test("an error before connected fails start, is published, and stops the listener", async () => {
    const { seen, publish } = recorder();
    const listener = new FakeListener((self) =>
      self.emit("error", Object.assign(new Error("bad token"), { code: "invalid_auth" })),
    );
    await expect(custody(listener, publish).start()).rejects.toThrow("bad token");
    expect(listener.stopped).toBe(1);
    expect(seen).toEqual([{ level: Operational.Events.Warn.name, msg: "fake socket error" }]);
  });

  test("an error before connected the SDK recovers from by another transport keeps start waiting, observed once as a fallback", async () => {
    const { seen, publish } = recorder();
    const handover = (error: Error) => /realtime/.test(error.message);
    const listener = new FakeListener((self) => {
      self.emit("error", new Error("realtime down"));
      self.emit("connected", { id: "bot" });
    });
    await custody(listener, publish, { recoverableBeforeConnected: handover }).start();
    expect(listener.stopped).toBe(0);
    expect(seen).toEqual([{ level: Operational.Events.Warn.name, msg: "fake socket error, sdk falling back" }]);
    const twice = new FakeListener((self) => {
      self.emit("error", new Error("realtime down"));
      self.emit("error", new Error("fallback down"));
    });
    await expect(custody(twice, publish, { recoverableBeforeConnected: handover }).start()).rejects.toThrow("fallback down");
    expect(twice.stopped).toBe(1);
  });

  test("a close before connected fails start with a typed failure by default", async () => {
    const listener = new FakeListener((self) => self.emit("disconnected"));
    await expect(custody(listener, () => undefined).start()).rejects.toMatchObject({
      _tag: "ChannelsFailure",
      operation: "fake socket.start",
    });
    expect(listener.stopped).toBe(1);
  });

  test("a close before connected is left to an SDK whose own start settles it (failOnCloseBeforeConnected: false)", async () => {
    const { seen, publish } = recorder();
    const listener = new FakeListener((self) => {
      self.emit("disconnected");
      self.emit("connected", { id: "bot" });
    });
    const wrapped = custody(listener, publish, { failOnCloseBeforeConnected: false });
    await wrapped.start();
    expect(wrapped.dead).toBe(false);
    expect(listener.stopped).toBe(0);
    expect(seen).toEqual([]);
  });

  test("a rejected SDK start fails this start and stops the listener", async () => {
    const listener = new FakeListener();
    listener.start = async () => {
      listener.started += 1;
      throw new Error("gateway did not become ready");
    };
    const wrapped = custody(listener, () => undefined);
    await expect(wrapped.start()).rejects.toThrow("gateway did not become ready");
    expect(wrapped.dead).toBe(true);
    expect(listener.stopped).toBe(1);
  });

  test("closes after connected are counted, a reconnect resets the count, and the bound reports the surface unreachable once per streak without stopping it", async () => {
    const { seen, publish } = recorder();
    const listener = new FakeListener((self) => self.emit("connected", { id: "bot" }));
    const wrapped = custody(listener, publish, { failureBound: 3 });
    await wrapped.start();
    listener.emit("disconnected");
    listener.emit("disconnected");
    listener.emit("connected", { id: "bot" });
    listener.emit("disconnected");
    listener.emit("disconnected");
    listener.emit("disconnected");
    // The SDK's own backoff is still running: a fourth close is not a second alarm.
    listener.emit("disconnected");
    expect(wrapped.dead).toBe(false);
    expect(listener.stopped).toBe(0);
    // The reconnect that follows is reported, and the next streak alarms again.
    listener.emit("connected", { id: "bot" });
    listener.emit("disconnected");
    listener.emit("disconnected");
    listener.emit("disconnected");
    expect(seen).toEqual([
      reconnecting("closed", 1),
      reconnecting("closed", 2),
      { level: Operational.Events.Info.name, msg: "fake socket reconnected" },
      reconnecting("closed", 1),
      reconnecting("closed", 2),
      {
        level: Operational.Events.Error.name,
        msg: "fake socket unreachable: 3 failures without a reconnect",
        failures: 3,
      },
      reconnecting("closed", 4),
      { level: Operational.Events.Info.name, msg: "fake socket reconnected" },
      reconnecting("closed", 1),
      reconnecting("closed", 2),
      {
        level: Operational.Events.Error.name,
        msg: "fake socket unreachable: 3 failures without a reconnect",
        failures: 3,
      },
    ]);
  });

  test("reopen errors after connected count toward the same streak as closes", async () => {
    const { seen, publish } = recorder();
    const listener = new FakeListener((self) => self.emit("connected", { id: "bot" }));
    const wrapped = custody(listener, publish, { failureBound: 3 });
    await wrapped.start();
    // A Slack reopen that is refused emits only `error`: no socket ever opened to close.
    listener.emit("disconnected");
    listener.emit("error", new Error("A request error occurred: getaddrinfo ENOTFOUND"));
    listener.emit("error", new Error("A request error occurred: getaddrinfo ENOTFOUND"));
    expect(listener.stopped).toBe(0);
    expect(wrapped.dead).toBe(false);
    expect(seen).toEqual([
      reconnecting("closed", 1),
      { level: Operational.Events.Warn.name, msg: "fake socket error" },
      reconnecting("error", 2),
      { level: Operational.Events.Warn.name, msg: "fake socket error" },
      {
        level: Operational.Events.Error.name,
        msg: "fake socket unreachable: 3 failures without a reconnect",
        failures: 3,
      },
    ]);
  });

  test("a terminal error after connected is a typed dead surface, stopped once", async () => {
    const { seen, publish } = recorder();
    const listener = new FakeListener((self) => self.emit("connected", { id: "bot" }));
    const wrapped = custody(listener, publish, {
      terminal: (error) => error.message === "link_disabled",
    });
    await wrapped.start();
    listener.emit("error", new Error("blip"));
    listener.emit("error", new Error("link_disabled"));
    listener.emit("error", new Error("after death"));
    listener.emit("disconnected");
    listener.emit("connected", { id: "bot" });
    expect(wrapped.dead).toBe(true);
    expect(listener.stopped).toBe(1);
    expect(seen).toEqual([
      { level: Operational.Events.Warn.name, msg: "fake socket error" },
      reconnecting("error", 1),
      { level: Operational.Events.Error.name, msg: "fake socket dead: link_disabled" },
    ]);
  });

  test("the default bound is the shared reconnect attempt bound", async () => {
    const { seen, publish } = recorder();
    const listener = new FakeListener((self) => self.emit("connected", { id: "bot" }));
    const wrapped = custody(listener, publish);
    await wrapped.start();
    for (let close = 1; close < RECONNECT_ATTEMPT_BOUND; close += 1) listener.emit("disconnected");
    expect(seen.filter((entry) => entry.level === Operational.Events.Error.name)).toEqual([]);
    listener.emit("disconnected");
    expect(seen.filter((entry) => entry.level === Operational.Events.Error.name)).toEqual([
      {
        level: Operational.Events.Error.name,
        msg: `fake socket unreachable: ${RECONNECT_ATTEMPT_BOUND} failures without a reconnect`,
        failures: RECONNECT_ATTEMPT_BOUND,
      },
    ]);
    expect(wrapped.dead).toBe(false);
  });

  test("stop marks the custody dead and stops the listener once", async () => {
    const listener = new FakeListener((self) => self.emit("connected", { id: "bot" }));
    const wrapped = custody(listener, () => undefined);
    await wrapped.start();
    wrapped.stop();
    expect(wrapped.dead).toBe(true);
    expect(listener.stopped).toBe(1);
  });
});
