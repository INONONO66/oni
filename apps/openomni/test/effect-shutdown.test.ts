import { APPROVAL_POLICY } from "../src/bundles/approval-policy/index";
import { testToolPorts } from "./helpers/tool-ports";
import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { expect, spyOn, test } from "bun:test";
import { Bundle, Core, Testing } from "@openomni/agent";
const session = Testing.session;
const createTurnDispatcher = Bundle.createTurnDispatcher;
const defineTool = Core.defineTool;
const eraseTool = Core.eraseTool;
const projectTools = Core.projectTools;
type SessionRuntime = Core.SessionRuntime;
import { planeOf } from "./helpers/ledger";
import { z } from "zod";
import { createResident } from "../src/bundles/resident/index";
import { eventSignal } from "./helpers/event-signal";
import { seedKernelPolicyRows } from "../src/bundles/core-policy/index";
import { shutdownSessions } from "../src/shutdown";
import { Clock, Effect } from "effect";
import { bootResource } from "../src/composition/boot";
import { acquireAppResource, gatewayRuntime, runAppBoot, runAppEffect } from "../src/gateway";
import { installShutdownHandlers } from "../src/index";
const GenerationLayers = Core.GenerationLayers;
import { AppLifecycleFailure } from "../src/runtime";
import { allowConfigure } from "./helpers/generation-services";
import { composedHolder } from "./helpers/bundle-fixture";
import { testToolsBundle } from "./helpers/app-fixture";
import { Bus } from "./helpers/bus";

test("shutdown stops ingress before session cleanup and awaits cleanup before storage and exit", async () => {
  let now = 100;
  const runtime = gatewayRuntime({ composed: composedHolder(), observations: Bus, now: () => now });
  const events: (string | number)[] = [];
  const closing = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<number>();
  const handlers = new Map<string, () => void>();
  await runAppBoot(
    runtime,
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      yield* bootResource(Effect.void, () =>
        Effect.promise(async () => {
          events.push("sessions.close", clock.currentTimeMillisUnsafe());
          closing.resolve();
          await settled.promise;
          events.push("sessions.closed", clock.currentTimeMillisUnsafe());
        }),
      );
      yield* bootResource(Effect.void, () =>
        Effect.sync(() => {
          events.push("ingress.stop");
        }),
      );
    }),
  );
  let stops = 0;
  installShutdownHandlers({
    stop: () => {
      stops += 1;
      return runtime.dispose();
    },
    on: (signal, handler) => {
      handlers.set(signal, handler);
    },
    exit: (code) => {
      events.push("exit");
      exited.resolve(code);
    },
  });
  handlers.get("SIGINT")?.();
  handlers.get("SIGTERM")?.();
  await closing.promise;
  expect(stops).toBe(1);
  expect(events).toEqual(["ingress.stop", "sessions.close", 100]);
  now = 150;
  settled.resolve();
  expect(await exited.promise).toBe(0);
  expect(events).toEqual(["ingress.stop", "sessions.close", 100, "sessions.closed", 150, "exit"]);
});

test("a cleanup failure is an observed shutdown incident and cannot produce a successful exit", async () => {
  const runtime = gatewayRuntime({ composed: composedHolder(), observations: Bus });
  const failure = new AppLifecycleFailure({ operation: "sessions.close", cause: "commit_refused" });
  await runAppBoot(
    runtime,
    bootResource(Effect.void, () => Effect.fail(failure)),
  );
  const handlers = new Map<string, () => void>();
  const exited = Promise.withResolvers<number>();
  const incident = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    installShutdownHandlers({
      stop: runtime.dispose,
      on: (signal, handler) => {
        handlers.set(signal, handler);
      },
      exit: exited.resolve,
    });
    handlers.get("SIGTERM")?.();
    expect(await exited.promise).toBe(1);
    expect(incident.mock.calls).toHaveLength(1);
    expect(incident.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  } finally {
    incident.mockRestore();
  }
});

