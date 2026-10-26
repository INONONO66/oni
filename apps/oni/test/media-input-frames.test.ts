import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { wireDaemon, wireHost } from "../../../packages/machines/test/helpers";
import { enrollment } from "../../../packages/machines/test/helpers";
import { createMachineHost } from "../../../packages/machines/test/helpers/native";
import { attachMclient, mclientBinary } from "../../../packages/machines/test/helpers/mclient";
import { eventCollector } from "../../../packages/machines/test/helpers/events";
import { inboxPartBytes, type MediaWarning, mediaDerive } from "../src/composition/media-input";
import { runEffect } from "./helpers/effect";
import { socketPath } from "./helpers/socket-path";

async function attachExports(root: string, exports: { name: string; path: string }[]) {
  const socket = socketPath();
  const events = eventCollector();
  const host = await createMachineHost({
    listen: { unix: socket }, enrollment: () => ({ ...enrollment(), allowedExports: exports.map((entry) => entry.name) }),
    events: events.sink, now: () => 3,
  });
  const client = await attachMclient({ host, events, machineId: "m-1", root, exports });
  const daemon = { close: client.stop };
  return { host, daemon };
}
beforeAll(mclientBinary, 300_000);

test.each([
  [0.25, 1],
  [1, 1],
  [32, 8],
] as const)("a %s second H.264 clip produces %s readable frames through the daemon", async (seconds, count) => {
  const root = mkdtempSync(join(tmpdir(), "oni-media-frames-"));
  const socket = socketPath();
  const host = await wireHost(socket);
  const daemon = await wireDaemon(host, root);
  try {
    const path = join(root, "clip.mp4");
    const child = Bun.spawn(
      [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=32x32:r=24",
        "-t",
        String(seconds),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        path,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const files = { machines: { defaultMachine: "m-1", get: host.get } };
    const warnings: MediaWarning[] = [];
    const derive = mediaDerive({
      files,
      root,
      exports: () => [{ path: root }],
      id: () => "extracted",
      stt: { transcribe: () => Effect.die(new Error("video must not transcribe")) },
      warn: (warning) => warnings.push(warning),
    });

    const result = await runEffect(
      derive(
        { kind: "video", ref: `m-1:${path}`, durationMs: seconds * 1000 },
        { input: ["text", "image"], api: { npm: "@ai-sdk/anthropic" } },
      ),
    );

    expect(result.parts, JSON.stringify(warnings)).toHaveLength(count);
    expect(warnings).toEqual([]);
    const bytes = inboxPartBytes(files, root, () => [{ path: root }]);
    for (const frame of result.parts) {
      expect(frame.kind).toBe("image");
      const image = await runEffect(bytes(frame.ref));
      expect(image.mime).toBe("image/jpeg");
      expect([...image.bytes.subarray(0, 3)]).toEqual([255, 216, 255]);
    }
    expect(readdirSync(root).filter((name) => name.endsWith(".video"))).toEqual([]);
  } finally {
    await daemon.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([true, false])("real daemon %s inbox export confines sibling symlinks and ordinary bytes", async (confined) => {
  const broad = mkdtempSync(join(tmpdir(), "oni-media-export-"));
  const inbox = join(broad, "inbox");
  mkdirSync(inbox);
  writeFileSync(join(broad, "private.png"), "PRIVATE_OUTSIDE_INBOX");
  writeFileSync(join(inbox, "ordinary.png"), "ORDINARY");
  symlinkSync("../private.png", join(inbox, "claimed.png"));
  const exports = confined ? [{ name: "docs", path: broad }, { name: "inbox", path: inbox }] : [{ name: "docs", path: broad }];
  const { host, daemon } = await attachExports(broad, exports);
  try {
    const files = { machines: { defaultMachine: "m-1", get: host.get } };
    const bytes = inboxPartBytes(files, inbox, () => exports);
    if (confined) {
      const refusal = await runEffect(Effect.flip(bytes(`m-1:${join(inbox, "claimed.png")}`)));
      expect(refusal.data.code).toBe("read_failed");
      expect(refusal.data.detail).toContain("path_escapes_export");
      expect(new TextDecoder().decode((await runEffect(bytes(`m-1:${join(inbox, "ordinary.png")}`))).bytes)).toBe("ORDINARY");
    } else {
      const symlinkRefusal = await runEffect(Effect.flip(bytes(`m-1:${join(inbox, "claimed.png")}`)));
      expect(symlinkRefusal.data.code).toBe("inbox_not_exported");
      const refusal = await runEffect(Effect.flip(bytes(`m-1:${join(inbox, "ordinary.png")}`)));
      expect(refusal.data.code).toBe("inbox_not_exported");
    }
  } finally {
    await daemon.close();
    await host.close();
    rmSync(broad, { recursive: true, force: true });
  }
});

test("a private video symlink yields no frames or staged copy through the real daemon", async () => {
  const broad = mkdtempSync(join(tmpdir(), "oni-media-private-video-"));
  const inbox = join(broad, "inbox");
  mkdirSync(inbox);
  const exports = [{ name: "docs", path: broad }, { name: "inbox", path: inbox }];
  const { host, daemon } = await attachExports(broad, exports);
  try {
    const child = Bun.spawn(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=32x32:r=24",
      "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(broad, "private.mp4")],
    { stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    symlinkSync("../private.mp4", join(inbox, "clip.mp4"));
    const warnings: MediaWarning[] = [];
    const derive = mediaDerive({
      files: { machines: { defaultMachine: "m-1", get: host.get } }, root: inbox,
      exports: () => exports, id: () => "blocked", warn: (warning) => warnings.push(warning),
      stt: { transcribe: () => Effect.die(new Error("video must not transcribe")) },
    });
    const result = await runEffect(derive({ kind: "video", ref: `m-1:${join(inbox, "clip.mp4")}`, durationMs: 1000 },
      { input: ["text", "image"], api: { npm: "@ai-sdk/anthropic" } }));
    expect(result).toEqual({ text: "[video 1s, 0 frames]", parts: [] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("frames_failed");
    expect(warnings[0]?.detail).toContain("path_escapes_export");
    expect(readdirSync(inbox)).toEqual(["clip.mp4"]);
  } finally {
    await daemon.close();
    await host.close();
    rmSync(broad, { recursive: true, force: true });
  }
});
