import { describe, expect, test } from "bun:test";
import { Machine } from "../../src/machine/index.js";
import { Ipc } from "../../src/ipc/index.js";
import { expectIssue } from "../helpers/schema.js";

const png = Buffer.from("png-bytes").toString("base64");

describe("computer-use capability ids and wire methods", () => {
  test("well-known ids and wire method names are frozen", () => {
    expect(Machine.WellKnownCapability.screenRead).toBe("screen.read");
    expect(Machine.WellKnownCapability.inputWrite).toBe("input.write");
    expect(Machine.WireMethod.ScreenRead).toBe("machine.screen_read");
    expect(Machine.WireMethod.InputWrite).toBe("machine.input_write");
  });

  test("the ipc method table carries both computer-use contracts", () => {
    expect(Ipc.Methods["machine.screen_read"].params).toBe(Machine.ScreenReadRequest);
    expect(Ipc.Methods["machine.screen_read"].result).toBe(Machine.ScreenReadResult);
    expect(Ipc.Methods["machine.input_write"].params).toBe(Machine.InputWriteRequest);
    expect(Ipc.Methods["machine.input_write"].result).toBe(Machine.InputWriteResult);
  });
});

describe("Machine.ScreenReadRequest", () => {
  test("accepts empty, display-only, and display+region requests", () => {
    expect(Machine.ScreenReadRequest.parse({})).toEqual({});
    expect(Machine.ScreenReadRequest.parse({ display: 2 })).toEqual({ display: 2 });
    expect(
      Machine.ScreenReadRequest.parse({ display: 1, region: { x: 0, y: 0, width: 10, height: 20 } }),
    ).toEqual({ display: 1, region: { x: 0, y: 0, width: 10, height: 20 } });
  });

  test("rejects display 0, negative origins, zero extents, and unknown keys", () => {
    expect(Machine.ScreenReadRequest.safeParse({ display: 0 }).success).toBe(false);
    expect(
      Machine.ScreenReadRequest.safeParse({ region: { x: -1, y: 0, width: 10, height: 10 } }).success,
    ).toBe(false);
    expect(
      Machine.ScreenReadRequest.safeParse({ region: { x: 0, y: 0, width: 0, height: 10 } }).success,
    ).toBe(false);
    expect(
      Machine.ScreenReadRequest.safeParse({ region: { x: 0, y: 0, width: 1, height: 1 }, extra: 1 })
        .success,
    ).toBe(false);
    expect(
      Machine.ScreenReadRequest.safeParse({ region: { x: 0.5, y: 0, width: 1, height: 1 } }).success,
    ).toBe(false);
  });
});

describe("Machine.ScreenReadResult", () => {
  test("accepts ok with and without an accessibility tree", () => {
    expect(Machine.ScreenReadResult.parse({ status: "ok", captureId: "cap-1", png })).toEqual({
      status: "ok",
      captureId: "cap-1",
      png,
    });
    const tree = [{ app: "TextEdit", windows: [{ name: "Untitled", position: [0, 0] }] }];
    expect(
      Machine.ScreenReadResult.parse({ status: "ok", captureId: "cap-1", png, accessibilityTree: tree }),
    ).toEqual({ status: "ok", captureId: "cap-1", png, accessibilityTree: tree });
  });

  test("rejects empty png, non-base64 png, and over-cap base64", () => {
    expect(
      Machine.ScreenReadResult.safeParse({ status: "ok", captureId: "cap-1", png: "" }).success,
    ).toBe(false);
    expect(
      Machine.ScreenReadResult.safeParse({ status: "ok", captureId: "cap-1", png: "not base64!" })
        .success,
    ).toBe(false);
    const overCap = "A".repeat((Math.ceil(Machine.SCREEN_PNG_MAX_BYTES / 3) + 1) * 4);
    expect(
      Machine.ScreenReadResult.safeParse({ status: "ok", captureId: "cap-1", png: overCap }).success,
    ).toBe(false);
  });

  test("rejects an accessibility tree above the serialized ceiling", () => {
    const result = Machine.ScreenReadResult.safeParse({
      status: "ok",
      captureId: "cap-1",
      png,
      accessibilityTree: { text: "x".repeat(Machine.SCREEN_AX_MAX_BYTES + 1) },
    });
    expectIssue(result, {
      message: `accessibility tree exceeds ${Machine.SCREEN_AX_MAX_BYTES} serialized bytes`,
      path: ["accessibilityTree"],
    });
  });

  test("accepts every typed screen refusal and rejects unknown reasons", () => {
    for (const reason of [
      "machine_not_attached",
      "screen_not_available",
      "invalid_region",
      "permission_denied",
      "capture_failed",
      "spawn_failed",
      "read_failed",
      "probe_timeout",
    ] as const) {
      expect(Machine.ScreenReadResult.parse({ status: "refused", reason })).toEqual({
        status: "refused",
        reason,
      });
    }
    expect(Machine.ScreenReadResult.safeParse({ status: "refused", reason: "nope" }).success).toBe(
      false,
    );
  });
});

