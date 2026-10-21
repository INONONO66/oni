import { createHash } from "node:crypto";
import { canonicalJson, type ChildLifecycleEvidence, type TranscriptRef } from "@oni/protocol";
import { DialectDecodeError, type DialectPack } from "./dialects/pack";

export type Generation = Extract<TranscriptRef["generation"], { kind: "size-and-prefix-hash" }>;
type Diagnostic = ChildLifecycleEvidence["diagnostics"][number];

export interface TranscriptCursor {
  readonly checkpoint: { readonly generation: Generation; readonly offsetBytes: number };
  readonly tail: Uint8Array;
}

/** Offsets count bytes, including newlines; incomplete UTF-8 stays undecoded. */
export function splitLines(input: {
  readonly chunk: Uint8Array;
  readonly tail: Uint8Array;
  readonly offsetBytes: number;
}) {
  const bytes = Buffer.concat([input.tail, input.chunk]);
  const lines: { readonly text: string; readonly digest: string; readonly range: TranscriptRef["range"] }[] = [];
  let start = 0;
  for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
    lines.push({
      text: bytes.subarray(start, end).toString("utf8").replace(/\r$/, ""),
      digest: sourceDigest(bytes.subarray(start, end + 1)),
      range: { offsetBytes: input.offsetBytes + start, lengthBytes: end + 1 - start },
    });
    start = end + 1;
  }
  return {
    lines,
    tail: bytes.subarray(start),
    offsetBytes: input.offsetBytes + start,
  };
}

/** The anchor size stays fixed during append; the adapter rechecks its prefix. */
export function transcriptCursor(previous: TranscriptCursor | undefined, generation: Generation) {
  const changed = previous !== undefined &&
    canonicalJson(previous.checkpoint.generation) !== canonicalJson(generation);
  return {
    cursor: previous === undefined || changed
      ? { checkpoint: { generation, offsetBytes: 0 }, tail: new Uint8Array() }
      : previous,
    diagnostics: changed
      ? [{ code: "generation_changed", detail: canonicalJson(previous.checkpoint) }]
      : [],
  };
}

export function sourceDigest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface SourceObservation {
  readonly evidence: ChildLifecycleEvidence;
  readonly observedAt: number;
}

export interface SourceDiagnostic {
  readonly ref: TranscriptRef;
  readonly diagnostic: Diagnostic;
}

export function decodeTranscript(input: {
  readonly pack: DialectPack;
  readonly child: string;
  readonly turn: string;
  readonly ref: TranscriptRef & { readonly generation: Generation };
  readonly cursor?: TranscriptCursor;
  readonly chunk: Uint8Array;
  readonly observedAt: number;
}) {
  const decode = input.pack.transcript;
  if (decode === undefined) throw new DialectDecodeError("transcript", "unsupported");
  const resumed = transcriptCursor(input.cursor, input.ref.generation);
  const split = splitLines({
    chunk: input.chunk, tail: resumed.cursor.tail,
    offsetBytes: resumed.cursor.checkpoint.offsetBytes,
  });
  const observations: SourceObservation[] = [];
  const diagnostics: SourceDiagnostic[] = resumed.diagnostics.map((diagnostic) => ({ ref: input.ref, diagnostic }));
  for (const line of split.lines) {
    const ref = { ...input.ref, range: line.range };
    try {
      const evidence = decode(line.text, { child: input.child, turn: input.turn, ref });
      observations.push({
        evidence: {
          ...evidence,
          diagnostics: [...evidence.diagnostics, { code: "source_sha256", detail: line.digest }],
        },
        observedAt: input.observedAt,
      });
    } catch (error) {
      if (!(error instanceof DialectDecodeError)) throw error;
      diagnostics.push({ ref, diagnostic: { code: error.code, detail: error.message } });
    }
  }
  return {
    observations, diagnostics,
    cursor: {
      checkpoint: { generation: input.ref.generation, offsetBytes: split.offsetBytes },
      tail: split.tail,
    },
  };
}
