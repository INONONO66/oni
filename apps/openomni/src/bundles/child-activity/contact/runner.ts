import { posix } from "node:path";
import type { LeaseHandle, MachineError, MachineHandle, MachineHost } from "@openomni/machines";
import type { TranscriptRef } from "@openomni/protocol";
import { Duration, Effect } from "effect";
import type { Launch, SubmitRecipe } from "../dialects/pack";
import type { ChildWatch } from "../index";
import { type ChildRow, diagnosticRow } from "../reconcile";
import { sourceDigest } from "../transcript";
import { type CliContact, type CliContactResolution, resolveCliContact } from "./declaration";
import { hookCommand, hookScript } from "./hook-script";
import { type ChildState, childState, foldState, NOTHING_SPOKEN, type StateFold, stateInputOf } from "./rule";

/**
 * The `cli:` contact's runner (#1512): one send is one turn of a child CLI
 * agent in a tmux pane on the declared machine. The runner places the
 * machine, holds its pty lease, writes the pack's live config and launch to
 * the pane, installs one reconciler watch per turn, submits the letter by
 * the pack's recipe, and resolves when the reconciler has admitted the turn's
 * terminal fact — never when the process exits. Every observation it acts
 * on is a persisted row read back through the reconciler; the only rows it
 * derives itself (a stalled prompt or launch) go through the same Deliver
 * door as every other child row.
 *
 * What the runner retains is bounded by the children it launched, not by the
 * sends or the rows it saw (r2 L9): one turn per child — the latest — for the
 * replay short-circuit and the deadline door, and for that turn a summary of
 * its persisted rows (its source-free facts by key and the rule's two
 * scalars), folded as pages arrive. An older key is a new send.
 */

interface CliRunInput {
  /** The contact id after `cli:`. */
  readonly agent: string;
  readonly message: string;
  /** The sender session: the rows' owner and the reply's address. */
  readonly sender: string;
  /** The sender's turn, for the delegation deadline arm. */
  readonly turnId: string;
  /** The send's key: the child turn id every row of this turn carries. */
  readonly key: string;
  readonly deadlineMs?: number;
}

/** The admitted turn the sender's pointer prompt names. */
interface CliTurn {
  readonly child: string;
  readonly turn: string;
  /** How many source-free facts the turn admitted. */
  readonly facts: number;
}

/**
 * A refusal; `landed` means bytes reached the pane, so the letter is never
 * re-sent; `code` names the refusals a composed door maps rather than reports.
 */
interface CliRefusal {
  readonly reason: string;
  readonly landed?: boolean;
  readonly code?: "turn_already_ended";
}

/** One page of a session's persisted child rows after a revision, and the revision to resume from. */
interface CliRowPage {
  readonly rows: readonly ChildRow[];
  readonly revision: number;
}

/** The reconciler surface the runner consumes (`childActivity` in the composition). */
interface CliWatchPorts {
  install(spec: ChildWatch): Effect.Effect<void, CliRefusal>;
  close(id: string): Effect.Effect<void>;
  /** The session's child rows committed after `afterRevision`: the runner pages forward from its last seen revision, never over the whole history. */
  rows(sessionId: string, afterRevision: number): CliRowPage;
  /** The reconciler's one admission door, for the rows this contact derives. */
  admit(sessionId: string, rows: readonly ChildRow[]): Effect.Effect<void, CliRefusal>;
}

/** An armed deadline and its retire door: the same chain armed `at: null` once the turn has ended. */
interface CliDeadlineArm {
  readonly retire: Effect.Effect<void, CliRefusal>;
}

export interface CliRunnerDeps extends CliContactResolution {
  readonly host: Pick<MachineHost, "place" | "get" | "exports">;
  readonly watch: CliWatchPorts;
  /** One call per committed action of the session; `undefined` when the bus offers no subscription. */
  readonly committed: (sessionId: string, listener: () => void) => (() => void) | undefined;
  /** Arms `delegation.deadline` for a cli child; absent means a deadline is not honoured. */
  readonly deadline?: (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly child: string;
    readonly contact: string;
    readonly at: number;
  }) => Effect.Effect<CliDeadlineArm, CliRefusal>;
  readonly id: () => string;
  readonly now: () => number;
}