for (const settleAfterTurn of [false, true]) {
test(`zero-grace close retains a raw tool lease (settle after turn: ${settleAfterTurn})`, async () => {
  const entered = eventSignal<void>("raw tool entered");
  const interrupted = eventSignal<void>("raw tool interrupted");
  const raw = Promise.withResolvers<string>();
  const released = eventSignal<void>("raw lease released");
  const order: string[] = [];
  const tool = eraseTool(defineTool({
    name: "hold_raw", category: "query", description: "Hold a raw tool body",
    input: z.object({}), output: z.string(), visibility: { model: ["resident"], cell: [] },
    execute: (_args, { signal }) => {
      signal.addEventListener("abort", () => { order.push("interrupt"); interrupted.resolve(); }, { once: true });
      entered.resolve();
      return raw.promise;
    },
    render: (_args, output) => output,
  }));
  const runtime = gatewayRuntime({ observations: Bus, now: () => 1000, composed: composedHolder({ bundles: [testToolsBundle([tool])] }) });
  await runAppBoot(runtime, Effect.void);
  const plane = await planeOf(runtime);
  seedKernelPolicyRows(plane.catalog.policies);
  const sessionRuntime: SessionRuntime = {
    approvalPolicy: APPROVAL_POLICY,
    authorizeConfigure: allowConfigure,
    openKernel: plane.openKernel,
    listSessions: plane.listSessions,
    closeGraceMs: 0,
    onHibernate: () => Effect.sync(() => { order.push("lease.released"); released.resolve(); }),
  };
  const resident = createResident({
    model: { provider: "test", id: "test" },
    apiKey: "test",
    tools: { ...testToolPorts },
    sessionRuntime,
    policyGeneration: () => plane.openKernel("shutdown-raw").currentPolicyGeneration(),
  });
  await runAppEffect(runtime, Effect.flatMap(GenerationLayers, (generations) => generations.initialize(resident.definitions)));
  const handle = await acquireAppResource(runtime, session({
    id: "shutdown-raw", role: "resident", tools: projectTools([tool]).session,
    runner: (input) => Effect.flatMap(createTurnDispatcher(input, sessionRuntime), (dispatcher) => dispatcher.execute(
      { id: "hold-call", tool: tool.name, input: {} },
      { sessionId: input.sessionId, turnId: input.turnId, signal: input.signal },
    )).pipe(Effect.as({ kind: "result" as const, text: "settled" })),
  }, sessionRuntime));
  const turn = runAppEffect(runtime, handle.prompt("hold raw tool"));
  try {
    await entered.promise;
    const kernel = plane.openKernel(handle.id);
    const lease = kernel.row(handle.id);
    expect(lease.fenceOwner).not.toBeNull();
    await runAppEffect(runtime, shutdownSessions(sessionRuntime, Promise.resolve()));
    order.push("close.returned");
    await interrupted.promise;
    expect(kernel.row(handle.id)).toMatchObject({ fenceOwner: lease.fenceOwner, fence: lease.fence });
    expect(sessionTree(handle.id, plane.sessionStore(handle.id).actions).some((action) => {
      const value = action.effect.value;
      return value !== null && typeof value === "object" && !Array.isArray(value) && value.terminal === "outcome_unknown";
    })).toBe(true);
    await expect(runtime.dispose()).rejects.toMatchObject({ _tag: "AppLifecycleFailure", operation: "shutdown.raw_unsettled" });
    expect(gatewayRuntime({ composed: composedHolder(), observations: Bus })).toBe(runtime);
    if (settleAfterTurn) await turn;
    raw.resolve("late raw settlement");
    await turn;
    await released.promise;
    expect(order.indexOf("lease.released")).toBeGreaterThan(order.indexOf("close.returned"));
    // W5.2: hibernation commits nothing and the durable owner survives —
    // release is the onHibernate signal above, not a lease-null write.
    expect(kernel.row(handle.id).fenceOwner).not.toBeNull();
  } finally {
    raw.resolve("late raw settlement");
    await turn;
    await runtime.dispose();
  }
});
}
