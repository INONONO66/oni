import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Machine } from "@oni/protocol";
import { createComputerUse } from "../src/computer-use";
import { attachMachineDaemon, createMachineHost } from "./helpers/native";
import { run } from "./ipc/helpers/effects";
import { fakeMac, type FakeMacBehavior, png, sipsBounds } from "./helpers/fake-commands";
import { socketPath } from "./helpers/socket-path";
import { silent } from "./helpers";

const COMPUTER = ["screen.read", "input.write"];

interface FixtureOptions {
  behavior?: Partial<FakeMacBehavior>;
  allowed?: string[];
  offered?: string[];
}

async function fixture(
  options: FixtureOptions,
  body: (context: {
    host: Awaited<ReturnType<typeof createMachineHost>>;
    handle: ReturnType<Awaited<ReturnType<typeof createMachineHost>>["get"]>;
    fake: ReturnType<typeof fakeMac>;
  }) => Promise<void>,
) {
  const path = socketPath();
  const fake = fakeMac(options.behavior);
  const host = await createMachineHost({
    listen: { unix: path },
    enrollment: () => ({
      machineId: "m-1",
      name: "mac",
      allowedCapabilities: options.allowed ?? COMPUTER,
      publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      enrolledAt: 1,
    }),
    events: silent,
    now: () => 3,
  });
  const daemon = await attachMachineDaemon({
    socketPath: path,
    offer: {
      machineId: "m-1",
      offeredCapabilities: options.offered ?? COMPUTER,
      daemonVersion: "test",
      platform: "darwin-arm64",
      offeredAt: 2,
    },
    commands: fake.runner,
  });
  try {
    await body({ host, handle: host.get("m-1"), fake });
  } finally {
    await daemon.close();
    await host.close();
  }
}

type Fixture = Parameters<Parameters<typeof fixture>[1]>[0];

/** The ok branch of a capture; a refusal fails the test naming the reason. */
async function latestCapture(handle: Fixture["handle"], request: Machine.ScreenReadRequest = {}) {
  const shot = await handle.screen(request);
  if (shot.status !== "ok") throw new Error(`screen refused: ${shot.reason}`);
  return shot;
}

/** A cached-bounds region refusal must spend ZERO capture invocations. */
async function expectRegionRefusedFromCache(context: Fixture, request: Machine.ScreenReadRequest) {
  const captures = context.fake.invocations("screencapture").length;
  expect(await context.handle.screen(request)).toEqual({ status: "refused", reason: "invalid_region" });
  expect(context.fake.invocations("screencapture")).toHaveLength(captures);
}

/** Asserts the body refuses without ever invoking cliclick. */
async function expectNoCliclick(fake: Fixture["fake"], body: () => Promise<void>) {
  const before = fake.invocations("cliclick").length;
  await body();
  expect(fake.invocations("cliclick")).toHaveLength(before);
}

describe("computer-use capability probes", () => {
  test("both capabilities are offered when every prerequisite probe passes", async () => {
    await fixture({}, async ({ host, fake }) => {
      expect([...(host.list()[0]?.capabilities ?? [])].sort()).toEqual(["input.write", "screen.read"]);
      expect(fake.invocations("screencapture")).toHaveLength(1);
      expect(fake.invocations("which")).toHaveLength(1);
      expect(fake.invocations("osascript").length).toBeGreaterThan(0);
    });
  });

  test("a missing cliclick binary withholds input.write but keeps screen.read", async () => {
    await fixture({ behavior: { cliclickPath: undefined } }, async ({ host }) => {
      expect(host.list()[0]?.capabilities).toEqual(["screen.read"]);
    });
  });

  test("a failing probe capture withholds screen.read", async () => {
    await fixture(
      { behavior: { captureExitCode: 1, captureStderr: "could not create image" } },
      async ({ host, handle }) => {
        expect(host.list()[0]?.capabilities).toEqual(["input.write"]);
        expect(await handle.screen({})).toEqual({ status: "refused", reason: "screen_not_available" });
      },
    );
  });

  test("denied accessibility withholds input.write and omits the tree", async () => {
    await fixture({ behavior: { accessibilityExitCode: 1 } }, async ({ host, handle }) => {
      expect(host.list()[0]?.capabilities).toEqual(["screen.read"]);
      const shot = await latestCapture(handle);
      expect("accessibilityTree" in shot).toBe(false);
      expect(await handle.input({ captureId: shot.captureId, actions: [{ click: { x: 1, y: 1 } }] }))
        .toEqual({ status: "refused", reason: "input_not_available" });
    });
  });

  test("enrollment can withhold input.write even when the daemon offers it", async () => {
    await fixture({ allowed: ["screen.read"] }, async ({ host, handle, fake }) => {
      expect(host.list()[0]?.capabilities).toEqual(["screen.read"]);
      const shot = await latestCapture(handle);
      const before = fake.invocations("cliclick").length;
      expect(await handle.input({ captureId: shot.captureId, actions: [{ click: { x: 1, y: 1 } }] }))
        .toEqual({ status: "refused", reason: "input_not_available" });
      expect(fake.invocations("cliclick")).toHaveLength(before);
    });
  });
});

