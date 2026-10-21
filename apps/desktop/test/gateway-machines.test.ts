import { expect, test } from "bun:test";
import { Machine } from "@oni/protocol";
import { createGatewayChatTransport } from "../src/renderer/chat/gateway-transport";
import { GatewayUnavailableError } from "../src/renderer/errors";
import { upgradeWebSocket } from "./helpers/chat-server";

test("machine list replies correlate over a real socket and refusals reject", async () => {
  let refused = false;
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1", port: 0, fetch: upgradeWebSocket,
    websocket: {
      message(socket, raw) {
        const request = Machine.Request.parse(JSON.parse(String(raw)));
        socket.send(JSON.stringify(refused
          ? { type: "machine_list_refused", requestId: request.requestId, reason: "unavailable", detail: "Host unavailable" }
          : { type: "machine_listed", requestId: request.requestId, rows: [] }));
      },
    },
  });
  let sequence = 0;
  const transport = createGatewayChatTransport({ url: `ws://127.0.0.1:${server.port}`, id: () => `machine-${++sequence}` });
  try {
    const replies = await Promise.all([transport.machineList(), transport.machineList()]);
    expect(replies).toEqual([
      { type: "machine_listed", requestId: "machine-1", rows: [] },
      { type: "machine_listed", requestId: "machine-2", rows: [] },
    ]);
    refused = true;
    await expect(transport.machineList()).rejects.toBeInstanceOf(GatewayUnavailableError);
  } finally { await server.stop(true); }
});
