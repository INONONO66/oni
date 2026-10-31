import { describe, expect, test } from "bun:test";
import { Ipc, Machine } from "../../src/index.js";

describe("Ipc.Request", () => {
  test("rejects missing id", () => {
    expect(Ipc.Request.safeParse({ v: 2, type: "request", method: "machine.attach" }).success).toBe(
      false,
    );
  });

  test("rejects wrong version", () => {
    expect(
      Ipc.Request.safeParse({
        v: 1,
        type: "request",
        id: "req-1",
        method: "machine.attach",
      }).success,
    ).toBe(false);
  });

  test("rejects wrong type", () => {
    expect(
      Ipc.Request.safeParse({
        v: 2,
        type: "notification",
        id: "req-1",
        method: "machine.attach",
      }).success,
    ).toBe(false);
  });
});

describe("Ipc.Response", () => {
  test("rejects missing id", () => {
    expect(Ipc.Response.safeParse({ v: 2, type: "response", result: null }).success).toBe(false);
  });
});

describe("Ipc.Notification", () => {
  test("rejects missing method", () => {
    expect(Ipc.Notification.safeParse({ v: 2, type: "notification" }).success).toBe(false);
  });
});

describe("Ipc helpers", () => {
  test("createRequest preserves the caller-supplied id byte-exact", () => {
    const req = Ipc.createRequest("request-0001", "machine.attach", { machineId: "m-1" });
    expect(Ipc.Request.safeParse(req).success).toBe(true);
    expect(JSON.stringify(req)).toBe(
      '{"v":2,"type":"request","id":"request-0001","method":"machine.attach","params":{"machineId":"m-1"}}',
    );
  });

  test("createRequest without params", () => {
    const req = Ipc.createRequest("request-0002", "machine.run_cell");
    expect(Ipc.Request.safeParse(req).success).toBe(true);
    expect(req.params).toBe(undefined);
  });

  test("createResponse produces valid response", () => {
    const res = Ipc.createResponse("req-1", { accepted: true });
    expect(Ipc.Response.safeParse(res).success).toBe(true);
    expect(res.type).toBe("response");
    expect(res.id).toBe("req-1");
    expect(res.result).toEqual({ accepted: true });
  });

  test("createErrorResponse produces valid error response", () => {
    const res = Ipc.createErrorResponse("req-1", 2000, "method not found");
    expect(Ipc.Response.safeParse(res).success).toBe(true);
    expect(res.error?.code).toBe(2000);
    expect(res.error?.message).toBe("method not found");
    expect(res.result).toBe(undefined);
  });

  test("createNotification produces valid notification", () => {
    const notif = Ipc.createNotification("machine.detached", { machineId: "m-1" });
    expect(Ipc.Notification.safeParse(notif).success).toBe(true);
    expect(notif.type).toBe("notification");
    expect(notif.method).toBe("machine.detached");
  });

  test("createNotification without params", () => {
    const notif = Ipc.createNotification("ping");
    expect(Ipc.Notification.safeParse(notif).success).toBe(true);
    expect(notif.params).toBe(undefined);
  });
});