export interface CliRunner {
  run(input: CliRunInput): Effect.Effect<CliTurn, CliRefusal>;
  /** The deadline door: ETX to the child's pane; the waiting send ends `landed`. A turn that already ended refuses `turn_already_ended`. */
  interrupt(child: string): Effect.Effect<void, CliRefusal>;
  /** Drops every pane this runner launched: watch, tmux session, lease. */
  close(): Effect.Effect<void>;
  /** How many turns the runner holds (r2 L9): one per child it launched, whatever the number of sends. */
  retained(): number;
}

type Location = NonNullable<ChildWatch["spool"]>;
type Fact = Extract<ChildRow, { kind: "child_fact" }>["content"];

/**
 * What one retained turn's persisted rows say so far (r2 L9): its source-free
 * facts by row key — one per phase and tool use, bounded by the turn — and
 * the rule's fold over its receipts. A receipt's fact precedes it (the same
 * or an earlier admission), so the owning turn is always known when the
 * receipt is folded; rows of turns this runner does not retain are dropped.
 */
interface TurnSummary {
  readonly turn: string;
  readonly facts: Map<string, Fact>;
  state: StateFold;
}

/** One sender session's read position and the summaries of its retained turns, by child. */
interface Cursor {
  revision: number;
  readonly children: Map<string, TurnSummary>;
}

/** How a turn ended: the pointer it admitted, or the refusal that ended it. */
type Settled = { readonly kind: "turn"; readonly turn: CliTurn } | { readonly kind: "refused"; readonly refusal: CliRefusal };

interface Turn {
  readonly id: string;
  readonly sessionId: string;
  readonly watch: string;
  interrupted: boolean;
  /** Set the moment the outcome is known, before any await that follows it (r2 L8): a replay of the key returns it, the deadline door refuses on it. */
  settled?: Settled;
  deadline?: CliDeadlineArm;
  readonly wake: Set<() => void>;
}

interface Pane {
  readonly contact: CliContact;
  readonly child: string;
  readonly spool: Location;
  transcript?: Location;
  lease: LeaseHandle;
  turn?: Turn;
}

/** What one turn's persisted receipts say so far: the highest hook sequence and the state the rule derives. */
interface Observation {
  readonly hookSeq: number;
  readonly state: ChildState;
}

const NOTHING_OBSERVED: Observation = { hookSeq: -1, state: "unknown" };

const failure = (reason: string, landed?: boolean): CliRefusal => (landed === undefined ? { reason } : { reason, landed });
const described = (error: MachineError): string => (error instanceof Error ? error.message : String(error));
const machineFailure = (operation: string) => (error: MachineError): CliRefusal => failure(`${operation}: ${described(error)}`);
const shellQuoted = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const normalizedRoot = (path: string): string => posix.normalize(path).replace(/\/+$/, "") || "/";
const withinRoot = (root: string, path: string): boolean => path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

/** The launch as one shell line: `exec` so the pane's lifetime is the child's. */
export function launchLine(launch: Launch): string {
  const env = Object.entries(launch.env).map(([name, value]) => `${name}=${shellQuoted(value)}`);
  const words = [...(env.length === 0 ? [] : ["env", ...env]), ...launch.argv.map(shellQuoted)];
  return `exec ${words.join(" ")}\n`;
}

/** The reference a derived diagnostic carries: the spool location with no bytes observed. */
function emptySpoolRef(spool: Location): TranscriptRef {
  return {
    ...spool,
    generation: { kind: "size-and-prefix-hash", size: 0, prefixSha256: sourceDigest("") },
    range: { offsetBytes: 0, lengthBytes: 0 },
  };
}

