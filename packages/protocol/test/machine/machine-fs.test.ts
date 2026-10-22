import { describe, expect, test } from "bun:test";
import { Machine } from "../../src/machine/index.js";
import type { PlainValue } from "../../src/json.js";
import { expectIssue } from "../helpers/schema.js";

const enrollment = {
  machineId: "mac-0",
  name: "brain-mac",
  allowedCapabilities: ["fs.read"],
  allowedExports: ["notes", "code"],
  publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  enrolledAt: 1,
} satisfies Machine.Enrollment;

const offer = {
  machineId: "mac-0",
  offeredCapabilities: ["fs.read"],
  exports: [
    { name: "notes", path: "/notes" },
    { name: "screenshots", path: "/screenshots" },
  ],
  daemonVersion: "0.1.0",
  platform: "darwin-arm64",
  offeredAt: 2,
  peer: { kind: "daemon", contractVersion: 2 },
} satisfies Machine.Offer;

describe("Machine.WellKnownCapability.fsRead", () => {
  test("one capability gates the whole read-only fs surface", () => {
    expect(Machine.WellKnownCapability.fsRead).toBe("fs.read");
  });
});

describe("Machine.WireMethod.FsOp", () => {
  test("names the frozen fs wire method", () => {
    expect(Machine.WireMethod.FsOp).toBe("machine.fs_op");
  });
});

describe("Machine.ExportName grammar", () => {
  test("accepts lowercase names with digits, dashes, and underscores", () => {
    for (const name of ["notes", "a", "code-2", "my_export", "x0", "a".repeat(64)]) {
      expect(Machine.Enrollment.shape.allowedExports.unwrap().element.safeParse(name).success).toBe(true);
    }
  });

  test("rejects uppercase, leading digits/symbols, dots, and empty names", () => {
    for (const name of ["Notes", "0notes", "-notes", "_notes", "notes.d", "note s", ""]) {
      const result = Machine.Enrollment.shape.allowedExports.unwrap().element.safeParse(name);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          "export name must be lowercase alphanumeric with - or _ (e.g. notes)",
        );
        expect(result.error.issues[0]?.path).toEqual([]);
      }
    }
  });

  test("rejects names past 64 characters", () => {
    const result = Machine.Enrollment.shape.allowedExports.unwrap().element.safeParse("a".repeat(65));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("export name must be at most 64 characters");
    }
  });
});

describe("Machine.Enrollment.allowedExports", () => {
  test("accepts an enrollment carrying no exports at all", () => {
    const { allowedExports: _omitted, ...withoutExports } = enrollment;
    expect(Machine.Enrollment.safeParse(withoutExports).success).toBe(true);
  });

  test("accepts an explicitly empty allowlist", () => {
    expect(Machine.Enrollment.safeParse({ ...enrollment, allowedExports: [] }).success).toBe(true);
  });

  test("rejects duplicate export names", () => {
    const result = Machine.Enrollment.safeParse({
      ...enrollment,
      allowedExports: ["notes", "notes"],
    });
    expectIssue(result, { message: "export names must be unique", path: "allowedExports" });
  });
});

describe("Machine.Offer.exports", () => {
  test("accepts an offer carrying no exports at all", () => {
    const { exports: _omitted, ...withoutExports } = offer;
    expect(Machine.Offer.safeParse(withoutExports).success).toBe(true);
  });

  test("rejects duplicate export names", () => {
    const result = Machine.Offer.safeParse({
      ...offer,
      exports: [
        { name: "notes", path: "/notes" },
        { name: "notes", path: "/notes" },
      ],
    });
    expectIssue(result, { message: "export names must be unique", path: "exports" });
  });

  test("requires a real absolute export root", () => {
    expect(Machine.Offer.safeParse({ ...offer, exports: [{ name: "notes" }] }).success).toBe(false);
    expect(
      Machine.Offer.safeParse({ ...offer, exports: [{ name: "notes", path: "relative" }] }).success,
    ).toBe(false);
  });
});

