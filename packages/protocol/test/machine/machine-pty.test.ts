import { describe, expect, test } from "bun:test";
import { Machine } from "../../src/machine/index.js";
import { Ipc } from "../../src/ipc/index.js";
import { expectIssue } from "../helpers/schema.js";

const data = Buffer.from("echo hi\r").toString("base64");

describe("pty capability id and wire methods", () => {
  test("well-known id and wire method names are frozen", () => {
    expect(Machine.WellKnownCapability.ptySession).toBe("pty.session");
    expect(Machine.WireMethod.PtyOpen).toBe("machine.pty_open");
    expect(Machine.WireMethod.PtyWrite).toBe("machine.pty_write");
    expect(Machine.WireMethod.PtyRead).toBe("machine.pty_read");
    expect(Machine.WireMethod.PtyResize).toBe("machine.pty_resize");
    expect(Machine.WireMethod.PtyClose).toBe("machine.pty_close");
    expect(Machine.WireMethod.PtyList).toBe("machine.pty_list");
    expect(Machine.WireMethod.PtyOutput).toBe("machine.pty_output");
  });

  test("the ipc method table carries all six request contracts", () => {
    expect(Ipc.Methods["machine.pty_open"]).toEqual({
      params: Machine.PtyOpenRequest,
      result: Machine.PtyOpenResult,
    });
    expect(Ipc.Methods["machine.pty_write"]).toEqual({
      params: Machine.PtyWriteRequest,
      result: Machine.PtyWriteResult,
    });
    // pty_read answers either read mode (#1510): the table's result accepts both.
    expect(Ipc.Methods["machine.pty_read"].params).toBe(Machine.PtyReadParams);
    const stream: Machine.PtyReadResult = { status: "ok", data, cursor: "g.9", truncated: false };
    const screen: Machine.PtyScreenResult = { status: "ok", rows: ["$ "], cursor: { x: 2, y: 0 }, occupant: null, observedAt: 5 };
    expect(Ipc.Methods["machine.pty_read"].result.parse(stream)).toEqual(stream);
    expect(Ipc.Methods["machine.pty_read"].result.parse(screen)).toEqual(screen);
    expect(Ipc.Methods["machine.pty_read"].result.safeParse({ status: "ok" }).success).toBe(false);
    expect(Ipc.Methods["machine.pty_resize"]).toEqual({
      params: Machine.PtyResizeRequest,
      result: Machine.PtyResizeResult,
    });
    expect(Ipc.Methods["machine.pty_close"]).toEqual({
      params: Machine.PtyCloseRequest,
      result: Machine.PtyCloseResult,
    });
    expect(Ipc.Methods["machine.pty_list"]).toEqual({
      params: Machine.PtyListRequest,
      result: Machine.PtyListResult,
    });
  });

  test("the wake-up notification has no entry in the request table and a name-only payload", () => {
    expect("machine.pty_output" in Ipc.Methods).toBe(false);
    expect(Machine.PtyOutput.parse({ name: "build" })).toEqual({ name: "build" });
    expect(Machine.PtyOutput.safeParse({ name: "build", data }).success).toBe(false);
  });
});

describe("Machine.PtySessionName", () => {
  test("accepts flat lowercase names with - and _", () => {
    for (const name of ["qa", "build-2", "a", "x_1", "0abc"]) {
      expect(Machine.PtySessionName.parse(name)).toBe(name);
    }
  });

  test.each(["", "QA", "a.b", "a:b", "-lead", "_lead", "a b", "a/b", "a".repeat(65)])(
    "rejects %j (tmux target syntax and shell-hostile shapes)",
    (name) => {
      expect(Machine.PtySessionName.safeParse(name).success).toBe(false);
    },
  );
});

