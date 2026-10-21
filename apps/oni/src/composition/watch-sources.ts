import { statSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Bundle } from "@oni/agent";
import { MachineRefusalError } from "@oni/machines";
import { TranscriptRef, canonicalJson, parseJson, type Alarm, type Machine } from "@oni/protocol";
import { processEnvironment } from "../cli/env-file";
import type { FilePorts } from "../bundles/tools/core/filesystem";
import type { ChildWatch } from "../bundles/child-activity/index";
import { selectPack } from "../bundles/child-activity/dialects/index";
import { decodeSpool, type SpoolCursor } from "../bundles/child-activity/spool";
import { decodeTranscript, sourceDigest, transcriptCursor, type Generation, type TranscriptCursor } from "../bundles/child-activity/transcript";
import { diagnosticRow, reconcile, type ChildRow } from "../bundles/child-activity/reconcile";

/**
 * Watch plane over the Session entity (W5.2 plan §1 F2, #1254): this module
 * owns the native OS handles (PTY, fs watcher). A native hit resends the
 * chain's armed `monitor.hit` occurrence through the entity's one alarm door;
 * the timeout alarm is armed by the capability's watch verb, never here.
 * Durable dedupe is the chain's committed occurrence id, never cancelled
 * storage.
 */

// Promise band (#1423): `node:fs` `watch`, `Bun.spawn` PTY streams, the machines `pty.read`
// long-poll, daemon fs reads and native path-watch callbacks force callbacks here; Effect takes over
// inside the one injected `WatchSenders` door (`deliver` and `admit`); no durable write lives here.

export class AlarmRuntimeError extends Error {
  readonly requiredVersion = ">=1.4.0";

  constructor() {
    super("Alarm monitoring requires Bun >=1.4.0 with Bun.Terminal support");
    this.name = "AlarmRuntimeError";
  }
}

function assertAlarmRuntime(): void {
  if (Bun.Terminal === undefined || !Bun.semver.satisfies(Bun.version, ">=1.4.0"))
    throw new AlarmRuntimeError();
}

/** Opaque throws are normalized to a typed boundary outcome, never cast to Error. */
class AlarmSourceError extends Error {
  constructor(
    cause: Error | undefined,
    readonly site:
      | "pty.data"
      | "pty.eof"
      | "terminal.open"
      | "terminal.read"
      | "path.observe"
      | "path.retire"
      | "source.start"
      | "source.close"
      | "bus.scan"
      | "timer.scan",
  ) {
    super(`alarm source failed at ${site}`, cause === undefined ? undefined : { cause });
    this.name = "AlarmSourceError";
  }
}

/** Process-group teardown that could not be proven: named so the incident is classifiable. */
class AlarmProcessGroupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlarmProcessGroupError";
  }
}

export interface AlarmSource {
  observe?(): void;
  /** Resolves once the source is subscribed; install awaits it so no trigger can race the baseline. */
  ready?: Promise<void>;
  close(): Promise<void>;
}

/** PTY frames carry partial lines: buffer until newline, strip the CR. */
function lineFramer(line: (content: string) => void) {
  let pending = "";
  return {
    push(text: string) {
      pending += text;
      let boundary = pending.indexOf("\n");
      while (boundary !== -1) {
        const content = pending.slice(0, boundary).replace(/\r$/, "");
        pending = pending.slice(boundary + 1);
        line(content);
        boundary = pending.indexOf("\n");
      }
    },
    flush() {
      if (pending !== "") line(pending);
      pending = "";
    },
  };
}

