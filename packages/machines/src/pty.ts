import { Machine } from "@openomni/protocol";
import { Deferred, Effect, Exit } from "effect";
import type { CommandRunner } from "./commands";
import { MachinesFailure, type MachineError } from "./errors";
import { startPtyControl, type PtyControl, type PtyControlFactory } from "./pty-control";
import { createPtyRegistry, type PtySessionRecord } from "./pty-registry";

/**
 * tmux session adapter (#1273): persistent named terminals for an attached
 * machine. One control-mode client per daemon observes `%output`; each named
 * terminal is its own detached tmux session whose window is linked into the
 * control session (control mode only reports panes of the attached session).
 * Reads replay a `capture-pane -S -` snapshot taken at attach, then live
 * output, on one cursor sequence. The tmux server, not the daemon, owns
 * session lifetime, which is what carries terminals across a daemon restart.
 */
const PTY_CONTROL_SESSION = "omo-pty-control";
/** Input bytes per send-keys command; hex encoding keeps control lines short. */
const WRITE_CHUNK_BYTES = 128;
/** Screen a fresh `pty_open` session gets until `pty_resize`; a screen snapshot has this many rows. */
export const PTY_OPEN_SIZE = { cols: 80, rows: 24 } as const;

const ptyNotAvailable = { status: "refused", reason: "pty_not_available" } as const;
const ptyNotFound = { status: "refused", reason: "pty_not_found" } as const;

export interface PtyAdapterOptions {
  /** Injected entropy (#1245): the cursor generation id for this daemon run. */
  readonly id: () => string;
  /** Attach-time PATH probe travels the same injectable shell-out port as #1274. */
  readonly runner: CommandRunner;
  readonly tmux?: string;
  /** Private `tmux -L` socket name; tests isolate from the user's server. */
  readonly socketName?: string;
  /** Injected control-client factory; unit tests script the server side. */
  readonly control?: PtyControlFactory;
  /**
   * Wall clock for screen snapshots (#1510): `observedAt` is this clock at
   * capture, never ambient time. A daemon composed without one cannot stamp
   * a snapshot, so a screen read fails typed instead of inventing an instant.
   */
  readonly now?: () => number;
}

export interface PtyAdapter {
  /** Attach-time gate: `pty.session` is offered only when tmux resolves on PATH. */
  offeredCapabilities(requested: readonly string[]): Effect.Effect<string[], MachineError>;
  open(request: Machine.PtyOpenRequest): Effect.Effect<Machine.PtyOpenResult, MachineError>;
  write(request: Machine.PtyWriteRequest): Effect.Effect<Machine.PtyWriteResult, MachineError>;
  /** Byte stream after `cursor`, or (#1510) the rendered screen when `source` is `"screen"`. */
  read(request: Machine.PtyReadScreenRequest): Effect.Effect<Machine.PtyScreenResult, MachineError>;
  read(request: Machine.PtyReadRequest): Effect.Effect<Machine.PtyReadResult, MachineError>;
  read(request: Machine.PtyReadParams): Effect.Effect<Machine.PtyReadResult | Machine.PtyScreenResult, MachineError>;
  resize(request: Machine.PtyResizeRequest): Effect.Effect<Machine.PtyResizeResult, MachineError>;
  close(request: Machine.PtyCloseRequest): Effect.Effect<Machine.PtyCloseResult, MachineError>;
  list(request: Machine.PtyListRequest): Effect.Effect<Machine.PtyListResult, MachineError>;
  /** Stop the control client and settle waiters; the tmux server stays alive. */
  shutdown(): Effect.Effect<void, MachineError>;
}

const quote = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * One `display-message -p` line answers every pane fact the snapshot needs:
 * cursor cell, dead flag, foreground pid, then the process name (which may
 * itself contain spaces, so it takes the rest of the line).
 */
