import { type Ipc, type PlainValue, parseJson } from "@oni/protocol";
import { FrameSchema } from "./frame-schema";
import { IpcProtocolError } from "./errors";

const encoder = new TextEncoder();

// 16 MiB — reject any single frame that exceeds this before unbounded growth
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

// Cap each reported malformed line so error reporting stays bounded.
const MALFORMED_REPORT_CHARS = 64;

export function encode(msg: PlainValue | Ipc.Request | Ipc.Response | Ipc.Notification): Uint8Array {
  return encoder.encode(`${JSON.stringify(msg)}\n`);
}

type DecodedChunk = {
  /** Every parseable frame in the chunk, delivered immediately, in wire order. */
  frames: PlainValue[];
  /** Each non-JSON line, truncated to MALFORMED_REPORT_CHARS for reporting — never re-queued. */
  malformed: string[];
};

/** Stream-agnostic newline framing with streaming UTF-8 decoding. */
class LineSplitter {
  private buffer = "";
  private decoder = new TextDecoder();

  get buffered(): string {
    return this.buffer;
  }

  push(chunk: string | Uint8Array): string[] {
    if (typeof chunk === "string") {
      // String chunks cannot complete a pending byte sequence; discard stale decoder state.
      this.decoder = new TextDecoder();
      this.buffer += chunk;
    } else {
      this.buffer += this.decoder.decode(chunk, { stream: true });
    }

    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines;
  }

  reset(): void {
    this.buffer = "";
    this.decoder = new TextDecoder();
  }
}

export class LineDecoder {
  private splitter = new LineSplitter();

  /**
   * Decode a chunk into complete frames. A malformed line costs only itself:
   * every parseable sibling in the chunk still delivers, in order, and the bad
   * line lands in `malformed` for the caller to report. Oversize lines and
   * oversize buffers stay reset+throw — that path is a DoS guard, not a
   * per-frame failure, and it deliberately drops the whole decode buffer.
   */
  push(chunk: string | Uint8Array): DecodedChunk {
    const lines = this.splitter.push(chunk);

    if (Buffer.byteLength(this.splitter.buffered, "utf-8") > MAX_FRAME_BYTES) {
      this.reset();
      throw new IpcProtocolError({ message: `IPC frame exceeds maximum size of ${MAX_FRAME_BYTES} bytes` });
    }

    const frames: PlainValue[] = [];
    const malformed: string[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf-8") > MAX_FRAME_BYTES) {
        this.reset();
        throw new IpcProtocolError({ message: `IPC frame exceeds maximum size of ${MAX_FRAME_BYTES} bytes` });
      }
      const frame = parseJson(FrameSchema, line);
      if (frame === undefined) malformed.push(line.slice(0, MALFORMED_REPORT_CHARS));
      else frames.push(frame);
    }
    return { frames, malformed };
  }

  reset(): void {
    this.splitter.reset();
  }
}
