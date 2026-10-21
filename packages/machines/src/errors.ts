import { Machine } from "@oni/protocol";
import { Data } from "effect";
import { z } from "zod";

/** Machines-owned failure for a Cause without a typed error. */
export class MachinesFailure extends Data.TaggedError("MachinesFailure")<{
  readonly operation: string;
  readonly cause: string;
}> {
  override get message(): string { return this.cause; }
}
const Diagnostic = z.object({ operation: z.string(), cause: z.string() });
const CellFields = Machine.CellRequest.pick({ cellId: true }).extend({
  code: z.enum(["duplicate_cell_id", "unknown_cell_id"]),
  message: z.string(),
});
export class MachineCellError extends Data.TaggedError("MachineCellError")<z.infer<typeof CellFields>> {}
const RefusalFields = z.object({
  reason: z.enum([
    "machine_not_attached", "fs_not_available", "export_not_available", "path_escapes_export",
    "not_found", "wrong_kind", "io_error", "too_large", "ambiguous_export", "invalid_method",
    "invalid_response", "closed", "ambiguous_machine", "peer_key_mismatch", "disconnected",
    "host_tool_missing", "machine_saturated", "lease_expired", "lease_scheduler_missing",
    "transfer_not_found", "invalid_sequence", "digest_mismatch",
  ]),
  message: z.string(),
  credit: Machine.LeaseRefusal.optional(),
});
export class MachineRefusalError extends Data.TaggedError("MachineRefusalError")<z.infer<typeof RefusalFields>> {}
const BoundaryFields = Diagnostic.extend({ message: z.string() });
export class SpawnFailure extends Data.TaggedError("SpawnFailure")<z.infer<typeof BoundaryFields>> {}
export class FilesystemFailure extends Data.TaggedError("FilesystemFailure")<z.infer<typeof BoundaryFields>> {}
export class TransportFailure extends Data.TaggedError("TransportFailure")<z.infer<typeof BoundaryFields>> {}

export type MachineError = MachinesFailure | MachineCellError | MachineRefusalError | SpawnFailure | FilesystemFailure | TransportFailure;
