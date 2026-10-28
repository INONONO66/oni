import { Machine } from "@oni/protocol";
import { z } from "zod";
import type { openChannelStore } from "../sqlite/index.js";
import { sqliteJsonData } from "../sqlite/json.js";

const EnrollmentRow = z.object({
  machineId: Machine.MachineId,
  enrollment: z.string().transform((data) => sqliteJsonData(Machine.Enrollment).parse({ data })),
  revision: z.number().int().nonnegative(),
  removedAt: Machine.Enrollment.shape.enrolledAt.nullable(),
  updatedAt: Machine.Enrollment.shape.enrolledAt,
}).refine((row) => row.machineId === row.enrollment.machineId, {
  message: "enrollment machineId must match its stored key",
});
const QueryOnly = z.object({ query_only: z.number().int() });
const Capabilities = z.array(Machine.CapabilityId).superRefine((items, ctx) => {
  if (new Set(items).size !== items.length) ctx.addIssue({ code: "custom", message: "capabilities must be unique" });
});
const CapabilityRequestRow = z.object({
  machineId: Machine.MachineId,
  capabilities: z.string().transform((data) => sqliteJsonData(Capabilities).parse({ data })),
  offeredAt: Machine.Enrollment.shape.enrolledAt,
  updatedAt: Machine.Enrollment.shape.enrolledAt,
});
const INSERT = `INSERT INTO machine_enrollment (machineId, enrollment, revision, removedAt, updatedAt)
  VALUES (?, ?, 0, NULL, ?)`;

/** Enrollment tombstones retain revisions so a remove/re-add cannot revive stale consent. */
export function createMachineEnrollmentStore(client: Parameters<typeof openChannelStore>[0]) {
  if (QueryOnly.parse(client.query("PRAGMA query_only").get()).query_only === 0) {
    client.run(`CREATE TABLE IF NOT EXISTS machine_enrollment (
      machineId TEXT PRIMARY KEY NOT NULL,
      enrollment TEXT NOT NULL,
      revision INTEGER NOT NULL,
      removedAt INTEGER,
      updatedAt INTEGER NOT NULL
    )`);
    client.run(`CREATE TABLE IF NOT EXISTS machine_capability_request (
      machineId TEXT PRIMARY KEY NOT NULL,
      capabilities TEXT NOT NULL,
      offeredAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    )`);
  }
  const store = {
    /** Includes tombstones for approval revision checks; removed rows confer no authority. */
    get(machineId: string) {
      return EnrollmentRow.nullable().parse(client.query(
        "SELECT machineId, enrollment, revision, removedAt, updatedAt FROM machine_enrollment WHERE machineId = ?",
      ).get(machineId)) ?? undefined;
    },
    put(input: Machine.Enrollment, updatedAt = input.enrolledAt): Machine.Enrollment {
      const enrollment = Machine.Enrollment.parse(input);
      const time = Machine.Enrollment.shape.enrolledAt.parse(updatedAt);
      client.transaction(() => {
        client.query(`${INSERT} ON CONFLICT(machineId) DO UPDATE SET
          enrollment = excluded.enrollment, revision = machine_enrollment.revision + 1,
          removedAt = NULL, updatedAt = excluded.updatedAt`).run(
          enrollment.machineId, JSON.stringify(enrollment), time,
        );
        client.query("DELETE FROM machine_capability_request WHERE machineId = ?").run(enrollment.machineId);
      }).immediate();
      return enrollment;
    },
    remove(machineId: string, at: number): boolean {
      const removedAt = Machine.Enrollment.shape.enrolledAt.parse(at);
      return client.transaction(() => {
        const removed = client.query(`UPDATE machine_enrollment
          SET removedAt = ?, updatedAt = ?, revision = revision + 1
          WHERE machineId = ? AND removedAt IS NULL`).run(removedAt, removedAt, machineId).changes > 0;
        if (removed) client.query("DELETE FROM machine_capability_request WHERE machineId = ?").run(machineId);
        return removed;
      }).immediate();
    },
    list(): Machine.Enrollment[] {
      return EnrollmentRow.array().parse(client.query(
        "SELECT machineId, enrollment, revision, removedAt, updatedAt FROM machine_enrollment WHERE removedAt IS NULL ORDER BY machineId",
      ).all()).map((row) => row.enrollment);
    },
    seed(enrollments: readonly Machine.Enrollment[]): void {
      client.transaction(() => {
        for (const input of enrollments) {
          const enrollment = Machine.Enrollment.parse(input);
          client.query(`${INSERT} ON CONFLICT(machineId) DO NOTHING`).run(
            enrollment.machineId, JSON.stringify(enrollment), enrollment.enrolledAt,
          );
        }
      }).immediate();
    },
    pending(machineId: string): Machine.CapabilityId[] {
      return CapabilityRequestRow.nullable().parse(client.query(
        "SELECT machineId, capabilities, offeredAt, updatedAt FROM machine_capability_request WHERE machineId = ?",
      ).get(machineId))?.capabilities ?? [];
    },
    request(machineId: string, capabilities: readonly Machine.CapabilityId[], offeredAt: number, updatedAt: number): void {
      const id = Machine.MachineId.parse(machineId);
      const offered = Machine.Enrollment.shape.enrolledAt.parse(offeredAt);
      const time = Machine.Enrollment.shape.enrolledAt.parse(updatedAt);
      const requested = Capabilities.parse(capabilities);
      if (requested.length === 0) {
        client.query("DELETE FROM machine_capability_request WHERE machineId = ?").run(id);
        return;
      }
      client.query(`INSERT INTO machine_capability_request (machineId, capabilities, offeredAt, updatedAt)
        SELECT machineId, ?, ?, ? FROM machine_enrollment WHERE machineId = ? AND removedAt IS NULL
        ON CONFLICT(machineId) DO UPDATE SET capabilities = excluded.capabilities,
          offeredAt = excluded.offeredAt, updatedAt = excluded.updatedAt`).run(
        JSON.stringify(requested), offered, time, id,
      );
    },
    grant(machineId: string, capabilities: readonly Machine.CapabilityId[], at: number): Machine.Enrollment | undefined {
      const id = Machine.MachineId.parse(machineId);
      const approved = Capabilities.min(1).parse(capabilities);
      const time = Machine.Enrollment.shape.enrolledAt.parse(at);
      return client.transaction(() => {
        const row = store.get(id);
        if (row === undefined || row.removedAt !== null) return undefined;
        const pending = store.pending(id);
        if (approved.some((capability) => !pending.includes(capability))) return undefined;
        const enrollment = { ...row.enrollment, allowedCapabilities: [...new Set([...row.enrollment.allowedCapabilities, ...approved])] };
        store.put(enrollment, time);
        return enrollment;
      }).immediate();
    },
    deny(machineId: string): boolean {
      return client.query("DELETE FROM machine_capability_request WHERE machineId = ?").run(Machine.MachineId.parse(machineId)).changes > 0;
    },
  };
  return store;
}
