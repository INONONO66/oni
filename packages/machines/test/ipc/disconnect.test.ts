import { describe, expect, test } from "bun:test";
import { type Carrier, carriers } from "./helpers/carriers";
import { deferred, within } from "./helpers/signal";
import { connectRaw, transportFixture } from "./helpers/transport";

describe("disconnect observers", () => {
  const { servers, clients, rawSockets } = transportFixture();

  async function observedServer(carrier: Carrier) {
    const disconnects: string[] = [];
    let next = deferred<string>();
    const server = await carrier.listen(
      "disconnect",
      (_method, _params, respond) => respond({ ok: true }),
      { onDisconnect: (id) => { disconnects.push(id); next.resolve(id); } },
    );
    servers.push(server);
    return {
      server,
      disconnects,
      async disconnect(action: () => void) {
        next = deferred<string>();
        action();
        return await within(next.promise, "server disconnect observer");
      },
    };
  }

  test.each(carriers)("onDisconnect fires once for each gracefully closed connection over $name", async (carrier) => {
    const observed = await observedServer(carrier);
    const first = await carrier.connect(observed.server.endpoint);
    const second = await carrier.connect(observed.server.endpoint);
    clients.push(first, second);
    await first.call("ping");
    await second.call("ping");

    const firstId = await observed.disconnect(() => first.close());
    expect(observed.disconnects).toEqual([firstId]);
    const secondId = await observed.disconnect(() => second.close());
    expect(observed.disconnects).toEqual([firstId, secondId]);
    expect(firstId).not.toBe(secondId);
  });

  test("onDisconnect fires once on abrupt socket destruction", async () => {
    const unix = carriers[0] as Carrier;
    const observed = await observedServer(unix);
    const raw = await connectRaw(observed.server.endpoint);
    rawSockets.push(raw);
    const id = await observed.disconnect(() => raw.destroy());
    expect(observed.disconnects).toEqual([id]);
    await expect(observed.server.call("after.disconnect")).rejects.toThrow("no connected client");
  });
});
