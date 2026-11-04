import { describe, expect, test } from "bun:test";
import { type DisplayedFrame, frameLatency } from "../../src/frame-latency";
import { carriers } from "./helpers/carriers";
import { transportFixture } from "./helpers/transport";

const ROUND_TRIPS = 200;

/** The printed milliseconds are a receipt for the issue, never an assertion threshold. */
describe.each(carriers)("carrier round-trip latency over $name (#1830)", (carrier) => {
  const { servers, clients } = transportFixture();

  test(`${ROUND_TRIPS} sequential echo calls fold into one latency receipt`, async () => {
    const server = await carrier.listen("latency", (_method, params, respond) => respond(params));
    servers.push(server);
    const client = await carrier.connect(server.endpoint);
    clients.push(client);

    const frames: DisplayedFrame[] = [];
    for (let seq = 1; seq <= ROUND_TRIPS; seq += 1) {
      const capturedAt = performance.now();
      const echoed = await client.call("echo", { seq });
      frames.push({ seq, capturedAt, displayAt: performance.now() });
      expect(echoed).toEqual({ seq });
    }

    const latency = frameLatency(frames);
    expect(latency).toMatchObject({
      frames: ROUND_TRIPS,
      dropped: 0,
      reconnectFirstFreshFrameMs: null,
    });
    expect(latency.p50).not.toBeNull();
    expect(latency.p95).not.toBeNull();
    expect(latency.p50 ?? 0).toBeLessThanOrEqual(latency.p95 ?? 0);
    console.info(
      `latency carrier=${carrier.name} frames=${latency.frames} p50=${latency.p50?.toFixed(3)}ms p95=${latency.p95?.toFixed(3)}ms p99=${latency.p99?.toFixed(3)}ms`,
    );
  });
});