describe("Machine.PtyOpenRequest / PtyOpenResult", () => {
  test("requires a session name and an absolute cwd, nothing else", () => {
    expect(Machine.PtyOpenRequest.parse({ name: "qa", cwd: "/tmp" })).toEqual({
      name: "qa",
      cwd: "/tmp",
    });
    expectIssue(Machine.PtyOpenRequest.safeParse({ name: "qa", cwd: "relative" }), {
      path: "cwd",
    });
    expect(Machine.PtyOpenRequest.safeParse({ name: "qa", cwd: "/a/../b" }).success).toBe(false);
    expect(Machine.PtyOpenRequest.safeParse({ name: "qa" }).success).toBe(false);
    expect(Machine.PtyOpenRequest.safeParse({ name: "qa", cwd: "/", extra: 1 }).success).toBe(false);
  });

  test("ok carries a cursor; refusals carry only the typed reasons", () => {
    expect(Machine.PtyOpenResult.parse({ status: "ok", cursor: "g.0" })).toEqual({
      status: "ok",
      cursor: "g.0",
    });
    expect(Machine.PtyOpenResult.safeParse({ status: "ok" }).success).toBe(false);
    for (const reason of ["machine_not_attached", "pty_not_available", "path_escapes_export", "pty_not_found"]) {
      expect(Machine.PtyOpenResult.parse({ status: "refused", reason })).toEqual({
        status: "refused",
        reason: reason as "pty_not_available",
      });
    }
    expect(Machine.PtyOpenResult.safeParse({ status: "refused", reason: "nonsense" }).success).toBe(false);
  });
});

describe("Machine.PtyWriteRequest / PtyWriteResult", () => {
  test("accepts base64 input bytes bounded by PTY_WRITE_MAX_BYTES", () => {
    expect(Machine.PtyWriteRequest.parse({ name: "qa", data })).toEqual({ name: "qa", data });
    const overCap = Buffer.alloc(Machine.PTY_WRITE_MAX_BYTES + 3).toString("base64");
    expect(Machine.PtyWriteRequest.safeParse({ name: "qa", data: overCap }).success).toBe(false);
    expect(Machine.PtyWriteRequest.safeParse({ name: "qa", data: "not base64!" }).success).toBe(false);
    expect(Machine.PtyWriteRequest.safeParse({ name: "qa" }).success).toBe(false);
  });

  test("write settles ok or one of the three session refusals", () => {
    expect(Machine.PtyWriteResult.parse({ status: "ok" })).toEqual({ status: "ok" });
    for (const reason of ["machine_not_attached", "pty_not_available", "pty_not_found"]) {
      expect(Machine.PtyWriteResult.parse({ status: "refused", reason })).toEqual({
        status: "refused",
        reason: reason as "pty_not_found",
      });
    }
    expect(Machine.PtyWriteResult.safeParse({ status: "refused", reason: "path_escapes_export" }).success).toBe(false);
    expect(Machine.PtyWriteResult.safeParse({ status: "ok", data }).success).toBe(false);
  });
});