describe("computer-use probe deadline", () => {
  test("hanging probe binaries withhold both capabilities instead of stalling attach", async () => {
    let n = 0;
    const computer = createComputerUse({
      runner: { run: () => Effect.never },
      id: () => `probe-${++n}`,
      probeTimeoutMs: 5,
    });
    const offered = await run(
      computer.offeredCapabilities(["screen.read", "input.write", "fs.read"]),
    );
    // Non-computer capabilities pass through; the timed-out probes withdraw.
    expect(offered).toEqual(["fs.read"]);
    // #1312: an expired probe deadline is its own reason, never a lookalike
    // of a missing binary.
    expect(await run(computer.screenRead({}))).toEqual({ status: "refused", reason: "probe_timeout" });
    expect(await run(computer.inputWrite({ captureId: "x", actions: [{ click: { x: 1, y: 1 } }] })))
      .toEqual({ status: "refused", reason: "probe_timeout" });
  });
});

describe("screen.read", () => {
  test("returns the capture bytes, a capture id, and the accessibility tree", async () => {
    await fixture({}, async ({ handle, fake }) => {
      const shot = await latestCapture(handle);
      expect(Buffer.from(shot.png).equals(fake.behavior.capturePng)).toBe(true);
      expect(shot.captureId.length).toBeGreaterThan(0);
      expect(shot.accessibilityTree).toEqual([{ app: "TextEdit", windows: [] }]);
    });
  });

  test("a region is validated against cached point bounds before any command runs", async () => {
    await fixture({}, async (context) => {
      await latestCapture(context.handle);
      // Main display measures 1000x500 points (2000x1000 px at 2x).
      await expectRegionRefusedFromCache(context, { region: { x: 900, y: 0, width: 200, height: 100 } });
    });
  });

  test("an in-bounds region crops via sips with pixel-scaled offsets", async () => {
    await fixture({ behavior: { croppedPng: png(1024) } }, async ({ handle, fake }) => {
      const shot = await handle.screen({ region: { x: 10, y: 20, width: 100, height: 50 } });
      if (shot.status !== "ok") throw new Error(`refused: ${shot.reason}`);
      expect(Buffer.from(shot.png).equals(png(1024))).toBe(true);
      const crop = fake.invocations("sips").find((argv) => argv[1] === "--cropOffset");
      // 2x display: points double into pixel offsets and pixel extents.
      expect(crop?.slice(1, 7)).toEqual(["--cropOffset", "40", "20", "-c", "100", "200"]);
    });
  });

  test("crop offsets and extents are clamped to the pixel image", async () => {
    // 999x600 px at 1.5x -> 666x400 points; x=665 rounds to offset 998 and
    // width 1 rounds to 2 px (998+2 > 999), which must clamp the width to 1.
    await fixture(
      { behavior: { boundsByDisplay: { 1: sipsBounds(999, 600, 108) }, croppedPng: png(512) } },
      async ({ handle, fake }) => {
        const shot = await handle.screen({ region: { x: 665, y: 0, width: 1, height: 100 } });
        expect(shot.status).toBe("ok");
        const crop = fake.invocations("sips").find((argv) => argv[1] === "--cropOffset");
        expect(crop?.slice(1, 7)).toEqual(["--cropOffset", "0", "998", "-c", "150", "1"]);
      },
    );
  });

  test("a non-main display is captured with -D and measured separately", async () => {
    await fixture({}, async (context) => {
      await latestCapture(context.handle, { display: 2 });
      const last = context.fake.invocations("screencapture").at(-1);
      expect(last?.slice(4, 6)).toEqual(["-D", "2"]);
      // Display 2 measures 800x600 points; a wider region refuses from cache.
      await expectRegionRefusedFromCache(context, { display: 2, region: { x: 700, y: 0, width: 200, height: 100 } });
    });
  });

  test("an unknown display index refuses invalid_region", async () => {
    await fixture({}, async ({ handle, fake }) => {
      expect((await handle.screen({})).status).toBe("ok");
      fake.behavior.captureExitCode = 1;
      fake.behavior.captureStderr = "screencapture: invalid display specified";
      expect(await handle.screen({ display: 9 })).toEqual({ status: "refused", reason: "invalid_region" });
    });
  });

  test("an over-cap capture is downscaled through sips -Z, never truncated", async () => {
    const big = png(Machine.SCREEN_PNG_MAX_BYTES + 1000);
    const small = png(4096);
    await fixture({ behavior: { capturePng: big, scaledPng: small } }, async ({ handle, fake }) => {
      const shot = await latestCapture(handle);
      expect(Buffer.from(shot.png).equals(small)).toBe(true);
      const zoom = fake.invocations("sips").filter((argv) => argv[1] === "-Z");
      expect(zoom).toHaveLength(1);
      expect(Number(zoom[0]?.[2])).toBeLessThan(2000);
    });
  });

  test("a capture that can never fit the cap refuses capture_failed", async () => {
    const big = png(Machine.SCREEN_PNG_MAX_BYTES + 1000);
    await fixture({ behavior: { capturePng: big, scaledPng: big } }, async ({ handle, fake }) => {
      expect(await handle.screen({})).toEqual({ status: "refused", reason: "capture_failed" });
      expect(fake.invocations("sips").filter((argv) => argv[1] === "-Z").length).toBeGreaterThan(1);
    });
  });

  test("revoked permission refuses permission_denied and withdraws until a probe passes", async () => {
    await fixture({}, async ({ handle, fake }) => {
      expect((await handle.screen({})).status).toBe("ok");
      fake.behavior.captureExitCode = 1;
      fake.behavior.captureStderr = "could not create image from display";
      expect(await handle.screen({})).toEqual({ status: "refused", reason: "permission_denied" });
      // Withdrawn: the next call runs only the probe (one invocation), where an
      // available screen would capture and then re-probe on failure (two).
      const before = fake.invocations("screencapture").length;
      expect(await handle.screen({})).toEqual({ status: "refused", reason: "permission_denied" });
      expect(fake.invocations("screencapture")).toHaveLength(before + 1);
      fake.behavior.captureExitCode = 0;
      fake.behavior.captureStderr = "";
      expect((await handle.screen({})).status).toBe("ok");
    });
  });
});