export function commandSource(
  command: string,
  line: (content: string) => void,
  exit: (code: number) => void,
  failure: (error: Error) => void,
): AlarmSource {
  assertAlarmRuntime();
  const decoder = new StringDecoder("utf8");
  const framer = lineFramer(line);
  let closing = false;
  const eof = Promise.withResolvers<void>();
  // This terminal belongs to one child, not a reusable Terminal instance. Bun
  // then closes the parent's slave descriptor on child exit so EOF can arrive.
  const child = Bun.spawn(["/bin/sh", "-c", command], {
    detached: true,
    terminal: {
      data(_terminal, bytes) {
        if (closing) return;
        try {
          framer.push(decoder.write(bytes));
        } catch {
          failure(new AlarmSourceError(undefined, "pty.data"));
        }
      },
      exit(_terminal, code) {
        if (!closing) {
          try {
            framer.push(decoder.end());
            framer.flush();
            // Linux reports last-slave hangup as EIO (Bun code 1). Accept it
            // only after the child exited; a live child's read error stays fatal.
            const hungUp = code === 1 && (child.exitCode !== null || child.signalCode !== null);
            if (code !== 0 && !hungUp) failure(new Error("alarm PTY read failed"));
          } catch {
            failure(new AlarmSourceError(undefined, "pty.eof"));
          }
        }
        eof.resolve();
      },
    },
  });
  const terminal = child.terminal;
  let shutdown: Promise<void> | undefined;
  function terminate() {
    shutdown ??= (async () => {
      try {
        // The shell can exit before its children. Kill its group even then, before
        // awaiting PTY EOF; waiting for EOF first lets HUP-ignoring descendants hang.
        await killCommandGroup(child.pid);
        await child.exited;
        // Cancellation has no remaining output to drain. Retire the master after
        // the owned group was signalled and the leader reaped, even if Bun omits EOF.
        if (closing) {
          terminal?.close();
          eof.resolve();
        }
        await eof.promise;
      } finally {
        // A kill failure propagates as the typed error, but the master never outlives it.
        terminal?.close();
        eof.resolve();
      }
    })();
    return shutdown;
  }
  const settled = child.exited.then(async (code) => {
    await terminate();
    if (!closing) exit(code);
  });
  void settled.catch((error: Error) => failure(error));
  return {
    async close() {
      closing = true;
      await terminate();
      await settled;
    },
  };
}

async function killCommandGroup(pid: number): Promise<void> {
  // Keep signalling the group after leader exit. Darwin can report EPERM for
  // zombie-only groups; accept that only after an authoritative process readback.
  const signal = Bun.spawn(["/bin/kill", "-KILL", "--", `-${pid}`], {
    stdout: "ignore",
    stderr: "pipe",
    // Environment values come from the env-file owner (#1245); LC_ALL pins
    // the C locale so the kill(1) stderr parse below stays literal.
    env: { ...processEnvironment(), LC_ALL: "C" },
  });
  const [code, error] = await Promise.all([signal.exited, new Response(signal.stderr).text()]);
  if (code === 0 || error.includes("No such process")) return;
  if (error.includes("Operation not permitted")) {
    const probe = Bun.spawn(["ps", "-axo", "pgid=,stat="], { stdout: "pipe", stderr: "pipe" });
    const [status, processes, diagnostic] = await Promise.all([
      probe.exited,
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ]);
    if (status !== 0) throw new AlarmProcessGroupError(`alarm process-group readback failed: ${diagnostic.trim()}`);
    const alive = processes.split("\n").some((line) => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === pid && !state?.startsWith("Z");
    });
    if (!alive) return;
  }
  throw new AlarmProcessGroupError(`alarm process group ${pid} termination failed: ${error.trim()}`);
}

/** Long-poll quantum per drain round: each round blocks on the daemon's
 * `machine.pty_read` output gate (waitMs), never spins. */
const TERMINAL_WAIT_MS = 5000;

type TerminalPty = {
  open(name: string, cwd: string): Promise<Machine.PtyOpenResult>;
  read(
    name: string,
    options?: { readonly cursor?: string; readonly waitMs?: number },
  ): Promise<
    | { status: "ok"; data: Uint8Array; cursor: string; truncated: boolean }
    | { status: "refused"; reason: string }
  >;
};
/** The machines plane surface a terminal watch needs (a structural slice of the tool ports). */
export interface TerminalWatchMachines {
  get(machineId: string): { pty: TerminalPty };
}

/**
 * Terminal watch (#1273 item 6): subscribe at the current cursor, then drain
 * `pty_read` beyond it. The cursor returns each retained byte at most once,
 * so one matching line fires exactly once — there is no screen client whose
 * repaint could re-deliver already-observed bytes (PR #1283 CI finding 4).
 */