/**
 * New observation since `before`: a hook receipt with a greater sequence, or
 * the derived state leaving `unknown`. One more source-free fact is not the
 * measure — the vendor's start, submit and stop events share one `observed`
 * fact per turn, so a text-only answer never grows the fact count.
 */
function advanced(before: Observation, now: Observation): boolean {
  return now.hookSeq > before.hookSeq || (before.state === "unknown" && now.state !== "unknown");
}

export function createCliRunner(deps: CliRunnerDeps): CliRunner {
  const panes = new Map<string, Pane>();
  const children = new Map<string, string>();
  /** The latest turn per child, kept past the pane's retirement so a late deadline is refused as ended, not unknown — the one turn per child this runner retains (r2 L9). */
  const latest = new Map<string, Turn>();
  /** The retained turns the run owns, by the send's key: a replay joins or reads one instead of typing again; a key `openTurn` replaced leaves here. */
  const turns = new Map<string, Turn>();
  /** The sender sessions' read positions and retained-turn summaries, paged forward from the last seen revision on every notification. */
  const cursors = new Map<string, Cursor>();

  const machine = (contact: CliContact): Effect.Effect<MachineHandle, CliRefusal> =>
    Effect.try({
      try: () => deps.host.get(contact.machine),
      catch: (error) => failure(`machine ${contact.machine}: ${error instanceof Error ? error.message : String(error)}`),
    });

  const place = (contact: CliContact): Effect.Effect<LeaseHandle, CliRefusal> =>
    Effect.try({
      try: () => deps.host.place({ machineId: contact.machine }, "pty"),
      catch: (error) => failure(`machine ${contact.machine}: ${error instanceof Error ? error.message : String(error)}`),
    }).pipe(
      Effect.flatMap((outcome) => {
        switch (outcome.kind) {
          case "placed":
            return Effect.succeed(outcome.lease);
          case "no_member":
            return Effect.fail(failure(`machine ${contact.machine} is not attached`));
          case "all_stale":
            return Effect.fail(failure(`machine ${contact.machine} is stale`));
          default:
            return Effect.fail(failure(`machine_saturated: ${outcome.machineId} (${outcome.reason})`));
        }
      }),
    );

  const sessionLive = (handle: MachineHandle, name: string): Effect.Effect<boolean, CliRefusal> =>
    handle.pty.list().pipe(
      Effect.mapError(machineFailure("pty.list")),
      Effect.flatMap((listed) =>
        listed.status === "ok"
          ? Effect.succeed(listed.sessions.some((session) => session.name === name && session.status === "live"))
          : Effect.fail(failure(`pty.list refused: ${listed.reason}`)),
      ),
    );

  const write = (pane: Pane, handle: MachineHandle, bytes: string): Effect.Effect<void, CliRefusal> =>
    pane.lease
      .renewPtyWhile(handle.pty.write(pane.contact.session, Buffer.from(bytes, "utf8")), { name: pane.contact.session, op: "use" })
      .pipe(
        Effect.mapError(machineFailure("pty.write")),
        Effect.flatMap((written) =>
          written.status === "ok" ? Effect.void : Effect.fail(failure(`pty.write refused: ${written.reason}`)),
        ),
      );

  /** The summary a fact row lands in: the child's retained turn, started on its first row; a row of any other turn has none. */
  const summaryFor = (cursor: Cursor, child: string, turn: string): TurnSummary | undefined => {
    if (latest.get(child)?.id !== turn) return undefined;
    const current = cursor.children.get(child);
    if (current?.turn === turn) return current;
    const started: TurnSummary = { turn, facts: new Map(), state: NOTHING_SPOKEN };
    cursor.children.set(child, started);
    return started;
  };

  /** One page of rows folded into the retained summaries: facts by key, receipts into the rule's fold through their fact. */
  const fold = (cursor: Cursor, rows: readonly ChildRow[]): void => {
    for (const row of rows) {
      if (row.kind === "child_fact") {
        summaryFor(cursor, row.content.child, row.content.turn)?.facts.set(row.key, row.content);
      } else if (row.kind === "child_receipt") {
        for (const summary of cursor.children.values()) {
          const fact = summary.facts.get(row.content.factKey);
          if (fact === undefined) continue;
          summary.state = foldState(summary.state, { phase: fact.phase, ref: row.content.ref });
          break;
        }
      }
    }
  };

  /** The session's cursor after the page since the last seen revision: the whole history is read once, then only the tail. */
  const sync = (sessionId: string): Cursor => {
    const cursor = cursors.get(sessionId) ?? { revision: 0, children: new Map() };
    cursors.set(sessionId, cursor);
    const page = deps.watch.rows(sessionId, cursor.revision);
    fold(cursor, page.rows);
    cursor.revision = page.revision;
    return cursor;
  };

  const summaryOf = (pane: Pane, turn: Turn): TurnSummary | undefined => {
    const summary = sync(turn.sessionId).children.get(pane.child);
    return summary?.turn === turn.id ? summary : undefined;
  };

  const facts = (pane: Pane, turn: Turn): Fact[] => [...(summaryOf(pane, turn)?.facts.values() ?? [])];

  const observe = (pane: Pane, turn: Turn): Observation => {
    const state = summaryOf(pane, turn)?.state ?? NOTHING_SPOKEN;
    return { hookSeq: state.hook?.seq ?? NOTHING_OBSERVED.hookSeq, state: childState(stateInputOf(state)) };
  };

  /** Event-driven: resolves on the committed-action notification that satisfies the predicate, on an interrupt, or at the bound. */
  const awaitTurn = (
    turn: Turn,
    satisfied: () => boolean,
    boundMs?: number,
  ): Effect.Effect<"observed" | "interrupted" | "stalled", CliRefusal> => {
    const waiting = Effect.callback<"observed" | "interrupted", CliRefusal>((resume) => {
      const check = () => {
        if (turn.interrupted) resume(Effect.succeed("interrupted" as const));
        else if (satisfied()) resume(Effect.succeed("observed" as const));
      };
      const unsubscribe = deps.committed(turn.sessionId, check);
      if (unsubscribe === undefined) {
        resume(Effect.fail(failure("the observation bus offers no subscription; a cli turn cannot be awaited")));
        return;
      }
      turn.wake.add(check);
      check();
      return Effect.sync(() => {
        unsubscribe();
        turn.wake.delete(check);
      });
    });
    if (boundMs === undefined) return waiting;
    return waiting.pipe(
      Effect.timeoutOption(boundMs),
      Effect.map((outcome) => (outcome._tag === "None" ? ("stalled" as const) : outcome.value)),
    );
  };

  /** A replay of a running turn's key joins its one resolution: never a second letter. */
  const joinTurn = (turn: Turn): Effect.Effect<CliTurn, CliRefusal> =>
    Effect.callback<CliTurn, CliRefusal>((resume) => {
      const check = () => {
        const settled = turn.settled;
        if (settled === undefined) return;
        resume(settled.kind === "turn" ? Effect.succeed(settled.turn) : Effect.fail(settled.refusal));
      };
      turn.wake.add(check);
      check();
      return Effect.sync(() => void turn.wake.delete(check));
    });

  /** The first outcome wins: the run records it the moment it is known (r2 L8), and `settling` only backstops the refusals raised before that. */
  const settle = (turn: Turn, settled: Settled): void => {
    if (turn.settled !== undefined) return;
    turn.settled = settled;
    for (const wake of turn.wake) wake();
  };

  /** The turn's one resolution — recorded for replays and the deadline door — then propagated unchanged. */
  const settling = (turn: Turn, body: Effect.Effect<CliTurn, CliRefusal>): Effect.Effect<CliTurn, CliRefusal> =>
    body.pipe(
      Effect.tap((outcome) => Effect.sync(() => settle(turn, { kind: "turn", turn: outcome }))),
      Effect.tapError((refusal) => Effect.sync(() => settle(turn, { kind: "refused", refusal }))),
    );

  /** The deadline is retired once the turn has ended — after the turn is marked ended (r2 L8); like the arm, a refused retire never fails the send. */
  const disarm = (turn: Turn): Effect.Effect<void> => {
    const armed = turn.deadline;
    return armed === undefined
      ? Effect.void
      : armed.retire.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              turn.deadline = undefined;
            }),
          ),
          Effect.catch(() => Effect.void),
        );
  };

  /**
   * A stalled prompt or launch: the diagnostic goes through the reconciler's
   * door, then the pane is retired — its state is unknown, so this Resident
   * neither writes to it again nor keeps it; the next send launches afresh.
   */
  const stalled = (pane: Pane, turn: Turn, code: "prompt_stalled" | "launch_stalled", windowMs: number): Effect.Effect<never, CliRefusal> => {
    const reason = `${code}: no live observation within ${windowMs} ms`;
    const row = diagnosticRow({ child: pane.child, turn: turn.id }, { ref: emptySpoolRef(pane.spool), diagnostic: { code, detail: reason } });
    const refusal = failure(reason);
    return deps.watch.admit(turn.sessionId, [row]).pipe(
      Effect.mapError((refused) => failure(`${reason}; the diagnostic was refused: ${refused.reason}`)),
      Effect.flatMap(() => ended(pane, turn, { kind: "refused", refusal })),
      Effect.flatMap(() => Effect.fail(refusal)),
    );
  };

  /**
   * The turn's end, in this order (r2 L8/L10): the outcome is recorded before
   * any await, so the deadline door refuses `turn_already_ended` from here
   * on; then the arm is retired; then, when the pane cannot be accounted for
   * (`retirePane`), it is dropped — its close refusal never replaces the
   * outcome the turn already has.
   */
  const ended = (pane: Pane, turn: Turn, settled: Settled, retirePane = true): Effect.Effect<void> =>
    Effect.sync(() => settle(turn, settled)).pipe(
      Effect.flatMap(() => disarm(turn)),
      Effect.flatMap(() => (retirePane ? retire(pane, true).pipe(Effect.ignore) : Effect.void)),
    );

  /** One watch per turn: the previous turn's watch closes first; checkpoints resume from persisted receipts. The turn it replaces leaves the replay registry (r2 L9). */
  const openTurn = (pane: Pane, input: CliRunInput): Effect.Effect<Turn, CliRefusal> =>
    Effect.gen(function* () {
      if (pane.turn !== undefined) {
        yield* deps.watch.close(pane.turn.watch);
        if (pane.turn.id !== input.key) turns.delete(pane.turn.id);
      }
      const watch = `cli:${pane.child}:${input.key}`;
      yield* deps.watch.install({
        id: watch,
        sessionId: input.sender,
        child: pane.child,
        turn: input.key,
        occupant: { command: pane.contact.pack.manifest.commands[0] ?? pane.contact.pack.manifest.id },
        spool: pane.spool,
        ...(pane.transcript === undefined ? {} : { transcript: pane.transcript }),
      });
      // The same key re-installs the watch (the transcript was located) without a second turn.
      const turn: Turn = pane.turn?.id === input.key ? pane.turn : { id: input.key, sessionId: input.sender, watch, interrupted: false, wake: new Set() };
      pane.turn = turn;
      latest.set(pane.child, turn);
      return turn;
    });

  const locateTranscript = (pane: Pane, handle: MachineHandle): Effect.Effect<string | undefined, CliRefusal> =>
    handle.fs.read(pane.spool.path, { offset: 0, limit: 64 * 1024 }).pipe(
      Effect.mapError(machineFailure("fs.read")),
      Effect.map((read) => {
        for (const line of Buffer.from(read.data).toString("utf8").split("\n")) {
          const located = pane.contact.pack.locate?.(line);
          if (located?.transcriptPath !== undefined) return located.transcriptPath;
        }
        return undefined;
      }),
    );

  /** The export the declared cwd lives in: the longest offered root containing it; none is a typed refusal before any pane opens. */
  const exportOf = (contact: CliContact): Effect.Effect<string, CliRefusal> =>
    Effect.try({
      try: () => deps.host.exports(contact.machine),
      catch: (error) => failure(`machine ${contact.machine}: ${error instanceof Error ? error.message : String(error)}`),
    }).pipe(
      Effect.flatMap((exports) => {
        const cwd = normalizedRoot(contact.cwd);
        const root = exports.filter((entry) => withinRoot(entry.path, cwd)).sort((a, b) => b.path.length - a.path.length)[0];
        if (root !== undefined) return Effect.succeed(root.name);
        const offered = exports.map((entry) => `${entry.name}=${entry.path}`).join(", ") || "none";
        return Effect.fail(failure(`cwd ${contact.cwd} is outside every export machine ${contact.machine} offers (${offered})`));
      }),
    );

  /** The live config on the machine: the hook script, and the pack's wiring of it. */
  const installLiveConfig = (pane: Pane, handle: MachineHandle, dir: string, configPath: string) =>
    Effect.gen(function* () {
      const made = yield* pane.lease
        .renewWhile(handle.exec(`mkdir -p ${shellQuoted(dir)}`, pane.contact.cwd), "exec")
        .pipe(Effect.mapError(machineFailure("exec")));
      if (made.status !== "completed" || made.exitCode !== 0)
        return yield* Effect.fail(failure(`live config directory ${dir}: ${made.status === "completed" ? `exit ${made.exitCode}` : made.status}`));
      const scriptPath = posix.join(dir, "hook.sh");
      yield* handle.fs.write(scriptPath, Buffer.from(hookScript(pane.spool.path))).pipe(Effect.mapError(machineFailure("fs.write")));
      const config = pane.contact.pack.liveConfig?.({ hookCommand: hookCommand(scriptPath) });
      if (config !== undefined) yield* handle.fs.write(configPath, Buffer.from(config)).pipe(Effect.mapError(machineFailure("fs.write")));
      return config !== undefined;
    });

  /** Once the pane is open, any refusal before the run owns it retires it: no live bare shell stays registered with its lease held. */
  const rollback = <A>(pane: Pane, effect: Effect.Effect<A, CliRefusal>): Effect.Effect<A, CliRefusal> =>
    effect.pipe(Effect.tapError(() => (panes.get(pane.contact.id) === pane ? retire(pane, true).pipe(Effect.ignore) : Effect.void)));

  const launch = (contact: CliContact, handle: MachineHandle, input: CliRunInput, stallWindowMs: number): Effect.Effect<Pane, CliRefusal> =>
    Effect.gen(function* () {
      const lease = yield* place(contact);
      const exportName = yield* exportOf(contact).pipe(Effect.tapError(() => Effect.sync(() => lease.release())));
      const child = deps.id();
      const dir = posix.join(contact.cwd, ".openomni", child);
      const pane: Pane = {
        contact,
        child,
        lease,
        spool: { machine: contact.machine, export: exportName, path: posix.join(dir, "spool.jsonl"), parser: { dialect: "hook-spool", version: "1" } },
      };
      const opened = yield* lease
        .renewPtyWhile(handle.pty.open(contact.session, contact.cwd), { name: contact.session, op: "open" })
        .pipe(Effect.mapError(machineFailure("pty.open")));
      if (opened.status !== "ok") {
        lease.release();
        return yield* Effect.fail(failure(`pty.open refused: ${opened.reason}`));
      }
      panes.set(contact.id, pane);
      children.set(child, contact.id);
      return yield* rollback(pane, Effect.gen(function* () {
        const configPath = posix.join(dir, "live.json");
        const configured = yield* installLiveConfig(pane, handle, dir, configPath);
        const launched = contact.pack.launch?.({ sessionId: child, ...(configured ? { liveConfigPath: configPath } : {}) });
        if (launched === undefined)
          return yield* Effect.fail(failure(`dialect ${contact.pack.manifest.id} declares no correlated launch; attaching to a running child is not in this increment`));
        const turn = yield* openTurn(pane, input);
        yield* write(pane, handle, launchLine(launched));
        const started = yield* awaitTurn(turn, () => advanced(NOTHING_OBSERVED, observe(pane, turn)), stallWindowMs);
        if (started !== "observed") return yield* stalled(pane, turn, "launch_stalled", stallWindowMs);
        const transcriptPath = yield* locateTranscript(pane, handle);
        if (transcriptPath !== undefined) {
          pane.transcript = { ...pane.spool, path: transcriptPath, parser: { dialect: contact.pack.manifest.id, version: "1" } };
          yield* openTurn(pane, input);
        }
        return pane;
      }));
    });

  const retire = (pane: Pane, live: boolean): Effect.Effect<void, CliRefusal> =>
    Effect.gen(function* () {
      panes.delete(pane.contact.id);
      children.delete(pane.child);
      if (pane.turn !== undefined) yield* deps.watch.close(pane.turn.watch);
      const closeSession = live
        ? machine(pane.contact).pipe(Effect.flatMap((handle) => handle.pty.close(pane.contact.session).pipe(Effect.mapError(machineFailure("pty.close")))))
        : Effect.void;
      // The lease goes back whatever the daemon says about the session.
      yield* closeSession.pipe(Effect.ensuring(Effect.sync(() => pane.lease.release())));
    });

  /** Lookup-or-create: the pane this runner launched is reused while its tmux session lives; an occupant it did not launch is never written to. */
  const ensurePane = (contact: CliContact, handle: MachineHandle, input: CliRunInput, stallWindowMs: number): Effect.Effect<Pane, CliRefusal> =>
    Effect.gen(function* () {
      const existing = panes.get(contact.id);
      const live = yield* sessionLive(handle, contact.session);
      if (existing !== undefined && live) {
        if (existing.lease.signal.aborted) existing.lease = yield* place(contact);
        return existing;
      }
      if (existing !== undefined) yield* retire(existing, false);
      else if (live)
        return yield* Effect.fail(
          failure(`pane ${contact.session} on ${contact.machine} has an occupant this Resident did not launch; attaching by observation is not in this increment`),
        );
      return yield* launch(contact, handle, input, stallWindowMs);
    });

  /** The data rule over the previous turn: blocked refuses, a running turn refuses, unknown fails closed; an interrupt of ours is idle. */
  const gate = (pane: Pane, input: CliRunInput, recipe: SubmitRecipe): Effect.Effect<void, CliRefusal> => {
    const previous = pane.turn;
    if (previous === undefined || previous.id === input.key || previous.interrupted) return Effect.void;
    const state = observe(pane, previous).state;
    if (state === "idle" || (state === "blocked" && !recipe.refuseWhenWaiting)) return Effect.void;
    if (state === "blocked") return Effect.fail(failure("agent_blocked: the child is waiting on a permission request"));
    if (state === "working") return Effect.fail(failure("agent_busy: the child's previous turn has not ended"));
    return Effect.fail(failure("child_state_unknown: the child's previous turn left no observation"));
  };

  /** The recipe's writes in order; a refusal after the first write that reached the pane carries `landed` — the letter is never re-sent. */
  const submit = (pane: Pane, handle: MachineHandle, recipe: SubmitRecipe): Effect.Effect<void, CliRefusal> =>
    Effect.gen(function* () {
      let landed = false;
      for (const step of recipe.writes) {
        if (step.kind === "enter") yield* Effect.sleep(Duration.millis(recipe.enterDelayMs));
        yield* write(pane, handle, step.kind === "enter" ? "\r" : step.value).pipe(
          Effect.mapError((refusal) => (landed ? { ...refusal, landed: true } : refusal)),
        );
        landed = true;
      }
    });

  const armDeadline = (pane: Pane, input: CliRunInput): Effect.Effect<CliDeadlineArm | undefined> => {
    if (input.deadlineMs === undefined || deps.deadline === undefined) return Effect.succeed(undefined);
    // A failed arm never fails the send (the #1258 rule): the letter still goes; the deadline is best-effort policy.
    return deps
      .deadline({ sessionId: input.sender, turnId: input.turnId, child: pane.child, contact: `cli:${pane.contact.id}`, at: deps.now() + input.deadlineMs })
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
  };

  const interrupted = failure("deadline expired; the child was interrupted", true);

  /**
   * The turn from the letter to its end: deadline armed, letter submitted,
   * stall measured on new observation, terminal awaited. A letter the daemon
   * refused (r2 L10) ends the turn and retires the pane like a stall does —
   * whatever did or did not reach it, this Resident cannot account for the
   * pane, so the next send launches afresh instead of answering `agent_busy`.
   */
  const drive = (pane: Pane, handle: MachineHandle, turn: Turn, input: CliRunInput, recipe: SubmitRecipe): Effect.Effect<CliTurn, CliRefusal> =>
    Effect.gen(function* () {
      turn.deadline = yield* armDeadline(pane, input);
      const before = observe(pane, turn);
      yield* submit(pane, handle, recipe).pipe(Effect.tapError((refusal) => ended(pane, turn, { kind: "refused", refusal })));
      const started = yield* awaitTurn(turn, () => advanced(before, observe(pane, turn)), recipe.stallWindowMs);
      if (started === "stalled") return yield* stalled(pane, turn, "prompt_stalled", recipe.stallWindowMs);
      if (started === "interrupted") return yield* Effect.fail(interrupted);
      const outcome = yield* awaitTurn(turn, () => facts(pane, turn).some((fact) => fact.phase === "terminal"));
      if (outcome === "interrupted") return yield* Effect.fail(interrupted);
      const turnEnded: CliTurn = { child: pane.child, turn: turn.id, facts: facts(pane, turn).length };
      // r2 L8: ended before the disarm's await — a fire landing in that window is refused, never written to an idle child.
      yield* ended(pane, turn, { kind: "turn", turn: turnEnded }, false);
      return turnEnded;
    });

  return {
    run: (input) =>
      Effect.gen(function* () {
        const resolved = resolveCliContact(input.agent, deps);
        if ("reason" in resolved) return yield* Effect.fail(failure(resolved.reason));
        // A replayed tool call: the key's turn is running or ended, and its one outcome is the answer — the letter is never re-typed.
        const replay = turns.get(input.key);
        if (replay !== undefined) return yield* joinTurn(replay);
        const handle = yield* machine(resolved);
        const recipe = resolved.pack.submit(input.message);
        const pane = yield* ensurePane(resolved, handle, input, recipe.stallWindowMs);
        yield* gate(pane, input, recipe);
        const turn = pane.turn?.id === input.key ? pane.turn : yield* openTurn(pane, input);
        turns.set(input.key, turn);
        return yield* settling(turn, drive(pane, handle, turn, input, recipe));
      }),
    interrupt: (child) =>
      Effect.gen(function* () {
        const contactId = children.get(child);
        const pane = contactId === undefined ? undefined : panes.get(contactId);
        const turn = pane?.turn ?? latest.get(child);
        if (turn?.settled !== undefined)
          return yield* Effect.fail({ reason: `turn_already_ended: cli child ${child} has no running turn to interrupt`, code: "turn_already_ended" as const });
        if (pane === undefined || pane.child !== child || turn === undefined) return yield* Effect.fail(failure(`no cli child ${child} is running`));
        const handle = yield* machine(pane.contact);
        yield* write(pane, handle, "\u0003");
        turn.interrupted = true;
        for (const wake of turn.wake) wake();
      }),
    close: () =>
      Effect.forEach([...panes.values()], (pane) => retire(pane, true).pipe(Effect.catch(() => Effect.void)), { discard: true }),
    retained: () => latest.size,
  };
}
