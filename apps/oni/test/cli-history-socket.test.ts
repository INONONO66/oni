import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel } from "@oni/protocol";
import { createCliDeps } from "../src/cli/main";
import { channelHistory } from "../src/cli/channel-history";

test("CLI reads only its matching correlated page on the authenticated loopback socket", async () => {
  const home = mkdtempSync(join(tmpdir(), "oni-history-"));
  const seen: string[] = [];
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
        const request = Channel.HistoryRequest.parse(JSON.parse(String(content)));
        seen.push(request.type);
        socket.send(JSON.stringify({ type: "channel_history_refused", requestId: "other", reason: "history_unavailable", detail: "Other" }));
        socket.send(JSON.stringify({
          type: "channel_history_page", requestId: request.requestId,
          instanceId: request.instanceId, page: { messages: [] },
        }));
      },
    },
  });
  try {
    mkdirSync(join(home, ".oni"));
    writeFileSync(join(home, ".oni", "env"),
      `ONI_WS_HOST=127.0.0.1\nONI_WS_PORT=${server.port}\nONI_WS_TOKEN=test-token\n`);
    const deps = createCliDeps(home).channelHistory;
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await channelHistory(["kakaotalk:owner", "chat-1"], deps, {
      stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
    })).toBe(0);
    expect(seen).toEqual(["channel_history"]);
    expect(stdout).toEqual([JSON.stringify({ messages: [] })]);
    expect(stderr).toEqual([]);
  } finally {
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI refuses a non-loopback daemon before opening any socket", async () => {
  const home = mkdtempSync(join(tmpdir(), "oni-history-host-"));
  try {
    mkdirSync(join(home, ".oni"));
    writeFileSync(join(home, ".oni", "env"),
      "ONI_WS_HOST=public.example\nONI_WS_TOKEN=test-token\n");
    const errors: string[] = [];
    const result = await channelHistory(["telegram:owner", "chat"], createCliDeps(home).channelHistory, {
      stdout: () => { throw new Error("unexpected history page"); },
      stderr: (line) => errors.push(line),
    });
    expect(result).toBe(1);
    expect(errors).toEqual(["channel history requires the local daemon"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.each(["null", "invalid-object"] as const)("CLI rejects %s daemon frame", async (kind) => {
  const home = mkdtempSync(join(tmpdir(), "oni-history-invalid-"));
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, instance) {
      return instance.upgrade(request) ? undefined : new Response("Upgrade failed", { status: 400 });
    },
    websocket: {
      message(socket, content) {
        const { requestId, instanceId } = Channel.HistoryRequest.parse(JSON.parse(String(content)));
        socket.send(kind === "null" ? "null" : JSON.stringify({
          type: "channel_history_page", requestId,
          instanceId, page: { messages: "not a page" },
        }));
      },
    },
  });
  try {
    mkdirSync(join(home, ".oni"));
    writeFileSync(join(home, ".oni", "env"),
      `ONI_WS_HOST=127.0.0.1\nONI_WS_PORT=${server.port}\nONI_WS_TOKEN=test-token\n`);
    const errors: string[] = [];
    expect(await channelHistory(["telegram:owner", "chat"], createCliDeps(home).channelHistory, {
      stdout: () => { throw new Error("unexpected page"); },
      stderr: (line) => errors.push(line),
    })).toBe(1);
    expect(errors).toEqual(["invalid channel history response"]);
  } finally {
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});