describe("Machine.PtyReadRequest / PtyReadResult", () => {
  test("cursor and waitMs are optional; waitMs is bounded by PTY_READ_WAIT_MAX_MS", () => {
    expect(Machine.PtyReadRequest.parse({ name: "qa" })).toEqual({ name: "qa" });
    expect(Machine.PtyReadRequest.parse({ name: "qa", cursor: "g.42", waitMs: 100 })).toEqual({
      name: "qa",
      cursor: "g.42",
      waitMs: 100,
    });
    expect(
      Machine.PtyReadRequest.safeParse({ name: "qa", waitMs: Machine.PTY_READ_WAIT_MAX_MS + 1 }).success,
    ).toBe(false);
    expect(Machine.PtyReadRequest.safeParse({ name: "qa", waitMs: -1 }).success).toBe(false);
    expect(Machine.PtyReadRequest.safeParse({ name: "qa", cursor: "" }).success).toBe(false);
    expect(Machine.PtyReadRequest.safeParse({ name: "qa", source: "screen" }).success).toBe(false);
  });

  test("source: screen selects the snapshot mode and admits no stream options (#1510)", () => {
    expect(Machine.PtyReadParams.parse({ name: "qa" })).toEqual({ name: "qa" });
    expect(Machine.PtyReadParams.parse({ name: "qa", cursor: "g.42", waitMs: 100 })).toEqual({
      name: "qa",
      cursor: "g.42",
      waitMs: 100,
    });
    expect(Machine.PtyReadParams.parse({ name: "qa", source: "screen" })).toEqual({ name: "qa", source: "screen" });
    expect(Machine.PtyReadScreenRequest.parse({ name: "qa", source: "screen" })).toEqual({
      name: "qa",
      source: "screen",
    });
    // One enforcement layer: mixing the modes fails both strict members.
    expect(Machine.PtyReadParams.safeParse({ name: "qa", source: "screen", cursor: "g.1" }).success).toBe(false);
    expect(Machine.PtyReadParams.safeParse({ name: "qa", source: "screen", waitMs: 1 }).success).toBe(false);
    expect(Machine.PtyReadParams.safeParse({ name: "qa", source: "stream" }).success).toBe(false);
    expect(Machine.PtyReadParams.safeParse({ name: "QA", source: "screen" }).success).toBe(false);
    expect(Machine.PtyReadScreenRequest.safeParse({ name: "qa" }).success).toBe(false);
  });

  test("a screen snapshot carries rows, cursor, occupant-or-null and observedAt, nothing else (#1510)", () => {
    const occupied: Extract<Machine.PtyScreenResult, { status: "ok" }> = {
      status: "ok",
      rows: ["\u001b[1m$\u001b[0m printf hi", "hi", ""],
      cursor: { x: 2, y: 2 },
      occupant: { pid: 4242, command: "zsh" },
      observedAt: 1_700_000_000_000.5,
    };
    expect(Machine.PtyScreenResult.parse(occupied)).toEqual(occupied);
    const vacant = { ...occupied, occupant: null };
    expect(Machine.PtyScreenResult.parse(vacant)).toEqual(vacant);
    expect(Machine.PtyScreenResult.safeParse({ ...occupied, occupant: { pid: 0, command: "zsh" } }).success).toBe(false);
    expect(Machine.PtyScreenResult.safeParse({ ...occupied, occupant: { pid: 1 } }).success).toBe(false);
    expect(Machine.PtyScreenResult.safeParse({ ...occupied, cursor: { x: -1, y: 0 } }).success).toBe(false);
    expect(Machine.PtyScreenResult.safeParse({ ...occupied, cursor: { x: 0, y: 0, z: 0 } }).success).toBe(false);
    expect(Machine.PtyScreenResult.safeParse({ ...occupied, observedAt: -1 }).success).toBe(false);
    expect(Machine.PtyScreenResult.safeParse({ ...occupied, rows: Array.from({ length: Machine.PTY_MAX_ROWS + 1 }, () => "") }).success).toBe(false);
    expect(Machine.PtyScreenResult.safeParse({ ...occupied, idle: true }).success).toBe(false);
    expect(Machine.PtyScreenResult.safeParse({ status: "ok", data, cursor: "g.9", truncated: false }).success).toBe(false);
    for (const reason of ["machine_not_attached", "pty_not_available", "pty_not_found"]) {
      expect(Machine.PtyScreenResult.parse({ status: "refused", reason })).toEqual({
        status: "refused",
        reason: reason as "pty_not_found",
      });
    }
    expect(Machine.PtyScreenResult.safeParse({ status: "refused", reason: "path_escapes_export" }).success).toBe(false);
  });

  test("ok always carries data, cursor, and the truncation flag", () => {
    expect(Machine.PtyReadResult.parse({ status: "ok", data, cursor: "g.9", truncated: false })).toEqual({
      status: "ok",
      data,
      cursor: "g.9",
      truncated: false,
    });
    expect(Machine.PtyReadResult.safeParse({ status: "ok", data, cursor: "g.9" }).success).toBe(false);
    const overCap = "A".repeat(Math.ceil(Machine.PTY_READ_MAX_BYTES / 3) * 4 + 4);
    expect(
      Machine.PtyReadResult.safeParse({ status: "ok", data: overCap, cursor: "g.9", truncated: true }).success,
    ).toBe(false);
    expect(Machine.PtyReadResult.parse({ status: "refused", reason: "pty_not_found" })).toEqual({
      status: "refused",
      reason: "pty_not_found",
    });
  });
});

