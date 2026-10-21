import { describe, expect, test } from "bun:test";
import net from "node:net";
import { Ipc } from "@oni/protocol";
import { connectIpcClient } from "./helpers/native";
import { IpcConnectionError, IpcProtocolError, IpcRemoteError } from "../../src/ipc/errors";
import { LineDecoder, encode } from "../../src/ipc/framing";
import { createIpcServer } from "./helpers/native";
import { captureError, deferred, within } from "./helpers/signal";
import { expectOversizeFailFast } from "./helpers/oversize";
import { socketPath as socketPathForTest } from "./helpers/socket-path";
import { connectRaw, transportFixture } from "./helpers/transport";

describe("failure classes stay honest (#606 re-audit)", () => {
  const { servers, clients, rawSockets } = transportFixture();

  test("public IPC errors use the shared serializable error contract", () => {
    const connection = new IpcConnectionError({ message: "closed" });
    const remote = new IpcRemoteError({ code: 4000, message: "IPC error 4000: bad request", requestId: "fixture-request", method: "fixture.method" });
    expect(connection._tag).toBe("IpcConnectionError");
    expect(JSON.parse(JSON.stringify(connection))).toMatchObject({
      _tag: "IpcConnectionError", message: "closed",
    });
    expect(remote._tag).toBe("IpcRemoteError");
    expect(remote.code).toBe(4000);
    expect(remote.message).toBe("IPC error 4000: bad request");
  });

  test("IPC constructors retain defined falsy causes but omit undefined", () => {
    const nullCause = new IpcConnectionError({ message: "closed", cause: String(null) });
    const falseCause = new IpcProtocolError({ message: "bad frame", cause: String(false) });
    const emptyCause = new IpcConnectionError({ message: "empty", cause: String("") });
    const undefinedCause = new IpcProtocolError({ message: "absent" });

    for (const [error, cause] of [
      [nullCause, "null"],
      [falseCause, "false"],
      [emptyCause, ""],
    ] as const) {
      expect(Object.getOwnPropertyDescriptor(error, "cause") !== undefined).toBe(true);
      expect(Reflect.get(error, "cause")).toBe(cause);
    }
    expect(Object.getOwnPropertyDescriptor(undefinedCause, "cause") !== undefined).toBe(false);
  });

  test("a dying connection fails ITS in-flight calls as connection loss, not timeout", async () => {
    const socketPath = socketPathForTest("per-conn");
    let survivorConnectionId: string | undefined;
    const dyingReceivedRequest = deferred();
    const srv = await createIpcServer(
      socketPath,
      (method, _params, respond, _notify, connectionId) => {
        if (method === "register-survivor") survivorConnectionId = connectionId;
        respond({ ok: true });
      },
    );
    servers.push(srv);

    // First connection never answers server calls; it will die mid-flight.
    const dying = await connectIpcClient(socketPath, {
      onRequest: () => {
        dyingReceivedRequest.resolve();
        // Deliberately never responds.
      },
    });
    clients.push(dying);

    const inFlight = srv.call("hang", {}, 5_000);
    await within(dyingReceivedRequest.promise, "dying peer receiving in-flight request");

    // A second connection joins; the pool is not empty when the first dies.
    const survivor = await connectIpcClient(socketPath, {
      onRequest: (_method, _params, respond) => {
        respond({ from: "survivor" });
      },
    });
    clients.push(survivor);

    // Learn the survivor's connection id from the RequestHandler's own
    // connection-id argument rather than hardcoding the counter's "conn-2".
    await survivor.call("register-survivor", {});
    if (!survivorConnectionId) throw new Error("survivor connection id was never captured");

    dying.close();
    await expect(inFlight).rejects.toBeInstanceOf(IpcConnectionError);

    // The surviving connection is still usable.
    srv.useConnection(survivorConnectionId);
    expect(await srv.call("ping", {}, 2_000)).toEqual({ from: "survivor" });
  });

  test("a handlerless client answers server calls with a typed remote failure", async () => {
    const socketPath = socketPathForTest("no-handler");
    const srv = await createIpcServer(socketPath, (_method, _params, respond) => {
      respond({ ok: true });
    });
    servers.push(srv);

    const client = await connectIpcClient(socketPath, {});
    clients.push(client);

    const error = await captureError(srv.call("do-thing", {}, 2_000));
    expect(error).toBeInstanceOf(IpcRemoteError);
    expect(error.message).toContain("client has no request handler for do-thing");
  });

  async function malformedPeer(label: string) {
    const srv = await createIpcServer(socketPathForTest(label), () => undefined);
    servers.push(srv);
    const socket = await connectRaw(srv.socketPath);
    rawSockets.push(socket);
    return { srv, socket };
  }

  test("a valid response sharing a chunk with a bad line still resolves the call", async () => {
    const { srv, socket } = await malformedPeer("shared-chunk");
    const decoder = new LineDecoder();
    socket.on("data", (chunk) => {
      const { frames } = decoder.push(chunk);
      for (const raw of frames) {
        const request = Ipc.Request.safeParse(raw);
        if (!request.success) continue;
        const response = JSON.stringify(Ipc.createResponse(request.data.id, { via: "raw" }));
        socket.write(`this is not json\n${response}\n`);
      }
    });

    expect(await srv.call("ping", {}, 2_000)).toEqual({ via: "raw" });
  });

  test("each malformed line is answered with its own 4001 error frame", async () => {
    const { socket } = await malformedPeer("per-line-4001");
    const decoder = new LineDecoder();
    const errorFrames: { id: string; code: number | undefined }[] = [];
    const twoErrors = new Promise<void>((resolve) => {
      socket.on("data", (chunk) => {
        const { frames } = decoder.push(chunk);
        for (const raw of frames) {
          const response = Ipc.Response.safeParse(raw);
          if (!response.success) continue;
          errorFrames.push({ id: response.data.id, code: response.data.error?.code });
          if (errorFrames.length === 2) resolve();
        }
      });
    });
    socket.write("garbage-one\ngarbage-two\n");
    await within(twoErrors, "both malformed-line responses");
    expect(errorFrames).toEqual([
      { id: "unknown", code: 4001 },
      { id: "unknown", code: 4001 },
    ]);
  });

  test("encode/decode round-trip is unaffected", () => {
    const decoder = new LineDecoder();
    expect(decoder.push(encode({ id: "rt" }))).toEqual({ frames: [{ id: "rt" }], malformed: [] });
  });

  test("a client that sent an oversize frame fails fast, not by burning its timeout", async () => {
    const socketPath = socketPathForTest("oversize-client");
    const disconnected = deferred<string>();
    const srv = await createIpcServer(
      socketPath,
      (_method, _params, respond) => respond({ ok: true }),
      { onDisconnect: disconnected.resolve },
    );
    servers.push(srv);
    const client = await connectIpcClient(socketPath);
    clients.push(client);

    await expectOversizeFailFast(client, disconnected.promise);
  });

  test("an error frame carrying the request's id settles the requester's pending", async () => {
    const socketPath = socketPathForTest("correlated-4000");
    // Raw peer: answers ANY request with a 4000 error echoing the request id —
    // the shape the server now emits for schema-invalid frames that carry one.
    const rawServer = net.createServer((conn) => {
      const decoder = new LineDecoder();
      conn.on("data", (chunk) => {
        for (const raw of decoder.push(chunk).frames) {
          const request = Ipc.Request.safeParse(raw);
          if (!request.success) continue;
          conn.write(
            `${JSON.stringify(Ipc.createErrorResponse(request.data.id, 4000, "peer rejected the frame"))}\n`,
          );
        }
      });
    });
    await new Promise<void>((resolve) => rawServer.listen(socketPath, () => resolve()));

    try {
      const client = await connectIpcClient(socketPath);
      clients.push(client);
      // A correlated 4000 must reject the pending NOW — "unknown" would let
      // the 30s timeout burn instead.
      const error = await captureError(client.call("anything", {}, 30_000));
      expect(error).toBeInstanceOf(IpcRemoteError);
      expect((error as IpcRemoteError).code).toBe(4000);
      expect(error.message).toContain("peer rejected the frame");
    } finally {
      rawServer.close();
    }
  });

  test("a response arriving on a connection that does not own the request is ignored", async () => {
    const socketPath = socketPathForTest("cross-conn");
    const forgedResponseProcessed = deferred();
    const srv = await createIpcServer(socketPath, (method, _params, respond) => {
      if (method === "forged-response-barrier") forgedResponseProcessed.resolve();
      respond({ ok: true });
    });
    servers.push(srv);

    // conn A receives the server's request and answers LAST.
    const connA = await connectRaw(socketPath);
    rawSockets.push(connA);
    const decoderA = new LineDecoder();
    let requestId: string | undefined;
    const gotRequest = new Promise<void>((resolve) => {
      connA.on("data", (chunk) => {
        for (const raw of decoderA.push(chunk).frames) {
          const request = Ipc.Request.safeParse(raw);
          if (request.success) {
            requestId = request.data.id;
            resolve();
          }
        }
      });
    });
    const connB = await connectRaw(socketPath);
    rawSockets.push(connB);

    // Unpinned: the request routes to the first connection (conn A).
    const inFlight = srv.call("job", {}, 5_000);
    let settled = false;
    inFlight.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await within(gotRequest, "owning connection receiving the request");
    if (!requestId) throw new Error("request id was never captured");

    // conn B echoes conn A's request id. A following notification on the
    // same stream is an exact processing barrier for the forged response.
    connB.write(
      `${JSON.stringify(Ipc.createResponse(requestId, { from: "B" }))}\n${JSON.stringify(
        Ipc.createNotification("forged-response-barrier", {}),
      )}\n`,
    );
    await within(forgedResponseProcessed.promise, "foreign response processing barrier");
    expect(settled).toBe(false);

    // Only the owning connection's answer resolves it.
    connA.write(`${JSON.stringify(Ipc.createResponse(requestId, { from: "A" }))}\n`);
    expect(await inFlight).toEqual({ from: "A" });
  });
});

