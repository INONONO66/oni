import {
  CAPABILITY_POINT_RECORDS,
  CORE_POINT_RECORDS,
  ComposeRejectionCode,
  NamedError,
  type PointId,
  type PointRecord,
} from "@openomni/protocol";
import { z } from "zod";

/** The core always registers its eight records; a capability point exists only while composed. */
export type GatePointTable = ReadonlyMap<string, PointRecord>;

export const GateComposeError = NamedError.create(
  "GateComposeError",
  z
    .object({
      code: ComposeRejectionCode,
      point: z.string().optional(),
      ref: z.string().optional(),
      rowId: z.string().optional(),
      bundle: z.string().optional(),
    })
    .strict(),
);
export type GateComposeError = InstanceType<typeof GateComposeError>;

export interface CapabilityPointRegistration {
  readonly bundle: string;
  readonly points: readonly PointId[];
}

export interface ComposePointTableOptions {
  readonly capabilities: readonly CapabilityPointRegistration[];
  /** Sealed to the eight records. */
  readonly core?: readonly PointRecord[];
}

const capabilityRecords = new Map(CAPABILITY_POINT_RECORDS.map((record) => [record.id, record]));

/**
 * Fail-closed and typed: a missing core record is `builtin_removed`, a re-registered point
 * `duplicate`, an id without a record `unknown_point`.
 */
export function composePointTable(options: ComposePointTableOptions): GatePointTable {
  const core = options.core ?? CORE_POINT_RECORDS;
  for (const sealed of CORE_POINT_RECORDS) {
    if (!core.some((record) => record.id === sealed.id))
      throw new GateComposeError({ code: "builtin_removed", point: sealed.id });
  }
  const table = new Map<string, PointRecord>();
  for (const record of core) {
    if (table.has(record.id)) throw new GateComposeError({ code: "duplicate", point: record.id });
    table.set(record.id, record);
  }
  for (const capability of options.capabilities) {
    for (const id of capability.points) {
      const record = capabilityRecords.get(id);
      if (record === undefined)
        throw new GateComposeError({ code: "unknown_point", point: id, bundle: capability.bundle });
      if (table.has(id))
        throw new GateComposeError({ code: "duplicate", point: id, bundle: capability.bundle });
      table.set(id, record);
    }
  }
  return table;
}

export const KERNEL_CAPABILITY_POINTS: readonly CapabilityPointRegistration[] = Object.freeze([
  Object.freeze({ bundle: "tool", points: Object.freeze(["tool.pre", "tool.post"] as const) }),
  Object.freeze({
    bundle: "compaction",
    points: Object.freeze(["compaction.pre", "compaction.post"] as const),
  }),
  Object.freeze({ bundle: "alarm", points: Object.freeze(["alarm.fired"] as const) }),
  Object.freeze({ bundle: "action", points: Object.freeze(["action.pre"] as const) }),
]);

/** Unregistered pre point fails closed; unregistered post point is not consulted. No default. */
export function executionPoint(
  kind: string,
  phase: "pre" | "post",
  table: GatePointTable,
): PointRecord | undefined {
  return table.get(`${kind}.${phase}`);
}
