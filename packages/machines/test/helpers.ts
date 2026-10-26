import { expect } from "bun:test";
import type { Machine } from "@oni/protocol";
import { createMachineHost } from "./helpers/native";
import { attachMclient } from "./helpers/mclient";
import { eventCollector } from "./helpers/events";

const capabilities = ["fs.read", "fs.write", "shell.exec", "kernel.py"];
export function enrollment(): Machine.Enrollment {
  return {
    machineId: "m-1",
    name: "workstation",
    allowedCapabilities: capabilities,
    allowedExports: ["docs"],
    publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    enrolledAt: 1,
  };
}
export function offer(root: string, changes: Partial<Omit<Machine.Offer, "peer" | "generation">> = {}): Omit<Machine.Offer, "peer" | "generation"> {
  return {
    machineId: "m-1",
    offeredCapabilities: capabilities,
    exports: [{ name: "docs", path: root }],
    daemonVersion: "test",
    platform: "darwin-arm64",
    offeredAt: 2,
    ...changes,
  };
}
export const silent = { publish: () => undefined };

export async function wireHost(socketPath: string) {
  const events = eventCollector();
  const host = await createMachineHost({ listen: { unix: socketPath }, enrollment, events: events.sink, now: () => 3 });
  return { ...host, events };
}

export async function wireDaemon(host: Awaited<ReturnType<typeof wireHost>>, root: string) {
  const client = await attachMclient({ host, events: host.events, machineId: "m-1", root, exports: [{ name: "docs", path: root }] });
  return { ...client, close: client.stop };
}

type FsCall = (request: Machine.FsRequest) => Promise<Machine.FsResult>;

export async function expectInsideRead(fsOp: FsCall, path: string) {
  await expect(fsOp({ op: "read", export: "docs", path })).resolves.toEqual({
    status: "completed",
    value: {
      op: "read",
      data: Buffer.from("inside").toString("base64"),
      bytesRead: 6,
      size: 6,
      truncated: false,
    },
  });
}

export async function expectEscape(fsOp: FsCall) {
  await expect(fsOp({ op: "read", export: "docs", path: "escape" })).resolves.toEqual({
    status: "refused",
    reason: "path_escapes_export",
    message: "path escapes export: escape",
  });
}

export async function expectKernelUnavailable(result: Promise<Machine.CellResult>) {
  expect(await result).toEqual({ status: "refused", reason: "kernel_not_available" });
}

export function kernelEnrollment(enrollment: Machine.Enrollment): Machine.Enrollment {
  return { ...enrollment, allowedCapabilities: ["kernel.py"] };
}
