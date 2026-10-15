import type { ChannelInstanceStore } from "@openomni/channels";
import { canonicalDigest, Machine } from "@openomni/protocol";
import { z } from "zod";

const Record = z.object({ enrollment: Machine.Enrollment.nullable() }).strict();

/**
 * Reserved, disabled provisioning declarations reuse the managed-row API.
 * A tombstone keeps a removed boot seed removed without a second persistence path.
 */
export function machineEnrollments(instances: Pick<ChannelInstanceStore, "get" | "put">) {
  const key = (id: string) => `channel:machine:${canonicalDigest(id).replace(":", "-")}`;
  const row = (id: string) => instances.get(key(id));
  function put(id: string, enrollment: Machine.Enrollment | null, at: number) {
    instances.put({
      id: key(id),
      provider: "machine",
      enabled: false,
      settings: { enrollment },
      revision: (row(id)?.revision ?? -1) + 1,
      createdBy: "owner",
      updatedAt: at,
    });
  }
  return {
    get(id: string): Machine.Enrollment | undefined {
      const stored = row(id);
      return stored === undefined ? undefined : Record.parse(stored.settings).enrollment ?? undefined;
    },
    revisions(id: string): Record<string, number> {
      return { [key(id)]: row(id)?.revision ?? -1 };
    },
    add(enrollment: Machine.Enrollment) {
      put(enrollment.machineId, enrollment, enrollment.enrolledAt);
    },
    remove(id: string, at: number) {
      put(id, null, at);
    },
    seed(enrollments: readonly Machine.Enrollment[]) {
      for (const enrollment of enrollments) {
        if (row(enrollment.machineId) === undefined)
          put(enrollment.machineId, enrollment, enrollment.enrolledAt);
      }
    },
  };
}
