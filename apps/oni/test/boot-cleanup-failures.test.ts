import { composedHolder } from "./helpers/bundle-fixture";
import { expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { bootResource } from "../src/composition/boot";
import { gatewayRuntime, runAppBoot } from "../src/gateway";
import { startOni } from "../src/index";
import { AppLifecycleFailure } from "../src/runtime";
import { Bus } from "./helpers/bus";
import { testMachinesPlane } from "./helpers/self-machine";

test("boot retains both the acquisition failure and the failing cleanup", async () => {
  const runtime = gatewayRuntime({ composed: composedHolder(), observations: Bus });
  const acquire = new AppLifecycleFailure({ operation: "fixture.acquire", cause: "refused" });
  const release = new AppLifecycleFailure({ operation: "fixture.release", cause: "refused" });
  const incident = spyOn(console, "error").mockImplementation((): void => undefined);
  try {
    const result = runAppBoot(runtime, Effect.gen(function* () {
      yield* bootResource(Effect.void, () => Effect.fail(release));
      return yield* Effect.fail(acquire);
    }));
    const failure = await result.catch((error: AggregateError): AggregateError => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors[0]).toBe(acquire);
    expect(failure.errors[1]).toBeInstanceOf(Error);
    expect(incident.mock.calls[0]?.[1]).toBe(acquire);
  } finally {
    incident.mockRestore();
  }
});

test("server bind failure preserves its cleanup failure and closes storage", async () => {
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") });
  const port = occupied.port;
  if (port === undefined) throw new Error("fixture server did not bind a port");
  const runtime = gatewayRuntime({ composed: composedHolder(), observations: Bus });
  const release = new AppLifecycleFailure({ operation: "fixture.release", cause: "refused" });
  await runAppBoot(runtime, bootResource(Effect.void, () => Effect.fail(release)));
  try {
    const failed = startOni({ runtime, config: {
      host: "127.0.0.1", wsPort: port,
      kek: { kind: "locked", reason: "no vault key in this fixture" },
      model: { provider: "fake", id: "fixture", apiKey: "fixture" },
      machines: testMachinesPlane(),
    } });
    await expect(failed).rejects.toBeInstanceOf(AggregateError);
    expect((await fetch(`http://127.0.0.1:${occupied.port}`)).status).toBe(200);
  } finally {
    await occupied.stop(true);
  }
});
