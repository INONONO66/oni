import { describe, expect, test } from "bun:test";
import { Machine } from "../../src/machine/index.js";
import { Ipc } from "../../src/ipc/index.js";
import { expectIssue } from "../helpers/schema.js";

const enrollment = {
  machineId: "mac-0",
  name: "brain-mac",
  allowedCapabilities: ["fs.read", "fs.write", "shell.exec", "kernel.py"],
  publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  enrolledAt: 1,
} satisfies Machine.Enrollment;

const offer = {
  machineId: "mac-0",
  offeredCapabilities: ["fs.read", "shell.exec", "screen.read"],
  daemonVersion: "0.1.0",
  platform: "darwin-arm64",
  offeredAt: 2,
  peer: { kind: "daemon", contractVersion: 2 },
} satisfies Machine.Offer;

describe("managed machine enrollment", () => {
  test("gateway rows preserve capacity and load, refusing invented fields", () => {
    const row = { ...enrollment, tags: ["pool"], capabilities: ["fs.read"], os: "darwin", arch: "arm64",
      resources: { cpus: 4, memoryBytes: 8192 },
      live: { reportedAt: 4, stale: false, load: { loadAvg1: 0.5, memoryAvailableBytes: 4096, inFlight: 1 } } };
    const reply = { type: "machine_listed", requestId: "list", rows: [row] } satisfies Machine.Response;
    expect(Machine.Response.parse(reply)).toEqual(reply);
    expect(Machine.Info.safeParse({ ...row, leases: 1 }).success).toBe(false);
    expect(Machine.Request.safeParse({ type: "machine_list", requestId: "list", machineId: "extra" }).success).toBe(false);
  });
  test("enrollment facts and detach reasons validate their authority evidence", () => {
    expect(Machine.Events.Enrolled.schema.parse({ machineId: enrollment.machineId, time: 1, enrollment }))
      .toEqual({ machineId: enrollment.machineId, time: 1, enrollment });
    expect(Machine.Events.Unenrolled.schema.parse({ machineId: enrollment.machineId, time: 2 }))
      .toEqual({ machineId: enrollment.machineId, time: 2 });
    for (const reason of ["enrollment_removed", "enrollment_replaced"] as const)
      expect(Machine.Events.Detached.schema.parse({ machineId: enrollment.machineId, time: 2, reason }).reason).toBe(reason);
    expect(Machine.Events.Detached.schema.safeParse({ machineId: enrollment.machineId, time: 2, reason: "untyped" }).success).toBe(false);
  });
});

describe("Machine.WellKnownCapability", () => {
  test("exports the Python kernel capability", () => {
    expect(Machine.WellKnownCapability.pythonKernel).toBe("kernel.py");
  });
});

describe("Machine.CapabilityId grammar", () => {
  test("accepts dot-namespaced lowercase ids", () => {
    for (const id of ["fs.read", "kernel.py", "screen.read", "input.write", "a.b_c.d0", "a.b"]) {
      expect(Machine.CapabilityId.safeParse(id).success).toBe(true);
    }
  });

  test("rejects single-segment, uppercase, and empty ids with the grammar message", () => {
    for (const id of ["fs", "Fs.read", "fs.", ".read", "", "fs..read", "fs.Read"]) {
      const result = Machine.CapabilityId.safeParse(id);
      expectIssue(result, {
        message: "capability id must be dot-namespaced lowercase (e.g. fs.read)",
        path: [],
      });
    }
  });

  test("rejects ids past 128 characters", () => {
    const result = Machine.CapabilityId.safeParse(`fs.${"a".repeat(130)}`);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("capability id must be at most 128 characters");
      expect(result.error.issues[0]?.path).toEqual([]);
    }
  });
});

