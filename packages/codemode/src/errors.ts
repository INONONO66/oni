import { Data } from "effect";
import { z } from "zod";
import type { MachinesFailure } from "@oni/machines";
import { Machine } from "@oni/protocol";

const Fields = z.object({
  reason: z.enum(["closed", "machines_not_bound", "machine_not_found", "all_stale", "machine_saturated", "lease_expired", "unknown_cell_id", "unknown_output", "computer_not_bound"]),
  message: z.string(),
  credit: Machine.LeaseRefusal.optional(),
});
export class CodemodeError extends Data.TaggedError("CodemodeError")<z.infer<typeof Fields>> {}
export type CodeError = CodemodeError | MachinesFailure;
