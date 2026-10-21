import { describe, expect, test } from "bun:test";
import { Ipc } from "@oni/protocol";
import { z } from "zod";
import { LineDecoder } from "../../src/ipc/framing";
import { createIpcServer } from "./helpers/native";
import { deferred, within } from "./helpers/signal";
import { socketPath } from "./helpers/socket-path";
import { connectRaw, transportFixture } from "./helpers/transport";

// Exceeds the Unix socket send buffer, forcing Bun's partial-write/drain path.
const BIG_PAYLOAD = "x".repeat(8 * 1024 * 1024);
const LargeResponse = Ipc.Response.extend({ result: z.object({ data: z.string() }) });

describe("server write backpressure", () => {
  const { servers, rawSockets } = transportFixture();

  async function slowReader() {
    const issued = deferred();
    const server = await createIpcServer(socketPath("backpressure"), (_method, _params, respond) => {
      respond({ data: BIG_PAYLOAD });
      issued.resolve();
    });
    servers.push(server);
    const socket = await connectRaw(server.socketPath);
    rawSockets.push(socket);
    socket.pause();
    return { server, socket, issued };
  }

  test("a multi-megabyte response reaches a paused reader byte-exact", async () => {
    const { socket, issued } = await slowReader();
    const decoder = new LineDecoder();
    const received = deferred<z.infer<typeof LargeResponse>>();
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk).frames) received.resolve(LargeResponse.parse(frame));
    });
    const request = Ipc.createRequest("request-big-1", "get-big", {});
    socket.write(`${JSON.stringify(request)}\n`);
    await within(issued.promise, "server issuing queued response");
    socket.resume();
    const response = await within(received.promise, "complete large response", 10_000);
    expect(response.id).toBe(request.id);
    expect(response.result.data.length).toBe(BIG_PAYLOAD.length);
    // Avoid dumping megabytes when the byte comparison fails.
    expect(response.result.data === BIG_PAYLOAD).toBe(true);
  }, 15_000);

  test("a notification cannot interleave with an earlier queued response", async () => {
    const { server, socket, issued } = await slowReader();
    const decoder = new LineDecoder();
    const response = deferred<z.infer<typeof LargeResponse>>();
    const notification = deferred<Ipc.Notification>();
    const order: string[] = [];
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk).frames) {
        const parsed = z.union([LargeResponse, Ipc.Notification]).parse(frame);
        order.push(parsed.type);
        if (parsed.type === "response") response.resolve(parsed);
        else notification.resolve(parsed);
      }
    });
    socket.write(`${JSON.stringify(Ipc.createRequest("request-big-2", "get-big", {}))}\n`);
    await within(issued.promise, "first response queued");
    expect(server.notify("after.big", { marker: true })).toBe(true);
    socket.resume();
    const [first, second] = await within(
      Promise.all([response.promise, notification.promise]), "ordered frames", 10_000,
    );
    expect(order).toEqual(["response", "notification"]);
    expect(first.id).toBe("request-big-2");
    expect(first.result.data === BIG_PAYLOAD).toBe(true);
    expect(second.method).toBe("after.big");
    expect(second.params).toEqual({ marker: true });
  }, 15_000);
});
