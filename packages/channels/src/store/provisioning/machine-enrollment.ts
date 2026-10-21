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
  }
  return {
    /** Includes tombstones for approval revision checks; removed rows confer no authority. */
    get(machineId: string) {
      return EnrollmentRow.nullable().parse(client.query(
        "SELECT machineId, enrollment, revision, removedAt, updatedAt FROM machine_enrollment WHERE machineId = ?",
      ).get(machineId)) ?? undefined;
    },
    put(input: Machine.Enrollment): Machine.Enrollment {
      const enrollment = Machine.Enrollment.parse(input);
      client.query(`${INSERT} ON CONFLICT(machineId) DO UPDATE SET
        enrollment = excluded.enrollment, revision = machine_enrollment.revision + 1,
        removedAt = NULL, updatedAt = excluded.updatedAt`).run(
        enrollment.machineId, JSON.stringify(enrollment), enrollment.enrolledAt,
      );
      return enrollment;
    },
    remove(machineId: string, at: number): boolean {
      const removedAt = Machine.Enrollment.shape.enrolledAt.parse(at);
      return client.query(`UPDATE machine_enrollment
        SET removedAt = ?, updatedAt = ?, revision = revision + 1
        WHERE machineId = ? AND removedAt IS NULL`).run(removedAt, removedAt, machineId).changes > 0;
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
  };
}
