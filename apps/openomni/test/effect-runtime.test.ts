import { composedHolder } from "./helpers/bundle-fixture";
import { expect, spyOn, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { bootResource } from "../src/composition/boot";
import { createSessionEntityPortsSlot } from "../src/composition/cluster-runtime";
import { gatewayRuntime, runAppBoot, toolPorts } from "../src/gateway";

import { startOpenOmni } from "../src/index";
import { Core } from "@openomni/agent";
const Entropy = Core.Entropy;
import { Clock } from "effect";
import { AppLifecycleFailure } from "../src/runtime";
import { runEffect, runRuntimeEffect, runRuntimeExit } from "./helpers/effect";
import { testIds } from "./helpers/test-entropy";
import { testEntropy } from "./helpers/test-entropy";
import { Bus } from "./helpers/bus";
import { testMachinesPlane } from "./helpers/self-machine";

const config = {
  host: "127.0.0.1",
  wsPort: 0,
  kek: { kind: "locked", reason: "no vault key in this fixture" },
  model: { provider: "fake", id: "fixture", apiKey: "fixture" },
  machines: testMachinesPlane(),
} as const;


test("tool ports bridge machine filesystem and exec effects through the app runtime", async () => {
  const runtime = { runPromise: runEffect } as never;
  const read = { op: "read", data: new Uint8Array([1]) };
  const write = { op: "write" };
  const list = { op: "list" as const, entries: [], truncated: false };
  const stat = { op: "stat", kind: "file" };
  const exec = { status: "completed", stdout: new Uint8Array(), stderr: new Uint8Array() };
  const machine = {
    fs: {
      read: (): Effect.Effect<typeof read> => Effect.succeed(read),
      write: (): Effect.Effect<typeof write> => Effect.succeed(write),
      list: (): Effect.Effect<typeof list> => Effect.succeed(list),
      stat: (): Effect.Effect<typeof stat> => Effect.succeed(stat),
    },
    exec: (): Effect.Effect<typeof exec> => Effect.succeed(exec),
  };
  const ports = toolPorts(runtime, {
    machines: { host: { get: (): typeof machine => machine }, defaultMachine: "self" } as never,
    completion: (() => Effect.succeed({})) as never,
    messages: { ingest: () => Effect.succeed({}) } as never,
    now: () => 0,
    id: testIds("ports"),
  });
  const handle = ports.machines?.get("machine");
  expect((await handle?.fs.read("/file")) === read).toBe(true);
  expect((await handle?.fs.write("/file", new Uint8Array())) === write).toBe(true);
  expect((await handle?.fs.list("/")) === list).toBe(true);
  expect((await handle?.fs.stat("/file")) === stat).toBe(true);
  expect((await handle?.exec("true", "/")) === exec).toBe(true);
});

test("the server edge consumes the shared gateway runtime and its injected services", async () => {
  const runtime = gatewayRuntime({ composed: composedHolder(), observations: Bus, now: () => 123, entropy: testEntropy(() => "fixed") });
  const first = await startOpenOmni({ config, runtime });
  try {
    expect(first.runtime).toBe(runtime);
    expect(gatewayRuntime({ composed: composedHolder(), observations: Bus })).toBe(runtime);
    expect(
      await runRuntimeEffect(runtime,
        Effect.gen(function* () {
          return [yield* Clock.currentTimeMillis, (yield* Entropy).id()];
        }),
      ),
    ).toEqual([123, "fixed"]);
    expect((await fetch(`http://127.0.0.1:${first.port}/health`)).status).toBe(200);
    const stop = first.stop();
    expect(first.stop()).toBe(stop);
    await stop;
  } finally {
    await first.stop();
  }
});

test("failed boot releases acquired resources in reverse and rethrows the typed cause", async () => {
  const runtime = gatewayRuntime({ composed: composedHolder(), observations: Bus });
  const order: string[] = [];
  const failure = new AppLifecycleFailure({ operation: "fixture.acquire", cause: "refused" });
  const message = Object.getOwnPropertyDescriptor(
    AppLifecycleFailure.prototype,
    "message",
  )?.get;
  if (message === undefined) throw new Error("missing lifecycle failure message getter");
  expect(message.call(failure)).toBe("fixture.acquire: refused");
  const incident = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const boot = runAppBoot(
      runtime,
      Effect.gen(function* () {
        yield* bootResource(Effect.succeed("first"), (id) =>
          Effect.sync(() => {
            order.push(id);
          }),
        );
        yield* bootResource(Effect.succeed("second"), (id) =>
          Effect.sync(() => {
            order.push(id);
          }),
        );
        return yield* Effect.fail(failure);
      }),
    );
    await expect(boot).rejects.toBe(failure);
    expect(order).toEqual(["second", "first"]);
    expect(incident.mock.calls[0]?.[1]).toBe(failure);
    await runtime.dispose();
    expect(order).toEqual(["second", "first"]);
  } finally {
    incident.mockRestore();
  }
});

test("double stop observes one pending disposal and releases exactly once", async () => {
  const runtime = gatewayRuntime({ composed: composedHolder(), observations: Bus });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  await runAppBoot(
    runtime,
    bootResource(Effect.void, () =>
      Effect.promise(async () => {
        calls += 1;
        entered.resolve();
        await release.promise;
      }),
    ),
  );
  const first = runtime.dispose();
  const second = runtime.dispose();
  expect(first).toBe(second);
  await entered.promise;
  expect(calls).toBe(1);
  release.resolve();
  await first;
  expect(runtime.dispose()).toBe(first);
  expect(calls).toBe(1);
});

test("scope finalizers all run and aggregate failures in reverse release order", async () => {
  const runtime = gatewayRuntime({ composed: composedHolder(), observations: Bus });
  const order: string[] = [];
  const first = new AppLifecycleFailure({ operation: "first.close", cause: "first" });
  const second = new AppLifecycleFailure({ operation: "second.close", cause: "second" });
  await runAppBoot(
    runtime,
    Effect.gen(function* () {
      for (const failure of [first, second]) {
        yield* bootResource(Effect.succeed(failure), (error) =>
          Effect.gen(function* () {
            order.push(error.operation);
            return yield* Effect.fail(error);
          }),
        );
      }
    }),
  );
  const exit = await runRuntimeExit(runtime, runtime.disposeEffect);
  expect(order).toEqual(["second.close", "first.close"]);
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect as AppLifecycleFailure)).toEqual([second, first]);
  await runtime.dispose();
});

test("a runtime with fixed entity ports refuses late rebinding", async () => {
  const ports = createSessionEntityPortsSlot().ports;
  await gatewayRuntime({ composed: composedHolder(), observations: Bus }).dispose();
  const runtime = gatewayRuntime({ composed: composedHolder(), observations: Bus,
    entity: { owner: "fixed-entity", ports },
  });
  try {
    await expect(
      startOpenOmni({ runtime, config }),
    ).rejects.toThrow(
      "session entity ports were fixed at runtime construction",
    );
  } finally {
    await runtime.dispose();
  }
});