describe("LineDecoder malformed-frame isolation (#606 re-audit, #685 skip-and-report)", () => {
  test("one malformed line costs only itself — every parseable sibling delivers immediately", () => {
    const decoder = new LineDecoder();
    const good1 = { id: "1", kind: "a" };
    const good2 = { id: "2", kind: "b" };
    const chunk = `${JSON.stringify(good1)}\n{not json}\n${JSON.stringify(good2)}\n{"id":"3"`;

    const result = decoder.push(chunk);
    expect(result.frames).toEqual([good1, good2]);
    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0]).toBe("{not json}");

    // The trailing partial line completes on the next push, malformed-free.
    const next = decoder.push(new TextEncoder().encode("}\n"));
    expect(next).toEqual({ frames: [{ id: "3" }], malformed: [] });
  });
});

describe("client remote-error path (#606 audit)", () => {
  const { servers, clients } = transportFixture();

  test("an error frame REJECTS the call as IpcRemoteError — never resolves undefined", async () => {
    const socketPath = socketPathForTest("reject");
    const srv = await createIpcServer(socketPath, (method, _params, _respond) => {
      // A throwing handler produces the server's typed error frame (code 1000).
      throw new Error(`remote refused ${method}`);
    });
    servers.push(srv);
    const client = await connectIpcClient(socketPath, {});
    clients.push(client);

    const error = await captureError(client.call("do-thing", {}, 2_000));
    expect(error).toBeInstanceOf(IpcRemoteError);
    expect(error.message).toContain("remote refused do-thing");
    expect(error).not.toBeInstanceOf(IpcConnectionError);
    expect((error as IpcRemoteError).code).toBe(1000);
  });

  test("the SERVER side of the socket files remote failures the same way (#677 review)", async () => {
    const socketPath = socketPathForTest("server-side");
    const srv = await createIpcServer(socketPath, () => undefined);
    servers.push(srv);
    const client = await connectIpcClient(socketPath, {
      onRequest: () => {
        // A throwing client-side handler becomes the code-1000 error frame
        // the server.call path receives.
        throw new Error("client handler refused");
      },
    });
    clients.push(client);

    const error = await captureError(srv.call("do-thing", {}, 2_000));
    expect(error).toBeInstanceOf(IpcRemoteError);
    expect(error).not.toBeInstanceOf(IpcConnectionError);
    expect(error.message).toContain("client handler refused");
  });
});
