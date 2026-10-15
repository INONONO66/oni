import { PlainValueSchema, canonicalJson, parseJson, type TranscriptRef } from "@openomni/protocol";
import { z } from "zod";
import { DialectDecodeError, type DialectPack } from "./dialects/pack";
import { splitLines, transcriptCursor, type Generation, type SourceDiagnostic, type SourceObservation, type TranscriptCursor } from "./transcript";

const SpoolEnvelope = z.object({
  seq: z.number().int().nonnegative(),
  receivedAt: z.number().int().nonnegative(),
  payload: PlainValueSchema,
  decision: z.enum(["allow", "deny"]).optional(),
});

export interface SpoolCursor {
  readonly file: TranscriptCursor;
  /** Sequence belongs to the child, not to a particular file generation. */
  readonly lastSeq: number;
}

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
  const replays: { readonly child: string; readonly turn: string; readonly seq: number; readonly digest: string }[] = [];
  const diagnostics: SourceDiagnostic[] = resumed.diagnostics.map((diagnostic) => ({ ref: input.ref, diagnostic }));
  for (const line of split.lines) {
    const ref = { ...input.ref, range: line.range };
    try {
      const envelope = parseJson(SpoolEnvelope, line.text);
      if (envelope === undefined) throw new DialectDecodeError("live", "malformed");
      if (envelope.seq <= lastSeq) {
        replays.push({ child: input.child, turn: input.turn, seq: envelope.seq, digest: line.digest });
        throw new DialectDecodeError("live", "stale_seq");
      }
      const evidence = decode(line.text, { child: input.child, turn: input.turn, lastSeq });
      observations.push({
        evidence: {
          ...evidence,
          diagnostics: [
            ...evidence.diagnostics,
            { code: "source_sha256", detail: line.digest },
            { code: "spool_ref", detail: canonicalJson(ref) },
          ],
        },
        observedAt: envelope.receivedAt,
      });
      lastSeq = envelope.seq;
    } catch (error) {
      if (!(error instanceof DialectDecodeError)) throw error;
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
