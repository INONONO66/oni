import { canonicalJson, type TranscriptRef } from "@openomni/protocol";
import { DialectDecodeError, type DialectPack } from "./dialects/pack";
import { splitLines, transcriptCursor, type Generation, type SourceDiagnostic, type SourceObservation, type TranscriptCursor } from "./transcript";

export interface SpoolCursor {
  /** Absent until a spool file has been read; the sequence may be restored before that. */
  readonly file?: TranscriptCursor;
  /** Sequence belongs to the child, not to a particular file generation. */
  readonly lastSeq: number;
}

/** A refused re-read of a sequence the child already used; the digest tells a replay from changed bytes. */
export interface SpoolReplay {
  readonly child: string;
  readonly seq: number;
  readonly digest: string;
}

/** The pack's `live` decoder owns the sequence gate; this adapter consumes its typed refusal. */
export function decodeSpool(input: {
  readonly pack: DialectPack;
  readonly child: string;
  readonly turn: string;
  readonly ref: TranscriptRef & { readonly generation: Generation };
  readonly cursor?: SpoolCursor;
  readonly chunk: Uint8Array;
}) {
  const decode = input.pack.live;
  if (decode === undefined) throw new DialectDecodeError("live", "unsupported");
  const resumed = transcriptCursor(input.cursor?.file, input.ref.generation);
  const split = splitLines({
    chunk: input.chunk, tail: resumed.cursor.tail,
    offsetBytes: resumed.cursor.checkpoint.offsetBytes,
  });
  let lastSeq = input.cursor?.lastSeq ?? -1;
  const observations: SourceObservation[] = [];
  const replays: SpoolReplay[] = [];
  const diagnostics: SourceDiagnostic[] = resumed.diagnostics.map((diagnostic) => ({ ref: input.ref, diagnostic }));
  for (const line of split.lines) {
    const ref = { ...input.ref, range: line.range };
    try {
      const evidence = decode(line.text, { child: input.child, turn: input.turn, lastSeq });
      if (!("kind" in evidence.ref)) throw new TypeError("live decoder returned a transcript reference");
      observations.push({
        evidence: {
          ...evidence,
          diagnostics: [
            ...evidence.diagnostics,
            { code: "source_sha256", detail: line.digest },
            { code: "spool_ref", detail: canonicalJson(ref) },
          ],
        },
        observedAt: evidence.ref.receivedAt,
      });
      lastSeq = evidence.ref.seq;
    } catch (error) {
      if (!(error instanceof DialectDecodeError)) throw error;
      const seq = error.detail?.seq;
      if (error.code === "stale_seq" && seq !== undefined) replays.push({ child: input.child, seq, digest: line.digest });
      diagnostics.push({ ref, diagnostic: { code: error.code, detail: error.message } });
    }
  }
  return {
    observations, diagnostics, replays,
    cursor: {
      file: {
        checkpoint: { generation: input.ref.generation, offsetBytes: split.offsetBytes },
        tail: split.tail,
      },
      lastSeq,
    },
  };
}
