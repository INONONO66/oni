import { Machine } from "@oni/protocol";

/**
 * Per-session output streams and cursor bookkeeping (#1273). One session's
 * stream is `replay ++ live`: `replay` is the scrollback snapshot captured
 * when THIS daemon attached the session, `live` is every decoded `%output`
 * byte after it. Cursors are opaque `p1:<generation>:<offset>` tokens; a
 * token minted by an earlier daemon generation resolves to the end of the
 * current snapshot, because everything that generation ever returned is, by
 * reattach time, part of tmux history and therefore inside the new snapshot.
 */
const CURSOR_VERSION = "p1";
/** Retained live bytes per session; older bytes drop and reads report truncation. */
export const PTY_LIVE_RETAIN_MAX_BYTES = 4 * Machine.PTY_READ_MAX_BYTES;

export interface PtySessionRecord {
  readonly name: string;
  paneId: string | undefined;
  windowId: string | undefined;
  attached: boolean;
  closed: boolean;
  lost: boolean;
  /** A malformed control record poisons exactly one read, then streaming resumes. */
  poisoned: string | undefined;
  replay: Buffer;
  liveChunks: Buffer[];
  liveLength: number;
  /** Bytes dropped from the front of the live stream by the retention bound. */
  liveDropped: number;
  waiters: Array<() => void>;
}

interface PtyStreamRead {
  readonly data: Buffer;
  readonly cursor: string;
  readonly truncated: boolean;
}

export interface PtyRegistry {
  readonly generation: string;
  /** The cursor pty_open returns: the start of the retained stream. */
  startCursor(): string;
  get(name: string): PtySessionRecord | undefined;
  register(name: string): PtySessionRecord;
  remove(name: string): void;
  names(): string[];
  append(record: PtySessionRecord, data: Buffer): void;
  read(record: PtySessionRecord, cursor: string | undefined): PtyStreamRead;
  /** Resolves when output lands after this read's end, or the record settles. */
  awaitOutput(record: PtySessionRecord, wake: () => void): () => void;
  markAllLost(): void;
}

function wake(record: PtySessionRecord): void {
  for (const waiter of record.waiters.splice(0)) waiter();
}

function parseCursor(token: string | undefined, generation: string): number | undefined {
  if (token === undefined) return 0;
  const parts = token.split(":");
  if (parts[0] !== CURSOR_VERSION || parts.length !== 3 || parts[1] !== generation) return undefined;
  const offset = Number(parts[2]);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : undefined;
}

export function createPtyRegistry(generation: string): PtyRegistry {
  const records = new Map<string, PtySessionRecord>();
  const encode = (offset: number): string => `${CURSOR_VERSION}:${generation}:${offset}`;
  function read(record: PtySessionRecord, token: string | undefined): PtyStreamRead {
    const replayLength = record.replay.length;
    const end = replayLength + record.liveDropped + record.liveLength;
    // A foreign-generation cursor consumed the pre-restart stream already;
    // the new snapshot contains all of it, so continue after the snapshot.
    const requested = parseCursor(token, generation) ?? replayLength;
    const position = Math.min(requested, end);
    const dropEdge = replayLength + record.liveDropped;
    // Reading from before the retention edge crosses discarded live bytes.
    const gap = record.liveDropped > 0 && position < dropEdge;
    const start = position >= replayLength && position < dropEdge ? dropEdge : position;
    const replayPart = start < replayLength ? record.replay.subarray(start) : Buffer.alloc(0);
    const livePart =
      record.liveLength === 0
        ? Buffer.alloc(0)
        : Buffer.concat(record.liveChunks).subarray(Math.max(0, start - dropEdge));
    const full = Buffer.concat([replayPart, livePart]);
    const capped = full.length > Machine.PTY_READ_MAX_BYTES;
    return {
      data: capped ? full.subarray(full.length - Machine.PTY_READ_MAX_BYTES) : full,
      cursor: encode(end),
      truncated: capped || gap,
    };
  }
  function append(record: PtySessionRecord, data: Buffer): void {
    if (data.length === 0) return;
    record.liveChunks.push(data);
    record.liveLength += data.length;
    while (record.liveLength > PTY_LIVE_RETAIN_MAX_BYTES) {
      const oldest = record.liveChunks.shift();
      if (oldest === undefined) break;
      record.liveLength -= oldest.length;
      record.liveDropped += oldest.length;
    }
    wake(record);
  }
  return {
    generation,
    startCursor: () => encode(0),
    get: (name) => records.get(name),
    names: () => [...records.keys()],
    register(name) {
      const record: PtySessionRecord = {
        name,
        paneId: undefined,
        windowId: undefined,
        attached: false,
        closed: false,
        lost: false,
        poisoned: undefined,
        replay: Buffer.alloc(0),
        liveChunks: [],
        liveLength: 0,
        liveDropped: 0,
        waiters: [],
      };
      records.set(name, record);
      return record;
    },
    remove(name) {
      const record = records.get(name);
      if (record === undefined) return;
      record.closed = true;
      records.delete(name);
      wake(record);
    },
    append,
    read,
    awaitOutput(record, waiter) {
      record.waiters.push(waiter);
      return () => {
        const at = record.waiters.indexOf(waiter);
        if (at !== -1) record.waiters.splice(at, 1);
      };
    },
    markAllLost() {
      for (const record of records.values()) {
        record.lost = true;
        wake(record);
      }
    },
  };
}