describe("Ipc.Methods param schemas", () => {
  test("registers exactly the machine wire methods", () => {
    expect(Object.keys(Ipc.Methods).sort()).toEqual(
      [
        Machine.WireMethod.Attach,
        Machine.WireMethod.Report,
        Machine.WireMethod.Ping,
        Machine.WireMethod.RunCode,
        Machine.WireMethod.CancelCode,
        Machine.WireMethod.PeekCode,
        Machine.WireMethod.Exec,
        Machine.WireMethod.CallTool,
        Machine.WireMethod.ScreenRead,
        Machine.WireMethod.InputWrite,
        Machine.WireMethod.PtyOpen,
        Machine.WireMethod.PtyWrite,
        Machine.WireMethod.PtyRead,
        Machine.WireMethod.PtyResize,
        Machine.WireMethod.PtyClose,
        Machine.WireMethod.PtyList,
        Machine.WireMethod.FsOp,
        Machine.WireMethod.FsStream,
        Machine.WireMethod.AgentSessionList,
        Machine.WireMethod.AgentSessionOpen,
        Machine.WireMethod.AgentSessionTail,
        Machine.WireMethod.AgentSessionSend,
        Machine.WireMethod.AgentSessionStop,
        Machine.WireMethod.AgentPermission,
        Machine.WireMethod.ScreenList,
        Machine.WireMethod.ScreenCapture,
        Machine.WireMethod.InputPointer,
        Machine.WireMethod.InputKey,
        Machine.WireMethod.InputText,
        Machine.WireMethod.InputStatus,
        Machine.WireMethod.ComputerClose,
        Machine.WireMethod.AppLaunch,
        Machine.WireMethod.AppQuit,
        Machine.WireMethod.WindowClose,
        Machine.WireMethod.WindowPark,
        Machine.WireMethod.StreamOpen,
        Machine.WireMethod.StreamSignal,
        Machine.WireMethod.StreamClose,
        Machine.WireMethod.CdpOpen,
        Machine.WireMethod.CdpChunk,
        Machine.WireMethod.CdpClose,
        Machine.WireMethod.ScreenObserve,
        Machine.WireMethod.ScreenSettle,
        Machine.WireMethod.InputAction,
        Machine.WireMethod.EventPrivate,
        Machine.WireMethod.ClipboardRead,
        Machine.WireMethod.ClipboardWrite,
      ].sort(),
    );
  });

  test("machine.fs_op params/result are the Machine fs contracts", () => {
    expect(Ipc.Methods[Machine.WireMethod.FsOp].params).toBe(Machine.FsRequest);
    expect(Ipc.Methods[Machine.WireMethod.FsOp].result).toBe(Machine.FsResult);
  });
  test("machine.fs_stream params/result are the transfer contracts", () => {
    expect(Ipc.Methods[Machine.WireMethod.FsStream].params).toBe(Machine.FsStreamRequest);
    expect(Ipc.Methods[Machine.WireMethod.FsStream].result).toBe(Machine.FsStreamResult);
  });

  test("machine.attach params/result are the Machine offer contracts", () => {
    expect(Ipc.Methods[Machine.WireMethod.Attach].params).toBe(Machine.Offer);
    expect(Ipc.Methods[Machine.WireMethod.Attach].result).toBe(Machine.AttachResult);
  });

  test("ping rejects nonempty params and non-alive results", () => {
    const ping = Ipc.Methods[Machine.WireMethod.Ping];
    expect(ping.params.safeParse({}).success).toBe(true);
    expect(ping.params.safeParse({ unexpected: true }).success).toBe(false);
    expect(ping.result.safeParse({ status: "alive" }).success).toBe(true);
    expect(ping.result.safeParse({ status: "missing" }).success).toBe(false);
  });

  test("machine.run_code params reject a cell request without a timeout", () => {
    const valid = Ipc.Methods[Machine.WireMethod.RunCode].params.safeParse({
      cellId: "cell-1",
      code: "print(1)",
      timeoutMs: 1_000,
    });
    const missingTimeout = Ipc.Methods[Machine.WireMethod.RunCode].params.safeParse({
      cellId: "cell-1",
      code: "print(1)",
    });
    expect(valid.success).toBe(true);
    expect(missingTimeout.success).toBe(false);
  });

  test("machine.call_tool params reject an unnamed tool call", () => {
    const valid = Ipc.Methods[Machine.WireMethod.CallTool].params.safeParse({
      cellId: "cell-1",
      name: "inventory",
      arguments: {},
    });
    const unnamed = Ipc.Methods[Machine.WireMethod.CallTool].params.safeParse({
      cellId: "cell-1",
      name: "",
      arguments: {},
    });
    expect(valid.success).toBe(true);
    expect(unnamed.success).toBe(false);
  });
});