function terminalSource(
  pty: TerminalPty,
  session: string,
  line: (content: string) => void,
  failure: (error: Error) => void,
): AlarmSource {
  const decoder = new StringDecoder("utf8");
  const framer = lineFramer(line);
  let closed = false;
  // Subscribe before any trigger: open-or-reattach, then advance past every
  // already-retained byte. Scrollback and screen history predate the watch and
  // never fire it; an over-cap read still lands past all observed output.
  const subscribed = (async () => {
    const opened = await pty.open(session, "/");
    if (opened.status !== "ok") throw new AlarmSourceError(new Error(opened.reason), "terminal.open");
    const baseline = await pty.read(session, { cursor: opened.cursor });
    if (baseline.status !== "ok") throw new AlarmSourceError(new Error(baseline.reason), "terminal.read");
    return baseline.cursor;
  })();
  // Subscribe failures surface only through `ready` (the installing call);
  // drain failures surface only through `failure`.
  const drained = subscribed.then(
    async (start) => {
      let cursor = start;
      while (!closed) {
        const view = await pty.read(session, { cursor, waitMs: TERMINAL_WAIT_MS });
        if (closed) return;
        if (view.status !== "ok") throw new AlarmSourceError(new Error(view.reason), "terminal.read");
        cursor = view.cursor;
        if (view.data.length > 0) framer.push(decoder.write(Buffer.from(view.data)));
      }
    },
    () => undefined,
  );
  void drained.catch((error: Error) => {
    if (!closed) failure(error);
  });
  return {
    ready: subscribed.then(() => undefined),
    close() {
      // Cancellation unsubscribes without touching the terminal; an in-flight
      // long-poll settles on the daemon's clock and is discarded here.
      closed = true;
      return Promise.resolve();
    },
  };
}

/** The fs.watch slice a path watch consumes; injected so a test models a native event that never arrives (G015). */
interface PathWatcher {
  on(event: "error", listener: (error: Error) => void): void;
  close(): void;
}
export type PathWatchInstaller = (
  directory: string,
  listener: (eventType: string, fileName: string | null) => void,
) => PathWatcher;

const nativePathWatch: PathWatchInstaller = (directory, listener) =>
  watch(directory, { recursive: true }, listener);

/**
 * Bun's macOS fs.watch rebuilds one shared FSEvents stream whenever any watcher
 * in the process opens or closes, and an event landing during the rebuild is
 * dropped for good, not delayed (oven-sh/bun#44385; measured on Bun 1.4.1 at
 * load 10-12: the create test loses ~10% of native events, and a single
 * post-install stat does not recover them because the rebuild outlives the
 * fs.watch() return). A path watch therefore reconciles its stat identity on
 * an alarm cadence beside the native callback; the identity key makes both paths
 * idempotent, so a hit is never doubled.
 */