describe("Machine.Enrollment", () => {
  test("rejects duplicate capabilities", () => {
    const result = Machine.Enrollment.safeParse({
      ...enrollment,
      allowedCapabilities: ["fs.read", "fs.read"],
    });
    expectIssue(result, { message: "capabilities must be unique", path: "allowedCapabilities" });
  });

  test("rejects an empty allowlist — an enrolled machine with no capability is a contradiction", () => {
    const result = Machine.Enrollment.safeParse({ ...enrollment, allowedCapabilities: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path.join(".")).toBe("allowedCapabilities");
      expect(result.error.issues[0]?.code).toBe("too_small");
    }
  });

  test("rejects unknown fields", () => {
    const result = Machine.Enrollment.safeParse({ ...enrollment, extra: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "extra"');
      expect(result.error.issues[0]?.path).toEqual([]);
    }
  });
});

describe("Machine.Offer", () => {
  test("accepts an empty offer — a daemon may attach able to do nothing yet", () => {
    expect(Machine.Offer.safeParse({ ...offer, offeredCapabilities: [] }).success).toBe(true);
  });

  test("rejects duplicate capabilities", () => {
    const result = Machine.Offer.safeParse({
      ...offer,
      offeredCapabilities: ["fs.read", "fs.read"],
    });
    expectIssue(result, { message: "capabilities must be unique", path: "offeredCapabilities" });
  });

  test("carries optional whole-number capacity facts and refuses a zero cpu count", () => {
    const resources = { cpus: 4, memoryBytes: 8 * 1024 ** 3 };
    expect(Machine.Offer.parse({ ...offer, resources })).toEqual({ ...offer, resources });
    expect(Machine.Offer.safeParse({ ...offer, resources: { ...resources, cpus: 0 } }).success).toBe(false);
  });
});

describe("machine.report heartbeat (#1555)", () => {
  const load = { loadAvg1: 0.5, memoryAvailableBytes: 1024, inFlight: 2 };

  test("the wire method is registered with the report and result schemas", () => {
    expect(Machine.WireMethod.Report).toBe("machine.report");
    expect(Ipc.Methods["machine.report"].params).toBe(Machine.Report);
    expect(Ipc.Methods["machine.report"].result).toBe(Machine.ReportResult);
  });

  test("a report round-trips, refuses a negative load average, and the event carries the same load", () => {
    const report = { machineId: "mac-0", reportedAt: 3, load };
    expect(Machine.Report.parse(report)).toEqual(report);
    expect(Machine.Report.safeParse({ ...report, load: { ...load, loadAvg1: -1 } }).success).toBe(false);
    expect(Machine.Events.Reported.name).toBe("machine.reported");
    expect(Machine.Events.Reported.visibility).toBe("ephemeral");
    expect(Machine.Events.Reported.schema.parse({ machineId: "mac-0", time: 3, reportedAt: 2, load })).toEqual({ machineId: "mac-0", time: 3, reportedAt: 2, load });
  });

  test("a refusal names one of the two host reasons and nothing else", () => {
    expect(Machine.ReportResult.parse({ status: "refused", reason: "machine_mismatch" })).toEqual({ status: "refused", reason: "machine_mismatch" });
    expect(Machine.ReportResult.safeParse({ status: "refused", reason: "unknown" }).success).toBe(false);
    expect(Machine.ReportResult.safeParse({ status: "accepted", extra: true }).success).toBe(false);
  });
});

describe("Machine.effectiveCapabilities", () => {
  test("effective = enrollment ∩ offer, sorted ascending", () => {
    const outcome = Machine.effectiveCapabilities(enrollment, offer);
    expect(outcome).toEqual({
      kind: "effective",
      machineId: "mac-0",
      capabilities: ["fs.read", "shell.exec"],
    });
  });

  test("an offered capability the Owner never allowed is excluded", () => {
    const outcome = Machine.effectiveCapabilities(enrollment, {
      ...offer,
      offeredCapabilities: ["screen.read", "input.write"],
    });
    expect(outcome).toEqual({ kind: "effective", machineId: "mac-0", capabilities: [] });
  });

  test("structurally duplicated offers still yield a set", () => {
    const outcome = Machine.effectiveCapabilities(enrollment, {
      ...offer,
      offeredCapabilities: [
        "fs.read",
        "fs.read",
      ] as string[] as Machine.Offer["offeredCapabilities"],
    });
    expect(outcome).toEqual({ kind: "effective", machineId: "mac-0", capabilities: ["fs.read"] });
  });

  test("mismatched machine ids refuse instead of intersecting", () => {
    const outcome = Machine.effectiveCapabilities(enrollment, { ...offer, machineId: "mac-1" });
    expect(outcome).toEqual({ kind: "machine_mismatch", enrolled: "mac-0", offered: "mac-1" });
  });
});

describe("machine.attached event payload", () => {
  test("rejects a duplicated effective set", () => {
    const result = Machine.Events.Attached.schema.safeParse({
      machineId: "mac-0",
      time: 1,
      effectiveCapabilities: ["fs.read", "fs.read"],
    });
    expectIssue(result, { message: "capabilities must be unique", path: "effectiveCapabilities" });
  });
});

describe("Machine.AttachResult", () => {
  test("attached refuses a duplicated effective set", () => {
    const result = Machine.AttachResult.safeParse({
      status: "attached",
      effectiveCapabilities: ["fs.read", "fs.read"],
    });
    expectIssue(result, { message: "capabilities must be unique", path: "effectiveCapabilities" });
  });

  test("refused accepts only the enrollment refusal vocabulary", () => {
    const result = Machine.AttachResult.safeParse({ status: "refused", reason: "bad_weather" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("invalid_value");
      expect(result.error.issues[0]?.path.join(".")).toBe("reason");
    }
  });

  test("attached carries the admitted generation and refuses one below 1", () => {
    const attached = { status: "attached", effectiveCapabilities: [], effectiveExports: [], generation: 3 } satisfies Machine.AttachResult;
    expect(Machine.AttachResult.parse(attached)).toEqual(attached);
    expectIssue(Machine.AttachResult.safeParse({ ...attached, generation: 0 }), { path: "generation" });
  });

  test("refused vocabulary includes already_attached (#1271 self hijack refusal)", () => {
    const result = Machine.AttachResult.safeParse({ status: "refused", reason: "already_attached" });
    expect(result.success).toBe(true);
  });

  test("refused carries no capability set", () => {
    const result = Machine.AttachResult.safeParse({
      status: "refused",
      reason: "machine_not_enrolled",
      effectiveCapabilities: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
      expect(result.error.issues[0]?.message).toBe('Unrecognized key: "effectiveCapabilities"');
      expect(result.error.issues[0]?.path).toEqual([]);
    }
  });
});

describe("Machine.place", () => {
  const member = (machineId: string, leases = 0, resources: Machine.Resources | undefined = { cpus: 4, memoryBytes: 100 }) => ({
    machineId,
    tags: ["worker"],
    capabilities: ["kernel.py"],
    resources,
    leases,
  });

  test.each([
    ["spread", { kind: "placed", machineId: "a" }],
    ["pack", { kind: "placed", machineId: "b" }],
    ["exclusive", { kind: "placed", machineId: "a" }],
  ] as const)("%s chooses by its policy", (prefer: "spread" | "pack" | "exclusive", expected: { kind: "placed"; machineId: string }) => {
    expect(Machine.place({ tag: "worker", prefer }, [member("a", 0), member("b", 2)])).toEqual(expected);
  });

  test("sticky placement is stable and losing one member only remaps its keys", () => {
    const members = [member("a"), member("b"), member("c")];
    const first = Machine.place({ tag: "worker", prefer: { sticky: "key-1" } }, members);
    expect(first).toEqual(Machine.place({ tag: "worker", prefer: { sticky: "key-1" } }, members));
    if (first.kind !== "placed") throw new Error("expected a placement");
    const withoutWinner = members.filter((entry) => entry.machineId !== first.machineId);
    expect(Machine.place({ tag: "worker", prefer: { sticky: "key-1" } }, withoutWinner).kind).toBe("placed");
  });

  test("sticky placement excludes unknown-capacity members when known credit exists", () => {
    expect(Machine.place({ tag: "worker", prefer: { sticky: "key-1" } }, [
      { ...member("unknown"), resources: undefined },
      member("known"),
    ])).toEqual({ kind: "placed", machineId: "known" });
  });

  test("skips stale members and reports all stale", () => {
    expect(Machine.place({ tag: "worker", prefer: "spread" }, [{ ...member("a"), live: { stale: true } }, member("b")])).toEqual({ kind: "placed", machineId: "b" });
    expect(Machine.place({ tag: "worker", prefer: "spread" }, [{ ...member("a"), live: { stale: true } }, { ...member("b"), live: { stale: true } }])).toEqual({ kind: "all_stale" });
  });

  test("reports saturation and ranks unknown resources last", () => {
    expect(Machine.place({ tag: "worker", prefer: "spread" }, [member("a", 4), member("b", 0)])).toEqual({ kind: "placed", machineId: "b" });
    expect(Machine.place({ tag: "worker", prefer: "spread" }, [member("a", 4), member("b", 4)])).toEqual({ kind: "machine_saturated" });
    expect(Machine.place({ tag: "worker", prefer: "spread" }, [{ ...member("a"), resources: undefined }, member("b", 0)])).toEqual({ kind: "placed", machineId: "b" });
    expect(Machine.place({ tag: "worker", prefer: "spread" }, [{ ...member("a"), slots: 2 }, member("b", 0)])).toEqual({ kind: "placed", machineId: "a" });
  });

  test("breaks equal scores by machine id", () => {
    expect(Machine.place({ tag: "worker", prefer: "spread" }, [member("z"), member("a")])).toEqual({ kind: "placed", machineId: "a" });
  });
});