const PANE_FACTS_FORMAT = '"#{cursor_x} #{cursor_y} #{pane_dead} #{pane_pid} #{pane_current_command}"';
const PANE_FACTS = /^(\d+) (\d+) ([01]) (\d*) ?(.*)$/;
type ScreenOk = Extract<Machine.PtyScreenResult, { status: "ok" }>;
/** Structural facts only: a dead pane or no pid is `occupant: null`, never a guess. */
function paneFacts(lines: readonly string[]): Pick<ScreenOk, "cursor" | "occupant"> | undefined {
  const match = lines.length === 1 ? (lines[0] ?? "").match(PANE_FACTS) : null;
  if (match === null) return undefined;
  const [, x, y, dead, pid, command] = match;
  const occupantPid = Number(pid);
  const occupant = dead === "1" || !Number.isInteger(occupantPid) || occupantPid <= 0 ? null : { pid: occupantPid, command: command ?? "" };
  return { cursor: { x: Number(x), y: Number(y) }, occupant };
}

export function createPtyAdapter(options: PtyAdapterOptions): PtyAdapter {
  const tmux = options.tmux ?? "tmux";
  const socketArgs = options.socketName === undefined ? [] : ["-L", options.socketName];
  const factory = options.control ?? startPtyControl;
  const registry = createPtyRegistry(options.id());
  const paneRoutes = new Map<string, PtySessionRecord>();
  let available = false;
  let control: PtyControl | undefined;
  let starting: Deferred.Deferred<PtyControl, MachineError> | undefined;

  function serverLost(): void {
    control = undefined;
    available = false;
    paneRoutes.clear();
    registry.markAllLost();
  }
  function poison(paneId: string | undefined, reason: string): void {
    for (const record of paneRoutes.values()) {
      if (paneId === undefined || record.paneId === paneId) record.poisoned = reason;
    }
  }
  // Production daemons share the user's DEFAULT tmux server: names outside
  // the protocol grammar (e.g. `tmux new -s UPPER`) must stay invisible, or
  // one foreign session poisons every host-side PtyListResult decode.
  const conforming = (name: string): boolean =>
    name !== PTY_CONTROL_SESSION && Machine.PtySessionName.safeParse(name).success;
  const listNames = (ctl: PtyControl): Effect.Effect<string[], MachineError> =>
    Effect.map(ctl.command('list-sessions -F "#{session_name}"'), (lines) => lines.filter(conforming));
  const discover = (ctl: PtyControl): Effect.Effect<void, MachineError> =>
    Effect.map(listNames(ctl), (names) => {
      for (const name of names) {
        const existing = registry.get(name);
        if (existing?.lost === true) registry.remove(name);
        if (existing === undefined || existing.lost) registry.register(name);
      }
    });
  const start: Effect.Effect<PtyControl, MachineError> = Effect.gen(function* () {
    const started = yield* factory({
      argv: [tmux, ...socketArgs, "-C", "new-session", "-A", "-s", PTY_CONTROL_SESSION],
      onOutput: (paneId, data) => {
        const record = paneRoutes.get(paneId);
        if (record !== undefined) registry.append(record, data);
      },
      onMalformed: poison,
      onExit: serverLost,
    });
    yield* discover(started);
    control = started;
    return started;
  });
  const ensureControl: Effect.Effect<PtyControl, MachineError> = Effect.suspend(() => {
    if (control !== undefined) return Effect.succeed(control);
    if (starting !== undefined) return Deferred.await(starting);
    return Effect.gen(function* () {
      const gate = yield* Deferred.make<PtyControl, MachineError>();
      starting = gate;
      return yield* start.pipe(
        Effect.onExit((exit) => {
          starting = undefined;
          return Deferred.done(gate, exit);
        }),
      );
    });
  });

  /** Known means registered or present on the tmux server (restart discovery). */
  const resolve = (ctl: PtyControl, name: string): Effect.Effect<PtySessionRecord | undefined, MachineError> =>
    Effect.suspend(() => {
      if (name === PTY_CONTROL_SESSION) return Effect.succeed(undefined);
      const record = registry.get(name);
      if (record !== undefined && !record.lost) return Effect.succeed(record);
      return Effect.map(listNames(ctl), (names) => {
        if (!names.includes(name)) return undefined;
        if (record !== undefined) registry.remove(name);
        return registry.register(name);
      });
    });

  /** Trim the blank bottom rows capture-pane reports for an unused screen. */
  function snapshot(lines: string[]): Buffer {
    let end = lines.length;
    while (end > 0 && lines[end - 1] === "") end -= 1;
    const text = lines.slice(0, end).join("\n");
    return Buffer.from(text.length === 0 ? "" : `${text}\n`, "utf8");
  }
  const attach = (ctl: PtyControl, record: PtySessionRecord): Effect.Effect<void, MachineError> =>
    Effect.gen(function* () {
      if (record.attached) return;
      const panes = yield* ctl.command(`list-panes -t =${record.name}: -F "#{window_id} #{pane_id}"`);
      const [windowId, paneId] = (panes[0] ?? "").split(" ");
      if (windowId === undefined || paneId === undefined || panes.length !== 1)
        return yield* new MachinesFailure({ operation: "pty.attach", cause: `expected one pane in session ${record.name}` });
      yield* ctl.command(`link-window -s ${windowId} -t ${PTY_CONTROL_SESSION}:`);
      // The capture reply is a barrier: output produced before it ran is in
      // the snapshot, and %output routes only once the pane is registered
      // below, so replay and live never duplicate a byte.
      const captured = yield* ctl.command(`capture-pane -p -t ${paneId} -S - -E -`);
      record.windowId = windowId;
      record.paneId = paneId;
      record.replay = snapshot(captured);
      record.attached = true;
      paneRoutes.set(paneId, record);
    });

  type Refusal = typeof ptyNotAvailable | typeof ptyNotFound;
  function session<A>(name: string, body: (ctl: PtyControl, record: PtySessionRecord) => Effect.Effect<A, MachineError>): Effect.Effect<A | Refusal, MachineError> {
    return Effect.suspend((): Effect.Effect<A | Refusal, MachineError> => {
      if (!available) return Effect.succeed(ptyNotAvailable);
      return Effect.gen(function* () {
        const ctl = yield* ensureControl;
        const record = yield* resolve(ctl, name);
        if (record === undefined) return ptyNotFound;
        yield* attach(ctl, record);
        return yield* body(ctl, record);
      });
    });
  }

  const awaitOutput = (record: PtySessionRecord, waitMs: number): Effect.Effect<void, MachineError> =>
    Effect.gen(function* () {
      const woke = yield* Deferred.make<void>();
      const cancel = registry.awaitOutput(record, () => Deferred.doneUnsafe(woke, Exit.void));
      yield* Deferred.await(woke).pipe(Effect.timeoutOption(waitMs), Effect.ensuring(Effect.sync(cancel)));
    });

  function open(request: Machine.PtyOpenRequest): Effect.Effect<Machine.PtyOpenResult, MachineError> {
    return Effect.suspend(() => {
      if (!available || request.name === PTY_CONTROL_SESSION) return Effect.succeed<Machine.PtyOpenResult>(ptyNotAvailable);
      // The wire schema already rejects non-conforming names; this guard keeps
      // direct adapter use typed instead of colliding with a foreign session.
      if (!conforming(request.name)) return Effect.succeed<Machine.PtyOpenResult>(ptyNotFound);
      return Effect.gen(function* () {
        const ctl = yield* ensureControl;
        const existing = yield* resolve(ctl, request.name);
        const record = yield* Effect.suspend(() => {
          if (existing !== undefined) return Effect.succeed(existing);
          return Effect.map(
            ctl.command(`new-session -d -s ${request.name} -c ${quote(request.cwd)} -x ${PTY_OPEN_SIZE.cols} -y ${PTY_OPEN_SIZE.rows}`),
            () => registry.register(request.name),
          );
        });
        yield* attach(ctl, record);
        return { status: "ok", cursor: registry.startCursor() } as const;
      });
    });
  }

  /** A malformed control record fails exactly one read; streaming then resumes. */
  function poisonedFailure(record: PtySessionRecord): MachinesFailure | undefined {
    if (record.poisoned === undefined) return undefined;
    const reason = record.poisoned;
    record.poisoned = undefined;
    return new MachinesFailure({ operation: "pty.read", cause: `malformed tmux control output: ${reason}` });
  }
  const okView = (view: ReturnType<typeof registry.read>) =>
    ({ status: "ok", data: view.data.toString("base64"), cursor: view.cursor, truncated: view.truncated }) as const;
  function stream(request: Machine.PtyReadRequest): Effect.Effect<Machine.PtyReadResult, MachineError> {
    return session(request.name, (_ctl, record) =>
      Effect.gen(function* () {
        const poisoned = poisonedFailure(record);
        if (poisoned !== undefined) return yield* poisoned;
        const view = registry.read(record, request.cursor);
        const waitMs = request.waitMs ?? 0;
        if (view.data.length > 0 || waitMs <= 0 || record.closed || record.lost) return okView(view);
        yield* awaitOutput(record, waitMs);
        if (record.closed || record.lost) return available ? ptyNotFound : ptyNotAvailable;
        return okView(registry.read(record, request.cursor));
      }),
    );
  }
  /**
   * Screen snapshot (#1510): the rendered pane with its escapes plus the
   * pane facts, captured on the daemon in two control commands. Nothing here
   * waits or judges readiness; malformed tmux facts fail typed.
   */
  const screen = (ctl: PtyControl, record: PtySessionRecord): Effect.Effect<ScreenOk, MachineError> =>
    Effect.gen(function* () {
      const now = options.now;
      if (now === undefined)
        return yield* new MachinesFailure({ operation: "pty.screen", cause: "daemon has no clock to stamp observedAt" });
      const pane = record.paneId ?? "";
      const rows = yield* ctl.command(`capture-pane -p -e -t ${pane}`);
      const facts = paneFacts(yield* ctl.command(`display-message -p -t ${pane} ${PANE_FACTS_FORMAT}`));
      if (facts === undefined) return yield* new MachinesFailure({ operation: "pty.screen", cause: "invalid tmux pane facts" });
      return { status: "ok", rows, ...facts, observedAt: now() } as const;
    });
  function read(request: Machine.PtyReadScreenRequest): Effect.Effect<Machine.PtyScreenResult, MachineError>;
  function read(request: Machine.PtyReadRequest): Effect.Effect<Machine.PtyReadResult, MachineError>;
  function read(request: Machine.PtyReadParams): Effect.Effect<Machine.PtyReadResult | Machine.PtyScreenResult, MachineError>;
  function read(request: Machine.PtyReadParams): Effect.Effect<Machine.PtyReadResult | Machine.PtyScreenResult, MachineError> {
    return "source" in request ? session(request.name, screen) : stream(request);
  }

  function write(request: Machine.PtyWriteRequest): Effect.Effect<Machine.PtyWriteResult, MachineError> {
    return session(request.name, (ctl, record) =>
      Effect.gen(function* () {
        const data = Buffer.from(request.data, "base64");
        for (let at = 0; at < data.length; at += WRITE_CHUNK_BYTES) {
          const hex = [...data.subarray(at, at + WRITE_CHUNK_BYTES)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(" ");
          yield* ctl.command(`send-keys -t ${record.paneId ?? ""} -H ${hex}`);
        }
        return { status: "ok" } as const;
      }),
    );
  }

  function resize(request: Machine.PtyResizeRequest): Effect.Effect<Machine.PtyResizeResult, MachineError> {
    return session(request.name, (ctl) =>
      Effect.gen(function* () {
        yield* ctl.command(`set-option -w -t =${request.name}: window-size manual`);
        yield* ctl.command(`resize-window -t =${request.name}: -x ${request.cols} -y ${request.rows}`);
        return { status: "ok" } as const;
      }),
    );
  }

  function close(request: Machine.PtyCloseRequest): Effect.Effect<Machine.PtyCloseResult, MachineError> {
    return Effect.suspend(() => {
      if (!available) return Effect.succeed<Machine.PtyCloseResult>(ptyNotAvailable);
      return Effect.gen(function* () {
        const ctl = yield* ensureControl;
        // Close is a teardown guarantee (#1275): a session whose shell already
        // exited on its own (the browser launch line exits once Chromium
        // stops) is gone on the server but may still be recorded, and closing
        // it must drop the record either way. So a recorded-but-lost session
        // stays closable, and a kill-session failure is re-checked against
        // the server: only a session that still exists propagates the error.
        const record = registry.get(request.name) ?? (yield* resolve(ctl, request.name));
        if (record === undefined) return ptyNotFound;
        yield* ctl.command(`kill-session -t =${record.name}`).pipe(
          Effect.catch((error) =>
            Effect.flatMap(listNames(ctl), (names) => (names.includes(record.name) ? Effect.fail(error) : Effect.void)),
          ),
        );
        // The window survives its session through the control-session link;
        // killing it ends the processes without touching other terminals. A
        // kill-window failure is NOT proof of teardown (#1293 r1): the control
        // transport can drop or the command can time out while the linked
        // window - and the processes it holds - survive. Re-check the server
        // exactly like the kill-session path above: a confirmed-absent window
        // (the shell already exited with its dead pane) is the tolerated
        // outcome; a surviving window or a failed verification propagates and
        // keeps the record, so close stays retryable instead of reporting ok
        // over a live window.
        if (record.windowId !== undefined) {
          const windowId = record.windowId;
          yield* ctl.command(`kill-window -t ${windowId}`).pipe(
            Effect.catch((error) =>
              Effect.flatMap(ctl.command('list-windows -a -F "#{window_id}"'), (ids) =>
                ids.includes(windowId) ? Effect.fail(error) : Effect.void,
              ),
            ),
          );
        }
        if (record.paneId !== undefined) paneRoutes.delete(record.paneId);
        registry.remove(record.name);
        return { status: "ok" } as const;
      });
    });
  }

  function list(_request: Machine.PtyListRequest): Effect.Effect<Machine.PtyListResult, MachineError> {
    return Effect.suspend(() => {
      if (!available) return Effect.succeed<Machine.PtyListResult>(ptyNotAvailable);
      return Effect.gen(function* () {
        const ctl = yield* ensureControl;
        const names = yield* listNames(ctl);
        for (const name of names) if (registry.get(name) === undefined) registry.register(name);
        const sessions = registry
          .names()
          .sort()
          .map((name) => {
            const record = registry.get(name);
            if (record !== undefined && !names.includes(name)) record.lost = true;
            return { name, status: record?.lost === true ? ("lost" as const) : ("live" as const) };
          });
        return {
          status: "ok",
          sessions: sessions.slice(0, Machine.PTY_LIST_MAX_SESSIONS),
          truncated: sessions.length > Machine.PTY_LIST_MAX_SESSIONS,
        } as const;
      });
    });
  }

  function offeredCapabilities(requested: readonly string[]): Effect.Effect<string[], MachineError> {
    return Effect.gen(function* () {
      const offered: string[] = [];
      for (const capability of requested) {
        if (capability !== Machine.WellKnownCapability.ptySession) {
          offered.push(capability);
          continue;
        }
        const probe = yield* options.runner
          .run([tmux, "-V"])
          .pipe(Effect.catchTag("SpawnFailure", () => Effect.succeed(undefined)));
        available = probe !== undefined && probe.exitCode === 0;
        if (available) offered.push(capability);
      }
      return offered;
    });
  }

  return {
    offeredCapabilities,
    open,
    write,
    read,
    resize,
    close,
    list,
    shutdown: () =>
      Effect.suspend(() => {
        const running = control;
        control = undefined;
        available = false;
        registry.markAllLost();
        return running === undefined ? Effect.void : running.close();
      }),
  };
}