export function pathSource(
  spec: Extract<Alarm.Watch, { path: string }>,
  event: (content: string, identity: string) => void,
  failure: (error: Error) => void,
  installWatch: PathWatchInstaller = nativePathWatch,
): AlarmSource {
  // The stat identity is the transport occurrence key; `previous` is only the
  // physical snapshot that classifies create/modify. Durable dedupe is the ledger's.
  const identity = () => {
    const stat = statSync(spec.path, { bigint: true, throwIfNoEntry: false });
    return stat === undefined ? null : `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  };
  let previous = identity();
  let closed = false;
  function observe() {
    if (closed) return;
    try {
      const next = identity();
      const kind = previous === null && next !== null ? "create" : "modify";
      if (next !== null && next !== previous && kind === spec.event)
        event(JSON.stringify({ path: spec.path, event: kind }), `${kind}:${next}`);
      // Do not advance the observation cursor if committing the event failed.
      previous = next;
    } catch {
      failure(new AlarmSourceError(undefined, "path.observe"));
    }
  }
  const source = installWatch(dirname(spec.path), (_kind, name) => {
    if (name === null || name === basename(spec.path)) observe();
  });
  source.on("error", failure);
  // The first reconcile runs at once so a create that landed while fs.watch()
  // was still installing is observed before the first alarm fire.
  observe();
  return {
    observe,
    close() {
      closed = true;
      source.close();
      return Promise.resolve();
    },
  };
}

/** The armed occurrence a native hit resends (the cluster dedupes on it). */
interface WatchOccurrenceRef {
  readonly occurrenceId: string;
  readonly alarmId: string;
  readonly armSeq: number;
}

/** One native hit, merged onto the armed occurrence payload the source resends. */
interface WatchHit {
  readonly content: string;
  readonly terminal: boolean;
  /** Transport detail (PTY line slot, path stat identity, exit) — never an id. */
  readonly detail: string;
}

/** The full `monitor.hit` occurrence a native source sends through the entity's one alarm door. */
export interface WatchHitSend {
  /** The session whose chain owns this watch (entity address). */
  readonly sessionId: string;
  readonly occurrenceId: string;
  readonly purpose: string;
  readonly alarmId: string;
  readonly armSeq: number;
  readonly sourceKey: string;
  readonly payload: string;
  readonly fireAt: number;
}

/** Entity-message sender, implemented over the Session entity client: native hits and child rows take the same door. */
export interface WatchSenders {
  deliver(send: WatchHitSend): Promise<void>;
  /** Child intake through the entity's Deliver RPC; absent when no body is attached. */
  admit?(sessionId: string, rows: readonly ChildRow[]): Promise<readonly ChildRow[]>;
}

/** One armed watch: identity, native spec, and the chain state its hits carry. */
export interface ArmedWatch {
  readonly sessionId: string;
  readonly id: string;
  readonly occurrence: WatchOccurrenceRef;
  readonly base: {
    readonly spec: Alarm.WatchSpec;
    readonly notifications: number;
  };
}

export interface WatchSources {
  install(spec: ArmedWatch): Promise<void>;
  /**
   * Swaps the armed occurrence after a re-arm WITHOUT touching the native
   * handle (a mid-stream reinstall would restart the command). Returns false
   * when no handle exists — the caller installs instead.
   */
  refresh(spec: ArmedWatch): boolean;
  /** Reconciles a path watch's stat identity outside its native callback. */
  observe(sessionId: string, id: string): boolean;
  close(id: string): Promise<void>;
  closeAll(): Promise<void>;
  installChild?(spec: ChildWatch): Promise<void>;
  restoreChild?(spec: ChildWatch): void;
}

export interface ChildSourcePorts {
  readonly machines: {
    get(id: string): { readonly fs: Pick<ReturnType<NonNullable<FilePorts["machines"]>["get"]>["fs"], "read" | "stat"> };
  };
  readonly rows: (sessionId: string) => readonly ChildRow[];
  readonly admit: NonNullable<WatchSenders["admit"]>;
}

/** Consecutive drains in which every configured source failed; the third retires the chain. */
const CHILD_FAILURE_LIMIT = 3;

type ChildFs = ReturnType<ChildSourcePorts["machines"]["get"]>["fs"];

/**
 * The anchored generation: fixed size plus the hash of its first bytes. A size-0 anchor hashed
 * no bytes, so the caller passes none and the first non-empty generation is adopted silently.
 */
async function anchoredGeneration(fs: ChildFs, path: string, size: number, old: Generation | undefined): Promise<Generation> {
  const anchorSize = old !== undefined && size >= old.size ? old.size : size;
  const prefix = anchorSize === 0 ? new Uint8Array() : (await fs.read(path, { offset: 0, limit: Math.min(anchorSize, 4096) })).data;
  const prefixSha256 = sourceDigest(prefix);
  if (old !== undefined && size >= old.size && old.prefixSha256 === prefixSha256) return old;
  return {
    kind: "size-and-prefix-hash", size,
    prefixSha256: anchorSize === size ? prefixSha256 : sourceDigest((await fs.read(path, { offset: 0, limit: Math.min(size, 4096) })).data),
  };
}

class ChildSourceError extends Error {
  constructor(readonly code: "pack_missing" | "source_missing" | "not_file" | "read_stalled" | "watch_conflict") {
    super(`child source: ${code}`);
    this.name = "ChildSourceError";
  }
}

/** Both remote files share one source, one serialized drain, and the existing alarm cadence. */
export function childSource(
  spec: ChildWatch,
  ports: ChildSourcePorts,
  options: {
    readonly clock: () => number;
    readonly failure: (error: Error) => void;
    /** After every drain: false when every configured source failed, true otherwise. */
    readonly drained?: (progress: boolean) => void;
  },
): AlarmSource & { observe(): Promise<void> } {
  const selected = selectPack(spec.occupant);
  if (selected === undefined) throw new ChildSourceError("pack_missing");
  const pack = selected;
  if ((spec.spool === undefined && spec.transcript === undefined) ||
      (spec.spool !== undefined && pack.live === undefined) ||
      (spec.transcript !== undefined && pack.transcript === undefined))
    throw new ChildSourceError("source_missing");
  const admitted = new Map(ports.rows(spec.sessionId).map((row) => [row.key, row]));
  const childFacts = new Set([...admitted.values()].flatMap((row) =>
    row.kind === "child_fact" && row.content.child === spec.child ? [row.key] : []));
  const configured = [spec.spool, spec.transcript].filter((location) => location !== undefined).length;
  let spool: SpoolCursor | undefined;
  let transcript: TranscriptCursor | undefined;
  let closed = false;
  // Transcript reads are stamped strictly later than the previous read of this child, even inside
  // one clock millisecond: two reads across a generation change must never tie in `currentState`.
  let lastObservedAt = [...admitted.values()].reduce((last, row) =>
    row.kind === "child_receipt" && childFacts.has(row.content.factKey) && !("kind" in row.content.ref)
      ? Math.max(last, row.content.observedAt) : last, -1);
  const observedAt = () => {
    lastObservedAt = Math.max(options.clock(), lastObservedAt + 1);
    return lastObservedAt;
  };

  function restored(location: NonNullable<ChildWatch["spool"]>): TranscriptCursor | undefined {
    const refs: TranscriptRef[] = [];
    for (const row of admitted.values()) {
      if (row.kind !== "child_receipt" || !childFacts.has(row.content.factKey)) continue;
      const ref = row.content.ref;
      if (!("kind" in ref)) refs.push(ref);
      refs.push(...row.content.diagnostics.flatMap((diagnostic) => {
        if (diagnostic.code !== "spool_ref") return [];
        const parsed = parseJson(TranscriptRef, diagnostic.detail);
        return parsed === undefined ? [] : [parsed];
      }));
    }
    const ref = refs.filter((entry) =>
      entry.machine === location.machine && entry.export === location.export && entry.path === location.path,
    ).at(-1);
    return ref?.generation.kind === "size-and-prefix-hash"
      ? { checkpoint: { generation: ref.generation, offsetBytes: ref.range.offsetBytes + ref.range.lengthBytes }, tail: new Uint8Array() }
      : undefined;
  }

  async function read(location: NonNullable<ChildWatch["spool"]>, previous: TranscriptCursor | undefined) {
    const fs = ports.machines.get(location.machine).fs;
    const stat = await fs.stat(location.path).catch((error: Error) => {
      if (error instanceof MachineRefusalError && error.reason === "not_found") return undefined;
      throw error;
    });
    if (stat === undefined) return undefined;
    if (stat.kind !== "file") throw new ChildSourceError("not_file");
    // A size-0 anchor anchors nothing: the first non-empty generation is adopted, not reported as a rewrite.
    const anchor = previous === undefined || previous.checkpoint.generation.size === 0 ? undefined : previous;
    const generation = await anchoredGeneration(fs, location.path, stat.size, anchor?.checkpoint.generation);
    const resumed = transcriptCursor(anchor, generation).cursor;
    const offset = resumed.checkpoint.offsetBytes + resumed.tail.length;
    const chunk = offset >= stat.size ? new Uint8Array() : (await fs.read(location.path, { offset, limit: 256 * 1024 })).data;
    if (offset < stat.size && chunk.length === 0) throw new ChildSourceError("read_stalled");
    return {
      ref: { ...location, generation, range: { offsetBytes: offset, lengthBytes: chunk.length } },
      chunk,
      more: offset + chunk.length < stat.size,
      anchor,
    };
  }

  /** What the journal holds, so memory never disagrees with it after a refused or lost Deliver. */
  const refresh = () => {
    for (const persisted of ports.rows(spec.sessionId)) admitted.set(persisted.key, persisted);
  };
  async function accept(rows: readonly ChildRow[]) {
    for (const row of rows) {
      if (closed) return;
      if (admitted.has(row.key)) continue;
      let accepted: readonly ChildRow[];
      try {
        accepted = await ports.admit(spec.sessionId, [row]);
      } catch (error) {
        // A Deliver may have committed before its reply was lost: the retry must see what the journal holds.
        refresh();
        throw error;
      }
      // A Deliver-side idempotency conflict answers with the conflict row only. The requested
      // key is never re-derived without an intervening thrown Deliver (the cursor advances past
      // the bytes), and that path refreshes above, so no further refresh is needed here.
      for (const entry of accepted) admitted.set(entry.key, entry);
    }
  }

  async function drainSpool(location: NonNullable<ChildWatch["spool"]>) {
      // The sequence belongs to the child, so it is restored even when this file location has no checkpoint.
      spool ??= {
        file: restored(location),
        lastSeq: [...admitted.values()].reduce((seq, row) =>
          row.kind === "child_receipt" && childFacts.has(row.content.factKey) && "kind" in row.content.ref
            ? Math.max(seq, row.content.ref.seq) : seq, -1),
      };
      let more = true;
      while (more && !closed) {
        const input = await read(location, spool.file);
        if (input === undefined) break;
        const decoded = decodeSpool({ ...input, pack, child: spec.child, turn: spec.turn, cursor: { ...spool, file: input.anchor } });
        await accept([...reconcile(decoded.observations, [...admitted.values()], decoded.replays), ...decoded.diagnostics.map((diagnostic) => diagnosticRow({ child: spec.child, turn: spec.turn }, diagnostic))]);
        spool = decoded.cursor;
        more = input.more;
      }
  }
  async function drainTranscript(location: NonNullable<ChildWatch["transcript"]>) {
      transcript ??= restored(location);
      let more = true;
      while (more && !closed) {
        const input = await read(location, transcript);
        if (input === undefined) break;
        const decoded = decodeTranscript({ ...input, pack, child: spec.child, turn: spec.turn, observedAt: observedAt(), ...(input.anchor === undefined ? {} : { cursor: input.anchor }) });
        await accept([...reconcile(decoded.observations, [...admitted.values()]), ...decoded.diagnostics.map((diagnostic) => diagnosticRow({ child: spec.child, turn: spec.turn }, diagnostic))]);
        transcript = decoded.cursor;
        more = input.more;
      }
  }
  /** Each source drains on its own: a broken spool read must not stop transcript admission. */
  async function drain(): Promise<Error[]> {
    const failures: Error[] = [];
    const isolated = (run: Promise<void>) => run.catch((error: Error) => { failures.push(error); });
    if (spec.spool !== undefined) await isolated(drainSpool(spec.spool));
    if (spec.transcript !== undefined) await isolated(drainTranscript(spec.transcript));
    return failures;
  }
  const report = (failures: readonly Error[]) => {
    for (const failure of failures) options.failure(failure);
  };
  const settle = (failures: Error[]) => {
    options.drained?.(failures.length < configured);
    return failures;
  };
  // The first drain settles `ready`: it refuses only when every configured source failed.
  const ready = drain().then(settle).then((failures) => {
    const [first] = failures;
    if (first !== undefined && failures.length === configured) {
      report(failures.slice(1));
      throw first;
    }
    report(failures);
  });
  let pending = ready;
  return {
    ready,
    observe() {
      pending = pending.then(() => closed ? undefined : drain().then(settle).then(report)).catch((error: Error) => options.failure(error));
      return pending;
    },
    async close() {
      closed = true;
      await pending;
    },
  };
}

interface Holder {
  source: AlarmSource;
  /** Per-watch send serialization: occurrences leave in source order. */
  tail: Promise<void>;
  /** The chain's current occurrence and budget — swapped on every re-arm. */
  current: ArmedWatch;
}

export function createWatchSources(
  senders: WatchSenders,
  options: {
    readonly clock: () => number;
    readonly failure: (watchId: string, error: Error) => void;
    /** Absent means this brain has no body: terminal watches are refused at create. */
    readonly machines?: TerminalWatchMachines;
    /** Test seam for a lost native event (G015); production uses the native installer. */
    readonly pathWatch?: PathWatchInstaller | undefined;
    /** Retires the path's alarm chain through the live entity arm verb. */
    readonly retirePath?: (sessionId: string, watchId: string) => Promise<void>;
    /** The child reader's body-side ports; admission itself is the senders' door. */
    readonly children?: Omit<ChildSourcePorts, "admit">;
  },
): WatchSources {
  // The watch plane owns the boot-time runtime requirement: composing it on a
  // Bun without PTY support is a typed refusal, not a first-watch surprise.
  assertAlarmRuntime();
  const holders = new Map<string, Holder>();
  const children = new Map<string, { readonly spec: ChildWatch; readonly source: AlarmSource }>();
  /** Consecutive all-source drain failures per child watch; a drain that made progress clears it. */
  const starved = new Map<string, number>();
  const exhausted = (id: string) => (starved.get(id) ?? 0) >= CHILD_FAILURE_LIMIT;

  function enqueue(holder: Holder, hit: WatchHit): void {
    const { sessionId, occurrence, base } = holder.current;
    const send: WatchHitSend = {
      sessionId,
      occurrenceId: occurrence.occurrenceId,
      purpose: Bundle.MONITOR_HIT,
      alarmId: occurrence.alarmId,
      armSeq: occurrence.armSeq,
      sourceKey: Bundle.MONITOR_SOURCE,
      payload: JSON.stringify({ spec: base.spec, notifications: base.notifications, hit }),
      fireAt: options.clock(),
    };
    holder.tail = holder.tail
      .then(() => senders.deliver(send))
      .catch((error: Error) => options.failure(occurrence.alarmId, error));
  }

  function summary(
    spec: ArmedWatch,
    reason: "exit" | "source_error",
    exitCode: number | null,
    output?: string,
  ): WatchHit {
    return {
      content: JSON.stringify(
        output === undefined
          ? { watchId: spec.id, reason, exitCode }
          : { watchId: spec.id, reason, exitCode, output },
      ),
      terminal: true,
      detail: reason === "exit" ? `exit:${exitCode ?? "null"}` : reason,
    };
  }

  function sourceFailure(spec: ArmedWatch, holder: Holder, error: Error): void {
    enqueue(holder, summary(spec, "source_error", null));
    options.failure(spec.id, error);
  }

  function startCommand(
    spec: ArmedWatch,
    watchSpec: Extract<Alarm.Watch, { command: string }>,
    holder: Holder,
  ): AlarmSource {
    const filter = watchSpec.filter === undefined ? undefined : new RegExp(watchSpec.filter);
    let lines = 0;
    // The failing command's own words (PTY output merges stdout and stderr):
    // a nonzero exit surfaces this in the summary so a watch that dies at
    // birth (bad flag, unusable TERM) names its cause.
    let lastLine = "";
    return commandSource(
      watchSpec.command,
      (content) => {
        lines += 1;
        if (content.length > 0) lastLine = content;
        if (filter === undefined || filter.test(content))
          enqueue(holder, { content, terminal: false, detail: `line:${lines}` });
      },
      (code) => enqueue(holder, summary(spec, "exit", code, code === 0 || lastLine === "" ? undefined : lastLine)),
      (error) => sourceFailure(spec, holder, error),
    );
  }

  function startTerminal(
    spec: ArmedWatch,
    watchSpec: Extract<Alarm.Watch, { session: string }>,
    holder: Holder,
  ): AlarmSource {
    const machines = options.machines;
    if (machines === undefined)
      throw new AlarmSourceError(new Error("no machines plane is composed"), "terminal.open");
    const filter = watchSpec.filter === undefined ? undefined : new RegExp(watchSpec.filter);
    let lines = 0;
    return terminalSource(
      machines.get(watchSpec.machine).pty,
      watchSpec.session,
      (content) => {
        lines += 1;
        if (filter === undefined || filter.test(content))
          enqueue(holder, { content, terminal: false, detail: `pty:${lines}` });
      },
      (error) => sourceFailure(spec, holder, error),
    );
  }

  function startPath(
    spec: ArmedWatch,
    watchSpec: Extract<Alarm.Watch, { path: string }>,
    holder: Holder,
  ): AlarmSource {
    return pathSource(
      watchSpec,
      (content, identity) =>
        enqueue(holder, { content, terminal: false, detail: `path:${identity}` }),
      (error) => sourceFailure(spec, holder, error),
      options.pathWatch,
    );
  }

  const retirements = new Set<Promise<void>>();
  let shutdown: Promise<void> | undefined;

  function trackRetirement(retirement: Promise<void>): Promise<void> {
    retirements.add(retirement);
    void retirement.then(
      () => retirements.delete(retirement),
      () => retirements.delete(retirement),
    );
    return retirement;
  }

  function retire(id: string): Promise<void> {
    const child = children.get(id);
    if (child !== undefined) {
      children.delete(id);
      starved.delete(id);
      return trackRetirement(child.source.close().then(() => options.retirePath?.(child.spec.sessionId, id)));
    }
    const holder = holders.get(id);
    if (holder === undefined) return Promise.resolve();
    holders.delete(id);
    const retirement = (async () => {
      await holder.source.close();
      await holder.tail;
      if ("path" in holder.current.base.spec.watch) {
        try {
          await options.retirePath?.(holder.current.sessionId, id);
        } catch (error) {
          options.failure(id, error instanceof Error ? error : new AlarmSourceError(undefined, "path.retire"));
        }
      }
    })();
    return trackRetirement(retirement);
  }

  function close(id: string): Promise<void> {
    // Shutdown is one recorded join. A late alarm callback closes nothing and
    // joins that same result instead of starting work against a disposed app.
    return shutdown === undefined ? retire(id) : shutdown;
  }

  /** In-flight installs by watch id: a concurrent duplicate adopts the winner. */
  const pending = new Map<string, Promise<void>>();

  async function startHolder(spec: ArmedWatch): Promise<void> {
      if (shutdown !== undefined) throw new Bundle.WatchRefused({ reason: "shutdown" });
      // Reinstall replaces any previous handle before a new occurrence leaves.
      await close(spec.id);
      if (shutdown !== undefined) throw new Bundle.WatchRefused({ reason: "shutdown" });
      const holder: Holder = {
        source: { close: () => Promise.resolve() },
        tail: Promise.resolve(),
        current: spec,
      };
      const watchSpec = spec.base.spec.watch;
      holder.source =
        "command" in watchSpec
          ? startCommand(spec, watchSpec, holder)
          : "path" in watchSpec
            ? startPath(spec, watchSpec, holder)
            : startTerminal(spec, watchSpec, holder);
      // A terminal watch subscribes before create/rearm returns, so no trigger
      // can race the cursor baseline; a failed subscription refuses the arm.
      try {
        await holder.source.ready;
        if (shutdown !== undefined) throw new Bundle.WatchRefused({ reason: "shutdown" });
      } catch (error) {
        await holder.source.close();
        throw error;
      }
      holders.set(spec.id, holder);
  }

  async function startChild(spec: ChildWatch) {
      if (shutdown !== undefined) throw new Bundle.WatchRefused({ reason: "shutdown" });
      const existing = children.get(spec.id);
      if (existing !== undefined) {
        if (canonicalJson(existing.spec) !== canonicalJson(spec)) throw new ChildSourceError("watch_conflict");
        await existing.source.ready;
        return;
      }
      if (holders.has(spec.id) || [...children.values()].some((child) => child.spec.child === spec.child))
        throw new ChildSourceError("watch_conflict");
      const admit = senders.admit;
      if (options.children === undefined || admit === undefined) throw new ChildSourceError("source_missing");
      const source = childSource(spec, { ...options.children, admit }, {
        clock: options.clock,
        failure: (error) => options.failure(spec.id, error),
        drained: (progress) => {
          if (progress) starved.delete(spec.id);
          else starved.set(spec.id, (starved.get(spec.id) ?? 0) + 1);
        },
      });
      children.set(spec.id, { spec, source });
      try {
        await source.ready;
        if (shutdown !== undefined) throw new Bundle.WatchRefused({ reason: "shutdown" });
      } catch (error) {
        children.delete(spec.id);
        await source.close().catch((closing: Error) => {
          if (closing !== error) options.failure(spec.id, closing);
        });
        throw error;
      }
  }

  function installChild(spec: ChildWatch): Promise<void> {
    // An explicit install is a fresh start: earlier starvation does not count against it.
    starved.delete(spec.id);
    return startChild(spec);
  }

  function restoreChild(spec: ChildWatch): void {
    // A starved chain is not re-installed: this tick's observe refuses and the wake retires it.
    if (exhausted(spec.id)) return;
    // An alarm already owns the receiver's mailbox. Queue intake here and
    // let the alarm return before its Deliver RPC waits on that same entity.
    void startChild(spec).catch((error: Error) => options.failure(spec.id, error));
  }

  return {
    installChild,
    restoreChild,
    async install(spec) {
      if (shutdown !== undefined) throw new Bundle.WatchRefused({ reason: "shutdown" });
      // #1254 H2: an arm's forward and the watch verb's awaited install may
      // race for the same fresh chain. The loser adopts the winner's handle
      // (occurrence swap) instead of starting a second native source.
      const inflight = pending.get(spec.id);
      if (inflight !== undefined) {
        await inflight.catch(() => undefined);
        if (shutdown !== undefined) throw new Bundle.WatchRefused({ reason: "shutdown" });
        const holder = holders.get(spec.id);
        if (holder !== undefined) {
          holder.current = spec;
          return;
        }
      }
      const task = startHolder(spec);
      pending.set(spec.id, task);
      try {
        await task;
      } finally {
        pending.delete(spec.id);
      }
    },
    refresh(spec) {
      const holder = holders.get(spec.id);
      if (holder === undefined) return false;
      holder.current = spec;
      return true;
    },
    observe(sessionId, id) {
      const child = children.get(id);
      if (child?.spec.sessionId === sessionId && !exhausted(id)) {
        child.source.observe?.();
        return true;
      }
      if (exhausted(id) && (child === undefined || child.spec.sessionId === sessionId)) {
        // Three consecutive all-source failures: the handle goes, the count resets
        // and the refused observation lets the wake retire the chain.
        starved.delete(id);
        if (child !== undefined) {
          children.delete(id);
          void trackRetirement(child.source.close()).catch((error: Error) => options.failure(id, error));
        }
        return false;
      }
      const holder = holders.get(id);
      const source = holder?.current.sessionId === sessionId ? holder.source : undefined;
      if (source?.observe === undefined) return false;
      source.observe();
      return true;
    },
    close,
    closeAll() {
      shutdown ??= Promise.resolve().then(async () => {
        await Promise.allSettled([...pending.values()]);
        await Promise.allSettled([...holders.keys()].map(retire));
        await Promise.allSettled([...children.keys()].map(retire));
        while (retirements.size > 0) await Promise.allSettled([...retirements]);
      });
      return shutdown;
    },
  };
}
