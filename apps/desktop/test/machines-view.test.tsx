import { expect, test } from "bun:test";
import { Machine } from "@oni/protocol";
import { act } from "react";
import { MachinesView } from "../src/renderer/machines/view";
import { automationRenderer } from "./helpers/automation-renderer";
import { machineListOptions } from "../src/renderer/state/queries";

test("Machines renders gateway rows and refreshes their live reports without mutation controls", async () => {
  const ui = automationRenderer();
  let stale = false;
  const transport = {
    machineList: async () => {
      const reply = Machine.Response.parse({
        type: "machine_listed", requestId: "list", rows: [{
          machineId: "worker-1", name: "Worker", tags: ["pool", "build"],
          allowedCapabilities: ["kernel.py"], publicKey: "a".repeat(64), enrolledAt: 1,
          capabilities: ["kernel.py"], pendingCapabilities: [], os: "linux", arch: "arm64",
          resources: { cpus: 4, memoryBytes: 8 * 1024 ** 3 },
          live: { reportedAt: 4, stale, load: { loadAvg1: 0.25, memoryAvailableBytes: 4 * 1024 ** 3, inFlight: 2 } },
        }],
      });
      if (reply.type !== "machine_listed") throw new Error("list refused");
      return reply;
    },
  };
  try {
    await ui.render(<MachinesView transport={transport} />);
    expect(ui.host.querySelectorAll("li")).toHaveLength(1);
    for (const value of ["Worker", "pool, build", "4 CPUs", "8.0 GiB", "0.25 load", "2 cells running"])
      expect(ui.host.textContent).toContain(value);
    expect([...ui.host.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Refresh"]);
    stale = true;
    await ui.click("Refresh");
    expect(ui.host.textContent).toContain("Stale report");
  } finally { await ui.close(); }
});

test("Machines distinguishes offline, pending, failed, empty and unreported rows", async () => {
  const ui = automationRenderer();
  const reply = Promise.withResolvers<Extract<Machine.Response, { type: "machine_listed" }>>();
  try {
    await ui.render(<MachinesView transport={null} />);
    expect(ui.host.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => {
      await expect(ui.client.fetchQuery(machineListOptions(null))).rejects.toThrow("gateway not configured");
    });
    await ui.render(<MachinesView transport={{ machineList: () => reply.promise }} />);
    expect(ui.host.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => reply.reject(new Error("Disconnected")));
    expect(ui.host.querySelector('[role="alert"]')?.textContent).toContain("Disconnected");
    await ui.render(<MachinesView transport={{ machineList: async () => ({ type: "machine_listed", requestId: "empty", rows: [] }) }} />);
    await ui.click("Refresh");
    expect(ui.host.querySelectorAll("li")).toHaveLength(0);
    await ui.render(<MachinesView transport={{ machineList: async () => ({
      type: "machine_listed", requestId: "bare", rows: [{
        machineId: "bare", name: "Bare", tags: [], capabilities: [], pendingCapabilities: [], allowedCapabilities: ["fs.read"],
        publicKey: "b".repeat(64), enrolledAt: 1, os: "linux", arch: "x64",
      }],
    }) }} />);
    await ui.click("Refresh");
    expect(ui.host.querySelectorAll("li")).toHaveLength(1);
    expect(ui.host.textContent).toContain("Awaiting report");
    expect(ui.host.textContent).toContain("Not reported");
  } finally { await ui.close(); }
});