describe("machine wire compatibility", () => {
  test("an Enrollment JSON written before exports existed still parses", () => {
    const legacy: PlainValue = JSON.parse(
      '{"machineId":"mac-0","name":"brain-mac","allowedCapabilities":["fs.read"],"publicKey":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","enrolledAt":1}',
    );
    const result = Machine.Enrollment.safeParse(legacy);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowedExports).toBeUndefined();
    }
  });

  test("an Offer JSON without exports parses with no export set", () => {
    const withoutExports: PlainValue = JSON.parse(
      '{"machineId":"mac-0","offeredCapabilities":["fs.read"],"daemonVersion":"0.1.0",' +
        '"platform":"darwin-arm64","offeredAt":2,"peer":{"kind":"daemon","contractVersion":2}}',
    );
    const result = Machine.Offer.safeParse(withoutExports);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.exports).toBeUndefined();
    }
  });

  test("a contract-1 Offer JSON without a peer is refused at peer", () => {
    const contractOne: PlainValue = JSON.parse(
      '{"machineId":"mac-0","offeredCapabilities":["fs.read"],"daemonVersion":"0.1.0",' +
        '"platform":"darwin-arm64","offeredAt":2}',
    );
    expectIssue(Machine.Offer.safeParse(contractOne), { path: "peer" });
  });

  test("an AttachResult without an export ceiling fails closed", () => {
    expect(
      Machine.AttachResult.safeParse({ status: "attached", effectiveCapabilities: ["fs.read"] })
        .success,
    ).toBe(false);
  });

  test("attached carries the negotiated export set when present", () => {
    const result = Machine.AttachResult.safeParse({
      status: "attached",
      effectiveCapabilities: ["fs.read"],
      effectiveExports: ["notes"],
      generation: 1,
    });
    expect(result.success).toBe(true);
  });

  test("attached refuses a duplicated export set", () => {
    const result = Machine.AttachResult.safeParse({
      status: "attached",
      effectiveCapabilities: ["fs.read"],
      effectiveExports: ["notes", "notes"],
    });
    expectIssue(result, { message: "export names must be unique", path: "effectiveExports" });
  });
});

describe("Machine.effectiveExports", () => {
  test("effective = enrollment ∩ offer, sorted ascending", () => {
    expect(Machine.effectiveExports(enrollment, offer)).toEqual({
      kind: "effective",
      machineId: "mac-0",
      exports: ["notes"],
    });
  });

  test("an absent allowlist grants nothing — exports are fail-closed", () => {
    const { allowedExports: _omitted, ...withoutExports } = enrollment;
    expect(Machine.effectiveExports(withoutExports, offer)).toEqual({
      kind: "effective",
      machineId: "mac-0",
      exports: [],
    });
  });

  test("an absent offer yields nothing even with a full allowlist", () => {
    const { exports: _omitted, ...withoutExports } = offer;
    expect(Machine.effectiveExports(enrollment, withoutExports)).toEqual({
      kind: "effective",
      machineId: "mac-0",
      exports: [],
    });
  });

  test("an offered export the Owner never allowed is excluded", () => {
    expect(
      Machine.effectiveExports(enrollment, {
        ...offer,
        exports: [{ name: "screenshots", path: "/screenshots" }],
      }),
    ).toEqual({ kind: "effective", machineId: "mac-0", exports: [] });
  });

  test("intersection of several names stays sorted and deduped", () => {
    const outcome = Machine.effectiveExports(
      { ...enrollment, allowedExports: ["notes", "code", "media"] },
      {
        ...offer,
        exports: [
          { name: "media", path: "/media" },
          { name: "code", path: "/code" },
          { name: "code", path: "/code" },
        ] as Machine.Offer["exports"],
      },
    );
    expect(outcome).toEqual({ kind: "effective", machineId: "mac-0", exports: ["code", "media"] });
  });

  test("mismatched machine ids refuse instead of intersecting", () => {
    expect(Machine.effectiveExports(enrollment, { ...offer, machineId: "mac-1" })).toEqual({
      kind: "machine_mismatch",
      enrolled: "mac-0",
      offered: "mac-1",
    });
  });
});

