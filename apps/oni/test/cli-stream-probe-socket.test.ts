import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createCliDeps } from "../src/cli/main";
import { connectProbe } from "../src/cli/stream-probe";

test("the CLI connects to its authenticated loopback gateway and correlates probe frames", async () => {
  const home = mkdtempSync(join(tmpdir(), "oni-stream-probe-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, instance) {
      if (request.headers.get("sec-websocket-protocol") !== "auth, test-token")
        return new Response("Unauthorized", { status: 401 });
      return instance.upgrade(request) ? undefined : new Response("Upgrade failed", { status: 400 });
    },
    websocket: {
      message(socket, content) {
        const request = z.object({ requestId: z.string() }).parse(JSON.parse(String(content)));
        socket.send(JSON.stringify({ type: "stream_probe_refused", requestId: "other", reason: "wrong_request" }));
        socket.send(JSON.stringify({ type: "stream_probe_refused", requestId: request.requestId, reason: "machine_not_attached" }));
      },
    },
  });
  try {
    mkdirSync(join(home, ".oni"));
    writeFileSync(join(home, ".oni", "env"),
      `ONI_WS_HOST=127.0.0.1\nONI_WS_PORT=${server.port}\nONI_WS_TOKEN=test-token\n`);
    const link = await createCliDeps(home).streamProbe.connect();
    const refused = link.next((frame) => frame.requestId === "p");
    link.send({ type: "stream_probe_report", requestId: "p" });
    expect(await refused).toEqual({ type: "stream_probe_refused", requestId: "p", reason: "machine_not_attached" });
    expect(await link.next((frame) => frame.requestId === "other")).toMatchObject({ reason: "wrong_request" });
    link.close();
  } finally {
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});

test("a closed probe socket rejects its subscribed frame waiter", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, instance) {
      return instance.upgrade(request) ? undefined : new Response("Upgrade failed", { status: 400 });
    },
    websocket: { message(socket) { socket.close(); } },
  });
  try {
    const link = await connectProbe(`ws://127.0.0.1:${server.port}/ws`, "token");
    const closed = link.next((frame) => frame.requestId === "p");
    link.send({ type: "stream_probe_report", requestId: "p" });
    await expect(closed).rejects.toThrow("stream probe socket closed");
  } finally {
    server.stop(true);
  }
});

test("a live socket that never answers the probe fails at the response deadline", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, instance) {
      return instance.upgrade(request) ? undefined : new Response("Upgrade failed", { status: 400 });
    },
    websocket: { message() { /* The server keeps the connection but has no answer. */ } },
  });
  try {
    const link = await connectProbe(`ws://127.0.0.1:${server.port}/ws`, "token", 20);
    const response = link.next((frame) => frame.requestId === "p");
    link.send({ type: "stream_probe_report", requestId: "p" });
    await expect(response).rejects.toThrow("response timed out");
    link.close();
  } finally {
    server.stop(true);
  }
});

test("a websocket handshake failure refuses the probe connection", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => new Response("Unauthorized", { status: 401 }),
  });
  try {
    await expect(connectProbe(`ws://127.0.0.1:${server.port}/ws`, "token")).rejects.toThrow("stream probe socket");
  } finally {
    server.stop(true);
  }
});

test("probe refuses a remote host or missing token before opening a socket", async () => {
  const home = mkdtempSync(join(tmpdir(), "oni-stream-probe-env-"));
  try {
    mkdirSync(join(home, ".oni"));
    writeFileSync(join(home, ".oni", "env"), "ONI_WS_HOST=public.example\nONI_WS_TOKEN=test-token\n");
    await expect(createCliDeps(home).streamProbe.connect()).rejects.toThrow("local daemon");
    writeFileSync(join(home, ".oni", "env"), "ONI_WS_HOST=127.0.0.1\n");
    await expect(createCliDeps(home).streamProbe.connect()).rejects.toThrow("ONI_WS_TOKEN");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