describe("screen.read mid-session failures", () => {
  test("a vanished screencapture binary refuses spawn_failed and recovers", async () => {
    await fixture({}, async ({ handle, fake }) => {
      expect((await handle.screen({})).status).toBe("ok");
      fake.behavior.captureMissing = true;
      // #1312: a binary that would not start is spawn_failed, never a
      // capability refusal that hides the cause.
      expect(await handle.screen({})).toEqual({ status: "refused", reason: "spawn_failed" });
      fake.behavior.captureMissing = false;
      expect((await handle.screen({})).status).toBe("ok");
    });
  });

  test("an unreadable capture file refuses read_failed", async () => {
    await fixture({}, async ({ handle, fake }) => {
      expect((await handle.screen({})).status).toBe("ok");
      fake.behavior.captureFileMissing = true;
      // #1312: a capture that exits 0 but cannot be read back is read_failed,
      // never the catch-all capture_failed.
      expect(await handle.screen({})).toEqual({ status: "refused", reason: "read_failed" });
      fake.behavior.captureFileMissing = false;
      expect((await handle.screen({})).status).toBe("ok");
    });
  });

  test("a failing tree fetch omits the tree and stops asking until re-probed", async () => {
    await fixture({}, async ({ handle, fake }) => {
      fake.behavior.treeExitCode = 1;
      const first = await latestCapture(handle);
      expect("accessibilityTree" in first).toBe(false);
      const asked = fake.invocations("osascript").filter((argv) => argv[1] === "-l").length;
      const second = await handle.screen({});
      expect(second.status).toBe("ok");
      // Withdrawn after the failure: the second capture never runs the JXA walk.
      expect(fake.invocations("osascript").filter((argv) => argv[1] === "-l")).toHaveLength(asked);
    });
  });
});

