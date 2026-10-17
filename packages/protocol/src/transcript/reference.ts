import { z } from "zod";
import { EpochMs } from "../time.js";

const Id = z.string().min(1);
const ByteCount = z.number().int().nonnegative();
/** Position in the monotonic hook spool (#1527); not a byte count. */
const Seq = z.number().int().nonnegative();

/** Location and generation of bytes retained by an attached machine. */
export const TranscriptRef = z
  .object({
    machine: Id,
    export: Id,
    path: Id,
    generation: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("size-and-prefix-hash"),
          size: ByteCount,
          prefixSha256: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .strict(),
      z.object({ kind: z.literal("inode"), device: Id, inode: Id }).strict(),
    ]),
    range: z
      .object({ offsetBytes: ByteCount, lengthBytes: ByteCount })
      .strict(),
    parser: z.object({ dialect: Id, version: Id }).strict(),
  })
  .strict();
export type TranscriptRef = z.infer<typeof TranscriptRef>;

/** A normalized observation, without the remote transcript's bytes. */
export const ChildLifecycleEvidence = z
  .object({
    child: Id,
    turn: Id,
    toolUseId: Id.optional(),
    phase: z.enum(["observed", "requested", "waiting", "decided", "result", "terminal"]),
    ref: z.union([
      TranscriptRef,
      z
        .object({
          kind: z.literal("hook"),
          event: Id,
          receivedAt: EpochMs,
          seq: Seq,
        })
        .strict(),
    ]),
    diagnostics: z.array(z.object({ code: Id, detail: z.string() }).strict()),
  })
  .strict();
export type ChildLifecycleEvidence = z.infer<typeof ChildLifecycleEvidence>;
