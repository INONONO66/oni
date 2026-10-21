import { describe, expect, test } from "bun:test";
import { installShutdownHandlers } from "../src/index";

describe("entry-point shutdown handlers", () => {
  test("SIGINT/SIGTERM handler awaits stop() completion before exiting", async () => {
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    let stopCalls = 0;
    let resolveStop!: () => void;
    const stopPromise = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });

    installShutdownHandlers({
      stop: () => {
        stopCalls += 1;
        return stopPromise;
      },
      exit: (code) => exits.push(code),
      on: (signal, handler) => handlers.set(signal, handler),
    });

    const sigint = handlers.get("SIGINT");
    const sigterm = handlers.get("SIGTERM");
    if (sigint === undefined || sigterm === undefined) {
      throw new Error("expected SIGINT and SIGTERM handlers to be registered");
    }

    sigint();
    expect(stopCalls).toBe(1);
    // The shutdown contract: exit never precedes the full async stop.
    expect(exits).toEqual([]);

    resolveStop();
    // The handler's exit callback is attached to stopPromise before this
    // await, so it runs first — a deterministic completion signal, no drain.
    await stopPromise;
    expect(exits).toEqual([0]);
  });

  test("handler exits non-zero when stop() rejects", async () => {
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    let rejectStop!: () => void;
    const stopPromise = new Promise<void>((_resolve, reject) => {
      rejectStop = () => reject(new Error("flush failed"));
    });

    installShutdownHandlers({
      stop: () => stopPromise,
      exit: (code) => exits.push(code),
      on: (signal, handler) => handlers.set(signal, handler),
    });

    const sigterm = handlers.get("SIGTERM");
    if (sigterm === undefined) throw new Error("expected a SIGTERM handler");

    sigterm();
    expect(exits).toEqual([]);
    rejectStop();
    await stopPromise.catch(() => undefined);
    expect(exits).toEqual([1]);
  });
});
