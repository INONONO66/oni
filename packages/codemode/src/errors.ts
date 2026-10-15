import { Data } from "effect";
import { z } from "zod";
import type { MachinesFailure } from "@openomni/machines";
import { Machine } from "@openomni/protocol";

const Diagnostic = z.object({ operation: z.string(), cause: z.string() });
const Fields = z.object({
  reason: z.enum(["closed", "machines_not_bound", "machine_not_found", "all_stale", "machine_saturated", "lease_expired", "unknown_cell_id", "unknown_output", "browser_cleanup_failed"]),
  message: z.string(),
  credit: Machine.LeaseRefusal.optional(),
});
export class CodemodeError extends Data.TaggedError("CodemodeError")<z.infer<typeof Fields>> {}
const DriverFields = Diagnostic.extend({ message: z.string() });
export class DriverFailure extends Data.TaggedError("DriverFailure")<z.infer<typeof DriverFields>> {}
export type CodeError = CodemodeError | MachinesFailure | DriverFailure;
