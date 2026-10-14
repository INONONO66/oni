import type { Database } from "bun:sqlite";
import { z } from "zod";

/** One stored tool output write: digest-named bytes plus an optional media hint. */
export interface ToolOutputWrite {
  /** `canonicalDigest` identity of the bytes: `sha256:<64 hex>`. */
  readonly outputId: string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
}

/** One stored tool output read back by its identifier. */
export interface ToolOutputRow {
  readonly outputId: string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
}

const ToolOutputSqlRow = z.object({
  output_id: z.string(),
  bytes: z.instanceof(Uint8Array),
  media_type: z.string().nullable(),
});

/** Content-addressed tool output storage (): `put` is idempotent — the */
export interface ToolOutputsAdapter {
  put(write: ToolOutputWrite): void;
  get(outputId: string): ToolOutputRow | undefined;
}

export function createToolOutputs(db: Database): ToolOutputsAdapter {
  return {
    put(write) {
      db.query("INSERT OR IGNORE INTO tool_outputs (output_id, bytes, media_type) VALUES (?, ?, ?)")
        .run(write.outputId, write.bytes, write.mediaType ?? null);
    },
    get(outputId) {
      const row = ToolOutputSqlRow.nullable().parse(
        db.query("SELECT output_id, bytes, media_type FROM tool_outputs WHERE output_id = ?").get(outputId),
      );
      if (row === null) return undefined;
      return {
        outputId: row.output_id,
        bytes: row.bytes,
        ...(row.media_type === null ? {} : { mediaType: row.media_type }),
      };
    },
  };
}