describe("Machine.PtyResizeRequest / PtyResizeResult", () => {
  test("cols and rows are positive integers bounded by the protocol ceilings", () => {
    expect(Machine.PtyResizeRequest.parse({ name: "qa", cols: 120, rows: 40 })).toEqual({
      name: "qa",
      cols: 120,
      rows: 40,
    });
    expect(Machine.PtyResizeRequest.safeParse({ name: "qa", cols: 0, rows: 40 }).success).toBe(false);
    expect(
      Machine.PtyResizeRequest.safeParse({ name: "qa", cols: Machine.PTY_MAX_COLS + 1, rows: 1 }).success,
    ).toBe(false);
    expect(
      Machine.PtyResizeRequest.safeParse({ name: "qa", cols: 1, rows: Machine.PTY_MAX_ROWS + 1 }).success,
    ).toBe(false);
    expect(Machine.PtyResizeRequest.safeParse({ name: "qa", cols: 1.5, rows: 1 }).success).toBe(false);
    expect(Machine.PtyResizeResult.parse({ status: "ok" })).toEqual({ status: "ok" });
    expect(Machine.PtyResizeResult.parse({ status: "refused", reason: "pty_not_found" })).toEqual({
      status: "refused",
      reason: "pty_not_found",
    });
  });
});

describe("Machine.PtyCloseRequest / PtyCloseResult", () => {
  test("close names exactly one session and settles ok or refused", () => {
    expect(Machine.PtyCloseRequest.parse({ name: "qa" })).toEqual({ name: "qa" });
    expect(Machine.PtyCloseRequest.safeParse({}).success).toBe(false);
    expect(Machine.PtyCloseRequest.safeParse({ name: "qa", force: true }).success).toBe(false);
    expect(Machine.PtyCloseResult.parse({ status: "ok" })).toEqual({ status: "ok" });
    expect(Machine.PtyCloseResult.parse({ status: "refused", reason: "pty_not_available" })).toEqual({
      status: "refused",
      reason: "pty_not_available",
    });
  });
});

describe("Machine.PtyListRequest / PtyListResult", () => {
  test("list takes no fields and answers bounded live/lost rows", () => {
    expect(Machine.PtyListRequest.parse({})).toEqual({});
    expect(Machine.PtyListRequest.safeParse({ filter: "x" }).success).toBe(false);
    expect(
      Machine.PtyListResult.parse({
        status: "ok",
        sessions: [
          { name: "qa", status: "live" },
          { name: "old", status: "lost" },
        ],
        truncated: false,
      }),
    ).toEqual({
      status: "ok",
      sessions: [
        { name: "qa", status: "live" },
        { name: "old", status: "lost" },
      ],
      truncated: false,
    });
    expect(
      Machine.PtyListResult.safeParse({
        status: "ok",
        sessions: [{ name: "qa", status: "open" }],
        truncated: false,
      }).success,
    ).toBe(false);
    const sessions = Array.from({ length: Machine.PTY_LIST_MAX_SESSIONS + 1 }, (_, index) => ({
      name: `s${index}`,
      status: "live" as const,
    }));
    expect(Machine.PtyListResult.safeParse({ status: "ok", sessions, truncated: true }).success).toBe(false);
    expect(Machine.PtyListResult.parse({ status: "refused", reason: "pty_not_available" })).toEqual({
      status: "refused",
      reason: "pty_not_available",
    });
    expect(Machine.PtyListResult.safeParse({ status: "refused", reason: "pty_not_found" }).success).toBe(false);
  });
});