describe("Machine.FsRequest", () => {
  test("accepts the three read-only ops", () => {
    expect(
      Machine.FsRequest.safeParse({ op: "read", export: "notes", path: "a/b.txt" }).success,
    ).toBe(true);
    expect(Machine.FsRequest.safeParse({ op: "list", export: "notes", path: "" }).success).toBe(
      true,
    );
    expect(Machine.FsRequest.safeParse({ op: "stat", export: "notes", path: "a" }).success).toBe(
      true,
    );
  });

  test("read accepts an offset/limit window", () => {
    expect(
      Machine.FsRequest.safeParse({
        op: "read",
        export: "notes",
        path: "a.txt",
        offset: 0,
        limit: 1,
      }).success,
    ).toBe(true);
  });

  test("read rejects a negative offset and a non-positive limit", () => {
    expect(
      Machine.FsRequest.safeParse({ op: "read", export: "notes", path: "a.txt", offset: -1 })
        .success,
    ).toBe(false);
    expect(
      Machine.FsRequest.safeParse({ op: "read", export: "notes", path: "a.txt", limit: 0 }).success,
    ).toBe(false);
  });

  test("rejects an absolute path — the export root is the only anchor", () => {
    for (const op of ["read", "list", "stat"] as const) {
      const result = Machine.FsRequest.safeParse({ op, export: "notes", path: "/etc/passwd" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          "path must be relative to the export root, with no .. segment or NUL",
        );
        expect(result.error.issues[0]?.path.join(".")).toBe("path");
      }
    }
  });

  test("rejects any .. segment, wherever it sits", () => {
    for (const path of ["..", "../x", "a/../b", "a/..", "a/../../b"]) {
      const result = Machine.FsRequest.safeParse({ op: "list", export: "notes", path });
      expectIssue(result, { path: "path" });
    }
  });

  test("accepts a filename that merely starts with dots", () => {
    expect(
      Machine.FsRequest.safeParse({ op: "stat", export: "notes", path: "..hidden/...x" }).success,
    ).toBe(true);
  });

  test("rejects an embedded NUL", () => {
    const result = Machine.FsRequest.safeParse({
      op: "read",
      export: "notes",
      path: "a\u0000b.txt",
    });
    expectIssue(result, { path: "path" });
  });

  test("rejects an unknown op and unknown fields", () => {
    expect(Machine.FsRequest.safeParse({ op: "write", export: "notes", path: "a" }).success).toBe(
      false,
    );
    const result = Machine.FsRequest.safeParse({
      op: "list",
      export: "notes",
      path: "",
      recursive: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });

  test("rejects an export name that breaks the grammar", () => {
    const result = Machine.FsRequest.safeParse({ op: "list", export: "Notes", path: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path.join(".")).toBe("export");
    }
  });
});

describe("Machine.FsResult", () => {
  test("completed read carries decoded text plus truncation facts", () => {
    const result = Machine.FsResult.safeParse({
      status: "completed",
      value: { op: "read", data: "aGVsbG8=", bytesRead: 5, size: 5, truncated: false },
    });
    expect(result.success).toBe(true);
  });

  test("completed list carries entry kinds and optional sizes", () => {
    const result = Machine.FsResult.safeParse({
      status: "completed",
      value: {
        op: "list",
        entries: [
          { name: "a.txt", kind: "file", size: 3 },
          { name: "sub", kind: "dir" },
          { name: "link", kind: "symlink" },
          { name: "sock", kind: "other" },
        ],
        truncated: true,
      },
    });
    expect(result.success).toBe(true);
  });

  test("completed stat carries kind, size, and mtime", () => {
    const result = Machine.FsResult.safeParse({
      status: "completed",
      value: { op: "stat", kind: "file", size: 12, mtimeMs: 1_700_000_000_000 },
    });
    expect(result.success).toBe(true);
  });

  test("rejects a value whose op does not match its shape", () => {
    expect(
      Machine.FsResult.safeParse({
        status: "completed",
        value: { op: "stat", data: "aGVsbG8=", bytesRead: 5, size: 5, truncated: false },
      }).success,
    ).toBe(false);
  });

  test("rejects an unknown entry kind", () => {
    const result = Machine.FsResult.safeParse({
      status: "completed",
      value: { op: "list", entries: [{ name: "a", kind: "device" }], truncated: false },
    });
    expect(result.success).toBe(false);
  });

  test("parses every refusal reason with a message", () => {
    for (const reason of [
      "export_not_available",
      "path_escapes_export",
      "not_found",
      "wrong_kind",
      "io_error",
    ] as const) {
      expect(Machine.FsResult.safeParse({ status: "refused", reason, message: "no" }).success).toBe(
        true,
      );
    }
  });

  test("refuses an unknown reason and an empty message", () => {
    const unknown = Machine.FsResult.safeParse({
      status: "refused",
      reason: "permission_denied",
      message: "no",
    });
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.error.issues[0]?.path.join(".")).toBe("reason");
    }
    const empty = Machine.FsResult.safeParse({
      status: "refused",
      reason: "not_found",
      message: "",
    });
    expect(empty.success).toBe(false);
    if (!empty.success) {
      expect(empty.error.issues[0]?.path.join(".")).toBe("message");
    }
  });

  test("refused carries no value", () => {
    const result = Machine.FsResult.safeParse({
      status: "refused",
      reason: "not_found",
      message: "gone",
      value: { op: "stat", kind: "file", size: 0, mtimeMs: 0 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });
});

describe("write, exec and cancellation wire contracts", () => {
  test("write bytes are lossless base64 and malformed input is rejected", () => {
    expect(
      Machine.FsRequest.parse({ op: "write", export: "notes", path: "binary", data: "AP+AQQ==" }),
    ).toEqual({ op: "write", export: "notes", path: "binary", data: "AP+AQQ==" });
    expect(
      Machine.FsRequest.safeParse({
        op: "write",
        export: "notes",
        path: "binary",
        data: "!invalid",
      }).success,
    ).toBe(false);
    expect(
      Machine.FsResult.parse({ status: "completed", value: { op: "write", bytesWritten: 4 } }),
    ).toMatchObject({ value: { bytesWritten: 4 } });
  });
  test("exec always requires a real absolute cwd and preserves terminals", () => {
    expect(Machine.ExecRequest.safeParse({ cmd: "pwd" }).success).toBe(false);
    expect(Machine.ExecRequest.safeParse({ cmd: "pwd", cwd: "relative" }).success).toBe(false);
    expect(Machine.ExecRequest.safeParse({ cmd: "pwd", cwd: "/a/../b" }).success).toBe(false);
    expect(
      Machine.ExecResult.parse({
        status: "completed",
        stdout: "AP8=",
        stderr: "",
        exitCode: null,
        signal: "SIGTERM",
        truncated: false,
      }),
    ).toMatchObject({ stdout: "AP8=", signal: "SIGTERM" });
    const interrupted = {
      status: "cancelled" as const,
      cellId: "cancel",
      output: { stdout: "so far", stderr: "" },
    };
    expect(Machine.CellResult.parse(interrupted)).toEqual(interrupted);
    // An interrupted cell keeps the output it produced; the bare terminal is retired.
    expect(Machine.CellResult.safeParse({ status: "cancelled", cellId: "cancel" }).success).toBe(
      false,
    );
    expect(Machine.CellState.parse({ ...interrupted, status: "running" })).toMatchObject({
      status: "running",
    });
    expect(Machine.CellResult.safeParse({ ...interrupted, status: "running" }).success).toBe(false);
    expect(Machine.CancelCode.safeParse({ cellId: "" }).success).toBe(false);
    expect(Machine.PeekCode.safeParse({ cellId: "" }).success).toBe(false);
  });
});

describe("machine fs limits", () => {
  test("protocol owns the single read/list ceiling the daemon enforces", () => {
    expect(Machine.FS_READ_MAX_BYTES).toBe(262_144);
    expect(Machine.FS_LIST_MAX_ENTRIES).toBe(1000);
  });
  test("stream frames carry a bounded sequence, terminal digest, and transfer id", () => {
    const transferId = "transfer-1";
    expect(Machine.FsStreamRequest.parse({
      op: "begin", transferId, mode: "write", export: "data", path: "file",
    })).toMatchObject({ op: "begin", transferId });
    expect(Machine.FsStreamRequest.safeParse({
      op: "write", transferId, seq: -1, data: "", last: true, digest: "0".repeat(64),
    }).success).toBe(false);
    expect(Machine.FsStreamResult.parse({
      status: "chunk", seq: 0, data: "YQ==", last: true, digest: "a".repeat(64),
    })).toMatchObject({ status: "chunk", seq: 0 });
  });
});

describe("machine cell output bound", () => {
  test("accepts legacy and truncated streams, but rejects unknown fields and oversized output", () => {
    const legacy = { stdout: "ok", stderr: "" };
    expect(Machine.CellOutput.parse(legacy)).toEqual(legacy);
    const bounded = { ...legacy, truncated: { stdout: { originalBytes: Machine.CELL_OUTPUT_MAX_BYTES + 1 } } };
    expect(Machine.CellOutput.parse(bounded)).toEqual(bounded);
    expect(Machine.CellOutput.safeParse({ ...bounded, unexpected: true }).success).toBe(false);
    expect(Machine.CellOutput.safeParse({ ...legacy, truncated: { stderr: { originalBytes: 1, extra: true } } }).success).toBe(false);
    expect(Machine.CellOutput.safeParse({ ...legacy, stdout: "x".repeat(Machine.CELL_OUTPUT_MAX_BYTES + 1) }).success).toBe(false);
  });
});
