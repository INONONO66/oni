/**
 * tmux control-mode line decoder (#1273). The tmux manual frames control
 * output as newline-terminated records: `%begin`/`%end`/`%error` bracket one
 * command reply, and `%output pane-id value` carries pane bytes whose
 * non-printable characters and backslashes use octal escapes. Everything here
 * is pure so framing and escape handling are unit-testable without a server.
 */
import { Machine } from "@oni/protocol";

export type PtyControlEvent =
  | { readonly kind: "reply-begin" }
  | { readonly kind: "reply-body"; readonly line: string }
  | { readonly kind: "reply-end"; readonly ok: boolean }
  | { readonly kind: "output"; readonly paneId: string; readonly data: Buffer }
  | { readonly kind: "exit" }
  | { readonly kind: "notice"; readonly line: string }
  | { readonly kind: "malformed"; readonly line: string; readonly reason: string; readonly paneId: string | undefined };

const REPLY_EDGE = /^%(begin|end|error) \d+ \d+ \d+$/;
const OUTPUT_RECORD = /^%output (%\d+) (.*)$/s;
const BACKSLASH = 0x5c;

const octal = (byte: number): boolean => byte >= 0x30 && byte <= 0x37;

/** `%output` values escape non-printable bytes and backslashes as `\ooo`. */
export function decodeOctalEscapes(value: string): Buffer | undefined {
  const raw = Buffer.from(value, "utf8");
  const out = Buffer.alloc(raw.length);
  let written = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const byte = raw[i] ?? 0;
    if (byte !== BACKSLASH) {
      out[written] = byte;
      written += 1;
      continue;
    }
    const a = raw[i + 1];
    const b = raw[i + 2];
    const c = raw[i + 3];
    if (a === undefined || b === undefined || c === undefined || !octal(a) || !octal(b) || !octal(c)) return undefined;
    out[written] = (a - 0x30) * 64 + (b - 0x30) * 8 + (c - 0x30);
    written += 1;
    i += 3;
  }
  return out.subarray(0, written);
}

function decodeRecord(line: string, insideReply: boolean): PtyControlEvent {
  const edge = line.match(REPLY_EDGE);
  if (edge !== null) {
    if (edge[1] === "begin") return { kind: "reply-begin" };
    return { kind: "reply-end", ok: edge[1] === "end" };
  }
  // Inside a reply every non-edge line is command body, even one starting
  // with "%": capture-pane may legitimately emit such text.
  if (insideReply) return { kind: "reply-body", line };
  const output = line.match(OUTPUT_RECORD);
  if (output !== null) {
    const paneId = output[1] ?? "";
    const data = decodeOctalEscapes(output[2] ?? "");
    if (data === undefined) return { kind: "malformed", line, reason: "invalid octal escape in %output", paneId };
    return { kind: "output", paneId, data };
  }
  if (line === "%exit" || line.startsWith("%exit ")) return { kind: "exit" };
  if (line.startsWith("%output")) return { kind: "malformed", line, reason: "unparseable %output record", paneId: undefined };
  return { kind: "notice", line };
}

export interface PtyControlDecoder {
  feed(chunk: Buffer): PtyControlEvent[];
}

/**
 * Partial-line cap: tmux frames every record with a newline, so a line past
 * 16x the protocol read bound (4 MiB; %output octal escapes expand at most
 * 4x) means a wedged or hostile server. The oversized line is dropped with
 * one typed `malformed` event (the pane-poison pathway) instead of growing
 * the buffer without bound.
 */
export const CONTROL_LINE_MAX_BYTES = 16 * Machine.PTY_READ_MAX_BYTES;

/** Stateful splitter: buffers partial lines and tracks reply framing. */
export function createControlDecoder(): PtyControlDecoder {
  // Byte-level buffering: a multibyte character split across chunks must not
  // corrupt, so text decoding happens only on complete lines.
  let pending: Buffer = Buffer.alloc(0);
  let insideReply = false;
  let discarding = false;
  /** Cap enforcement for a newline-less buffer: drop it, report ONCE. */
  function overflowed(events: PtyControlEvent[]): PtyControlEvent[] {
    if (pending.length > CONTROL_LINE_MAX_BYTES) {
      pending = Buffer.alloc(0);
      if (!discarding) {
        discarding = true;
        events.push({
          kind: "malformed",
          line: "",
          reason: `control line exceeds ${CONTROL_LINE_MAX_BYTES} bytes`,
          paneId: undefined,
        });
      }
    }
    return events;
  }
  /** Consume one framed line; the tail of a dropped oversized line yields nothing. */
  function takeLine(edge: number): string | undefined {
    const raw = pending.subarray(0, edge);
    pending = pending.subarray(edge + 1);
    if (discarding) {
      discarding = false;
      return undefined;
    }
    return raw.toString("utf8");
  }
  return {
    feed(chunk) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      const events: PtyControlEvent[] = [];
      for (;;) {
        const edge = pending.indexOf(0x0a);
        if (edge === -1) return overflowed(events);
        const line = takeLine(edge);
        if (line === undefined) continue;
        const event = decodeRecord(line, insideReply);
        if (event.kind === "reply-begin") insideReply = true;
        if (event.kind === "reply-end") insideReply = false;
        events.push(event);
      }
    },
  };
}