describe("Machine.InputWriteRequest", () => {
  test("accepts each action kind and preserves the list order", () => {
    const actions = [
      { click: { x: 10, y: 20 } },
      { click: { x: 10, y: 20, button: "right" as const } },
      { type: { text: "hello world" } },
      { key: { name: "return" } },
      { move: { x: 1, y: 2 } },
      { scroll: { deltaY: -3 } },
    ];
    expect(Machine.InputWriteRequest.parse({ captureId: "cap-1", actions })).toEqual({
      captureId: "cap-1",
      actions,
    });
  });

  test("rejects empty lists, over-bound lists, and malformed actions", () => {
    expect(Machine.InputWriteRequest.safeParse({ captureId: "cap-1", actions: [] }).success).toBe(
      false,
    );
    const tooMany = Array.from({ length: Machine.INPUT_MAX_ACTIONS + 1 }, () => ({
      move: { x: 0, y: 0 },
    }));
    expect(
      Machine.InputWriteRequest.safeParse({ captureId: "cap-1", actions: tooMany }).success,
    ).toBe(false);
    for (const action of [
      { click: { x: -1, y: 0 } },
      { click: { x: 1.5, y: 0 } },
      { click: { x: 0, y: 0, button: "back" } },
      { type: { text: "" } },
      { type: { text: "x".repeat(Machine.INPUT_MAX_TEXT_CHARS + 1) } },
      { key: { name: "" } },
      { scroll: { deltaX: 0.5 } },
      { tap: { x: 1, y: 1 } },
      { click: { x: 1, y: 1 }, move: { x: 1, y: 1 } },
    ]) {
      expect(
        Machine.InputWriteRequest.safeParse({ captureId: "cap-1", actions: [action] }).success,
      ).toBe(false);
    }
    expect(Machine.InputWriteRequest.safeParse({ captureId: "", actions: [{ move: { x: 0, y: 0 } }] }).success).toBe(false);
  });
});

describe("Machine.InputWriteResult", () => {
  test("uncertain dispatch carries a bounded reason and a re-observe hint", () => {
    for (const reason of ["transport_lost", "cancelled", "detached", "driver_timeout"] as const) {
      expect(Machine.InputWriteResult.parse({ status: "unverifiable", reason, dispatched: "unknown", hint: "re_observe" }))
        .toEqual({ status: "unverifiable", reason, dispatched: "unknown", hint: "re_observe" });
    }
    expect(Machine.InputWriteResult.safeParse({ status: "unverifiable", reason: "transport_lost", dispatched: false, hint: "retry" }).success).toBe(false);
    expect(Machine.InputWriteResult.parse({ status: "refused", reason: "window_busy" })).toEqual({ status: "refused", reason: "window_busy" });
    expect(Machine.InputWriteResult.parse({ status: "refused", reason: "request_busy" })).toEqual({ status: "refused", reason: "request_busy" });
  });

  test("input status keeps request identity distinct from transport correlation", () => {
    expect(Machine.InputStatusRequest.parse({ requestId: "3-7" })).toEqual({ requestId: "3-7" });
    expect(Machine.InputStatusResult.parse({ status: "ok", requestId: "3-7", dispatched: false, state: "not_started" }))
      .toEqual({ status: "ok", requestId: "3-7", dispatched: false, state: "not_started" });
    expect(Machine.InputStatusResult.parse({ status: "ok", requestId: "3-7", dispatched: true, state: "cancelled", eventsDelivered: 0 }))
      .toEqual({ status: "ok", requestId: "3-7", dispatched: true, state: "cancelled", eventsDelivered: 0 });
    expect(Machine.InputStatusResult.safeParse({ status: "ok", requestId: "3-7", dispatched: false, state: "cancelled" }).success).toBe(false);
    expect(Machine.InputStatusResult.parse({ status: "refused", reason: "request_unknown" })).toEqual({ status: "refused", reason: "request_unknown" });
    expect(Machine.InputStatusResult.parse({ status: "refused", reason: "request_busy" })).toEqual({ status: "refused", reason: "request_busy" });
    expect(Machine.InputStatusRequest.safeParse({ requestId: "transport-id" }).success).toBe(false);
  });
  test("accepts ok and every typed input refusal", () => {
    expect(Machine.InputWriteResult.parse({ status: "ok" })).toEqual({ status: "ok" });
    for (const reason of [
      "machine_not_attached",
      "input_not_available",
      "stale_capture",
      "invalid_region",
      "permission_denied",
      "unsupported_action",
      "input_failed",
      "private",
      "spawn_failed",
      "probe_timeout",
    ] as const) {
      expect(Machine.InputWriteResult.parse({ status: "refused", reason })).toEqual({
        status: "refused",
        reason,
      });
    }
    expect(Machine.InputWriteResult.safeParse({ status: "refused", reason: "nope" }).success).toBe(
      false,
    );
    expect(Machine.InputWriteResult.safeParse({ status: "ok", extra: true }).success).toBe(false);
  });
});

