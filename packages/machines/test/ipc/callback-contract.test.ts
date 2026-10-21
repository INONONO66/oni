import { describe, expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import { Ipc } from "@oni/protocol";
import { makeDispatcher } from "../../src/ipc/callbacks";
import { IpcQueueFullError } from "../../src/ipc/errors";
import { run } from "./helpers/effects";
import { connectIpcClient, createIpcServer } from "./helpers/native";
import { deferred, within } from "./helpers/signal";
import { socketPath } from "./helpers/socket-path";
import { connectRaw, transportFixture } from "./helpers/transport";

describe("published callback contract", () => {
  const { servers, clients, rawSockets } = transportFixture();

  test("generic callbacks preserve JSON normalization, absent fields and primitive results", async () => {
    const server = await createIpcServer(
      socketPath("callback-values"),
      (_method, params, respond) => {
        respond(params?.value);
      },
    );
    servers.push(server);
    const client = await connectIpcClient(server.socketPath);
    clients.push(client);
    const values = [null, false, "text", 4, [null, "entry", false, { nested: [1, 2] }]];
    for (const value of values) {
      expect(await client.call("future.echo", { value })).toEqual(value);
    }
    expect(await client.call("future.echo")).toBeUndefined();
    expect(await client.call("future.echo", { value: undefined })).toBeUndefined();
    expect(await client.call("future.echo", { value: { omitted: undefined, kept: 1 } })).toEqual({
      kept: 1,
    });
  });

  test("request and notification handlers receive only the original positional arguments", async () => {
    const serverNotification = deferred<number>();
    const clientNotification = deferred<number>();
    const server = await createIpcServer(socketPath("callback-arity"), (...args) => {
      const [method, , respond] = args;
      if (method === "notification.arity") serverNotification.resolve(args.length);
      respond(args.length);
    });
    servers.push(server);
    const client = await connectIpcClient(server.socketPath, {
      onRequest(...args) {
        args[2](args.length);
      },
      onNotification(...args) {
        clientNotification.resolve(args.length);
      },
    });
    clients.push(client);

    // Return the observed callback arities on the wire, rather than inspecting implementation types.
    const serverResult = await client.call("request.arity");
    const clientResult = await server.call("reverse.arity");
    expect(server.notify("notification.arity")).toBe(true);
    const raw = await connectRaw(server.socketPath);
    rawSockets.push(raw);
    raw.write(`${JSON.stringify(Ipc.createNotification("notification.arity"))}\n`);
    const notifications = await within(
      Promise.all([serverNotification.promise, clientNotification.promise]),
      "both notification callbacks",
    );

    expect({ serverResult, clientResult, notifications }).toEqual({
      serverResult: 5,
      clientResult: 3,
      notifications: [5, 2],
    });
  });
});

describe("bounded callback dispatcher (#1312)", () => {
  test("a full queue answers the offerer with a typed IpcQueueFullError instead of dropping the task", async () => {
    await run(Effect.scoped(Effect.gen(function* () {
      const dispatch = yield* makeDispatcher({ bound: 1 });
      const running = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // Occupy the single executor; `running` resolves once the executor took it.
      expect(dispatch(Deferred.succeed(running, undefined).pipe(Effect.andThen(Deferred.await(release))))).toBeUndefined();
      yield* Deferred.await(running);
      // Fill the single queue slot behind the blocked executor.
      expect(dispatch(Effect.void)).toBeUndefined();
      // The bound is reached: the offerer gets the typed refusal, not a drop.
      const full = dispatch(Effect.void);
      expect(full).toBeInstanceOf(IpcQueueFullError);
      expect(full?.bound).toBe(1);
      yield* Deferred.succeed(release, undefined);
    })));
  });
});