describe("input.write", () => {
  test("maps the action list onto one cliclick invocation", async () => {
    await fixture({}, async ({ handle, fake }) => {
      const shot = await latestCapture(handle);
      const result = await handle.input({
        captureId: shot.captureId,
        actions: [
          { click: { x: 10, y: 20 } },
          { click: { x: 30, y: 40, button: "right" } },
          { type: { text: "nonce-42" } },
          { key: { name: "return" } },
          { move: { x: 5, y: 6 } },
        ],
      });
      expect(result).toEqual({ status: "ok" });
      expect(fake.invocations("cliclick").at(-1)?.slice(1)).toEqual([
        "c:10,20", "rc:30,40", "t:nonce-42", "kp:return", "m:5,6",
      ]);
    });
  });

  test("anything but the latest capture id refuses stale_capture before executing", async () => {
    await fixture({}, async ({ handle, fake }) => {
      const first = await handle.screen({});
      const second = await handle.screen({});
      if (first.status !== "ok" || second.status !== "ok") throw new Error("capture refused");
      const before = fake.invocations("cliclick").length;
      expect(await handle.input({ captureId: first.captureId, actions: [{ click: { x: 1, y: 1 } }] }))
        .toEqual({ status: "refused", reason: "stale_capture" });
      expect(await handle.input({ captureId: "unknown", actions: [{ click: { x: 1, y: 1 } }] }))
        .toEqual({ status: "refused", reason: "stale_capture" });
      expect(fake.invocations("cliclick")).toHaveLength(before);
      expect(await handle.input({ captureId: second.captureId, actions: [{ click: { x: 1, y: 1 } }] }))
        .toEqual({ status: "ok" });
    });
  });

  test("an anchor captured on a non-main display refuses typed before executing", async () => {
    await fixture({}, async ({ handle, fake }) => {
      const shot = await latestCapture(handle, { display: 2 });
      await expectNoCliclick(fake, async () => {
        expect(await handle.input({ captureId: shot.captureId, actions: [{ click: { x: 1, y: 1 } }] }))
          .toEqual({
            status: "refused",
            reason: "unsupported_action",
            message: "input execution is main-display only in v1; the anchoring capture is of display 2",
          });
      });
    });
  });

  test("unsupported actions refuse typed without running anything", async () => {
    await fixture({}, async ({ handle, fake }) => {
      const shot = await latestCapture(handle);
      await expectNoCliclick(fake, async () => {
        for (const actions of [
          [{ click: { x: 1, y: 1, button: "middle" as const } }],
          [{ scroll: { deltaY: -3 } }],
          [{ key: { name: "hyper-launch" } }],
        ]) {
          expect(await handle.input({ captureId: shot.captureId, actions })).toEqual({
            status: "refused",
            reason: "unsupported_action",
          });
        }
      });
    });
  });

  test("coordinates outside the captured display refuse invalid_region", async () => {
    await fixture({}, async ({ handle, fake }) => {
      const shot = await latestCapture(handle);
      await expectNoCliclick(fake, async () => {
        expect(await handle.input({ captureId: shot.captureId, actions: [{ click: { x: 1000, y: 10 } }] }))
          .toEqual({ status: "refused", reason: "invalid_region" });
        expect(await handle.input({ captureId: shot.captureId, actions: [{ move: { x: 10, y: 500 } }] }))
          .toEqual({ status: "refused", reason: "invalid_region" });
      });
    });
  });

  test("a vanished cliclick binary refuses and withdraws until the probe passes", async () => {
    await fixture({}, async ({ handle, fake }) => {
      const shot = await latestCapture(handle);
      fake.behavior.cliclickMissing = true;
      fake.behavior.cliclickPath = undefined;
      // #1312: the vanished binary itself is spawn_failed; the withdrawn
      // capability refuses input_not_available only until the probe passes.
      expect(await handle.input({ captureId: shot.captureId, actions: [{ click: { x: 1, y: 1 } }] }))
        .toEqual({ status: "refused", reason: "spawn_failed" });
      fake.behavior.cliclickMissing = false;
      fake.behavior.cliclickPath = "/opt/homebrew/bin/cliclick";
      expect(await handle.input({ captureId: shot.captureId, actions: [{ click: { x: 1, y: 1 } }] }))
        .toEqual({ status: "ok" });
    });
  });

  test("an accessibility complaint maps permission_denied only on a failed run", async () => {
    await fixture({}, async ({ handle, fake }) => {
      const shot = await latestCapture(handle);
      // A zero-exit run executed: noisy stderr must NOT turn it into a refusal.
      fake.behavior.cliclickStderr = "cliclick requires Accessibility access";
      expect(await handle.input({ captureId: shot.captureId, actions: [{ click: { x: 1, y: 1 } }] }))
        .toEqual({ status: "ok" });
      fake.behavior.cliclickExitCode = 2;
      expect(await handle.input({ captureId: shot.captureId, actions: [{ click: { x: 1, y: 1 } }] }))
        .toEqual({ status: "refused", reason: "permission_denied" });
      fake.behavior.cliclickStderr = "";
      expect(await handle.input({ captureId: shot.captureId, actions: [{ click: { x: 1, y: 1 } }] }))
        .toEqual({ status: "refused", reason: "input_failed" });
    });
  });
});