describe("computer-use wire round trips", () => {
  test("a screen result survives JSON serialization byte for byte", () => {
    const result = Machine.ScreenReadResult.parse({
      status: "ok",
      captureId: "cap-9",
      png,
      accessibilityTree: { app: "Finder", windows: [] },
    });
    expect(Machine.ScreenReadResult.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  test("an input request survives JSON serialization byte for byte", () => {
    const request = Machine.InputWriteRequest.parse({
      captureId: "cap-9",
      actions: [{ click: { x: 3, y: 4, button: "left" } }, { type: { text: "nonce" } }],
    });
    expect(Machine.InputWriteRequest.parse(JSON.parse(JSON.stringify(request)))).toEqual(request);
  });
});

describe("Machine.ScreenObserveResult", () => {
  test("accepts only an empty complete private observation", () => {
    const privateObservation = {
      status: "ok", observationId: "o1", lineage: "w1-1-0",
      target: { pid: 1, windowId: 1, epoch: 0 },
      window: { pid: 1, windowId: 1, epoch: 0, title: "", app: { bundleId: null, path: "/bin/app" } },
      complete: true, private: true, elements: [],
    } satisfies Machine.ScreenObserveResult;
    expect(Machine.ScreenObserveResult.parse(privateObservation)).toEqual(privateObservation);
    expect(Machine.ScreenObserveResult.safeParse({
      ...privateObservation,
      elements: [{ ref: "AXTextField[0]", role: "AXTextField", actions: [], frame: { x: 0, y: 0, width: 1, height: 1 }, secure: true }],
    }).success).toBe(false);
  });

  test("rejects an element list above the serialized ceiling", () => {
    const element = {
      ref: "AXStaticText[0]", role: "AXStaticText", value: "x".repeat(Machine.OBSERVE_MAX_VALUE_CHARS),
      actions: [], frame: { x: 0, y: 0, width: 1, height: 1 }, secure: false,
    };
    const result = Machine.ScreenObserveResult.safeParse({
      status: "ok", observationId: "o1", lineage: "w1-1-0", target: { pid: 1, windowId: 1, epoch: 0 },
      window: { pid: 1, windowId: 1, epoch: 0, title: "", app: { bundleId: null, path: "/bin/app" } }, complete: true, private: false, elements: Array.from({ length: 65 }, () => element),
    });
    expect(result.success).toBe(false);
    expect(Machine.ScreenObserveResult.safeParse({
      status: "ok", observationId: "o1", lineage: "w1-1-0", target: { pid: 1, windowId: 1, epoch: 0 },
      window: { pid: 1, windowId: 1, epoch: 0, title: "", app: { bundleId: null, path: "/bin/app" } }, complete: true, private: false, elements: Array.from({ length: 60 }, () => element),
    }).success).toBe(true);
  });

  test("the ipc method table carries the observation contracts", () => {
    expect(Ipc.Methods[Machine.WireMethod.ScreenObserve].result).toBe(Machine.ScreenObserveResult);
    expect(Ipc.Methods[Machine.WireMethod.InputAction].params).toBe(Machine.InputActionRequest);
    expect(Ipc.Methods[Machine.WireMethod.EventPrivate].params).toBe(Machine.PrivateEvent);
  });
});

test("screen list decodes a sheet parent and defaults an ordinary window kind", () => {
  const result = Machine.ScreenListResult.parse({
    status: "ok",
    displays: [{ display: 1, width: 100, height: 100, scale: 1, primary: true }],
    windows: [
      { windowId: "7", display: 1, title: "Editor", owner: "Fixture", bounds: { x: 0, y: 0, width: 100, height: 100 } },
      { windowId: "82", kind: "sheet", parent: { pid: 42, windowId: 7, epoch: 0 },
        display: 1, title: "Save", owner: "Fixture", bounds: { x: 5, y: 5, width: 30, height: 20 } },
    ],
    truncated: false,
    observedAt: 1,
  });
  expect(result.status).toBe("ok");
  if (result.status === "ok") {
    expect(result.windows[0]?.kind).toBe("window");
    expect(result.windows[1]?.parent).toEqual({ pid: 42, windowId: 7, epoch: 0 });
  }
});

test("private mode wire shapes stay explicit", () => {
  expect(Machine.ScreenCaptureResult.parse({ status: "refused", reason: "private" })).toEqual({
    status: "refused", reason: "private",
  });
  expect(Machine.ScreenListResult.safeParse({ status: "refused", reason: "private" }).success).toBe(false);
  expect(Machine.StreamObservation.parse({
    streamId: "s1", private: true, fps: 0, bytesPerSecond: 0, encodeMs: 0,
    droppedFrames: 0, retainedBytes: 0,
  }).private).toBe(true);
  expect(Machine.StreamObservation.safeParse({
    streamId: "s1", fps: 0, bytesPerSecond: 0, encodeMs: 0,
    droppedFrames: 0, retainedBytes: 0,
  }).success).toBe(false);
  expect(Machine.Events.Private.schema.parse({
    machineId: "desk", time: 1, target: { pid: 42, windowId: 7, epoch: 0 }, state: "entered",
  }).state).toBe("entered");
});
