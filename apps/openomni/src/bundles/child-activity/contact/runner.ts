import { posix } from "node:path";
import type { LeaseHandle, MachineError, MachineHandle, MachineHost } from "@openomni/machines";
import type { TranscriptRef } from "@openomni/protocol";
import { Duration, Effect } from "effect";
import type { Launch, SubmitRecipe } from "../dialects/pack";
import type { ChildWatch } from "../index";
import { type ChildRow, diagnosticRow, stateReceipts } from "../reconcile";
import { sourceDigest } from "../transcript";
import { type CliContact, type CliContactResolution, resolveCliContact } from "./declaration";
import { hookCommand, hookScript } from "./hook-script";
import { childState, stateInput } from "./rule";

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

/** A refusal; `landed` means bytes reached the pane, so the letter is never re-sent. */
interface CliRefusal {
  readonly reason: string;
  readonly landed?: boolean;
}

/** The reconciler surface the runner consumes (`childActivity` in the composition). */
interface CliWatchPorts {
  install(spec: ChildWatch): Effect.Effect<void, CliRefusal>;
  close(id: string): Effect.Effect<void>;
  rows(sessionId: string): readonly ChildRow[];
  /** The reconciler's one admission door, for the rows this contact derives. */
  admit(sessionId: string, rows: readonly ChildRow[]): Effect.Effect<void, CliRefusal>;
}

export interface CliRunnerDeps extends CliContactResolution {
  readonly host: Pick<MachineHost, "place" | "get" | "list">;
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
  }) => Effect.Effect<void, CliRefusal>;
  readonly id: () => string;
  readonly now: () => number;
}

export interface CliRunner {
  run(input: CliRunInput): Effect.Effect<CliTurn, CliRefusal>;
  /** The deadline door: ETX to the child's pane; the waiting send ends `landed`. */
  interrupt(child: string): Effect.Effect<void, CliRefusal>;
  /** Drops every pane this runner launched: watch, tmux session, lease. */
  close(): Effect.Effect<void>;
}

type Location = NonNullable<ChildWatch["spool"]>;
type Fact = Extract<ChildRow, { kind: "child_fact" }>;

interface Turn {
  readonly id: string;
  readonly sessionId: string;
  readonly watch: string;
  interrupted: boolean;
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

const failure = (reason: string, landed?: boolean): CliRefusal => (landed === undefined ? { reason } : { reason, landed });
const described = (error: MachineError): string => (error instanceof Error ? error.message : String(error));
const machineFailure = (operation: string) => (error: MachineError): CliRefusal => failure(`${operation}: ${described(error)}`);
const shellQuoted = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

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

export function createCliRunner(deps: CliRunnerDeps): CliRunner {
  const panes = new Map<string, Pane>();
  const children = new Map<string, string>();

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

  const factRows = (pane: Pane, turn: Turn): Fact[] =>
    deps.watch
      .rows(turn.sessionId)
      .filter((row): row is Fact => row.kind === "child_fact" && row.content.child === pane.child && row.content.turn === turn.id);

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

  /**
   * A stalled prompt or launch: the diagnostic goes through the reconciler's
   * door, then the pane is retired — its state is unknown, so this Resident
   * neither writes to it again nor keeps it; the next send launches afresh.
   */
  const stalled = (pane: Pane, turn: Turn, code: "prompt_stalled" | "launch_stalled", windowMs: number): Effect.Effect<never, CliRefusal> => {
    const reason = `${code}: no live observation within ${windowMs} ms`;
    const row = diagnosticRow({ child: pane.child, turn: turn.id }, { ref: emptySpoolRef(pane.spool), diagnostic: { code, detail: reason } });
    return deps.watch.admit(turn.sessionId, [row]).pipe(
      Effect.mapError((refused) => failure(`${reason}; the diagnostic was refused: ${refused.reason}`)),
      Effect.flatMap(() => retire(pane, true)),
      Effect.flatMap(() => Effect.fail(failure(reason))),
    );
  };

  /** One watch per turn: the previous turn's watch closes first; checkpoints resume from persisted receipts. */
  const openTurn = (pane: Pane, input: CliRunInput): Effect.Effect<Turn, CliRefusal> =>
    Effect.gen(function* () {
      if (pane.turn !== undefined) yield* deps.watch.close(pane.turn.watch);
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
      const turn: Turn = { id: input.key, sessionId: input.sender, watch, interrupted: false, wake: new Set() };
      pane.turn = turn;
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

  const exportOf = (contact: CliContact): string => {
    const info = deps.host.list().find((entry) => entry.machineId === contact.machine);
    const exports = info?.allowedExports ?? [];
    return exports.length === 1 ? (exports[0] ?? "declared") : "declared";
  };

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

  const launch = (contact: CliContact, handle: MachineHandle, input: CliRunInput, stallWindowMs: number): Effect.Effect<Pane, CliRefusal> =>
    Effect.gen(function* () {
      const lease = yield* place(contact);
      const child = deps.id();
      const dir = posix.join(contact.cwd, ".openomni", child);
      const pane: Pane = {
        contact,
        child,
        lease,
        spool: { machine: contact.machine, export: exportOf(contact), path: posix.join(dir, "spool.jsonl"), parser: { dialect: "hook-spool", version: "1" } },
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
      const configPath = posix.join(dir, "live.json");
      const configured = yield* installLiveConfig(pane, handle, dir, configPath);
      const launched = contact.pack.launch?.({ sessionId: child, ...(configured ? { liveConfigPath: configPath } : {}) });
      if (launched === undefined)
        return yield* Effect.fail(failure(`dialect ${contact.pack.manifest.id} declares no correlated launch; attaching to a running child is not in this increment`));
      const turn = yield* openTurn(pane, input);
      yield* write(pane, handle, launchLine(launched));
      const started = yield* awaitTurn(turn, () => factRows(pane, turn).length > 0, stallWindowMs);
      if (started !== "observed") return yield* stalled(pane, turn, "launch_stalled", stallWindowMs);
      const transcriptPath = yield* locateTranscript(pane, handle);
      if (transcriptPath !== undefined) {
        pane.transcript = { ...pane.spool, path: transcriptPath, parser: { dialect: contact.pack.manifest.id, version: "1" } };
        yield* openTurn(pane, input);
      }
      return pane;
    });

  const retire = (pane: Pane, live: boolean): Effect.Effect<void, CliRefusal> =>
    Effect.gen(function* () {
      panes.delete(pane.contact.id);
      children.delete(pane.child);
      if (pane.turn !== undefined) yield* deps.watch.close(pane.turn.watch);
      if (live) {
        const handle = yield* machine(pane.contact);
        yield* handle.pty.close(pane.contact.session).pipe(Effect.mapError(machineFailure("pty.close")));
      }
      pane.lease.release();
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
    const state = childState(stateInput(stateReceipts(deps.watch.rows(previous.sessionId), pane.child, previous.id)));
    if (state === "idle" || (state === "blocked" && !recipe.refuseWhenWaiting)) return Effect.void;
    if (state === "blocked") return Effect.fail(failure("agent_blocked: the child is waiting on a permission request"));
    if (state === "working") return Effect.fail(failure("agent_busy: the child's previous turn has not ended"));
    return Effect.fail(failure("child_state_unknown: the child's previous turn left no observation"));
  };

  const submit = (pane: Pane, handle: MachineHandle, recipe: SubmitRecipe): Effect.Effect<void, CliRefusal> =>
    Effect.gen(function* () {
      for (const step of recipe.writes) {
        if (step.kind === "enter") {
          yield* Effect.sleep(Duration.millis(recipe.enterDelayMs));
          yield* write(pane, handle, "\r");
        } else {
          yield* write(pane, handle, step.value);
        }
      }
    });

  const armDeadline = (pane: Pane, input: CliRunInput): Effect.Effect<void> => {
    if (input.deadlineMs === undefined || deps.deadline === undefined) return Effect.void;
    // A failed arm never fails the send (the #1258 rule): the letter still goes; the deadline is best-effort policy.
    return deps
      .deadline({ sessionId: input.sender, turnId: input.turnId, child: pane.child, contact: `cli:${pane.contact.id}`, at: deps.now() + input.deadlineMs })
      .pipe(Effect.catch(() => Effect.void));
  };

  const interrupted = failure("deadline expired; the child was interrupted", true);

  return {
    run: (input) =>
      Effect.gen(function* () {
        const resolved = resolveCliContact(input.agent, deps);
        if ("reason" in resolved) return yield* Effect.fail(failure(resolved.reason));
        const handle = yield* machine(resolved);
        const recipe = resolved.pack.submit(input.message);
        const pane = yield* ensurePane(resolved, handle, input, recipe.stallWindowMs);
        yield* gate(pane, input, recipe);
        const turn = pane.turn?.id === input.key ? pane.turn : yield* openTurn(pane, input);
        yield* armDeadline(pane, input);
        const before = factRows(pane, turn).length;
        yield* submit(pane, handle, recipe);
        const started = yield* awaitTurn(turn, () => factRows(pane, turn).length > before, recipe.stallWindowMs);
        if (started === "stalled") return yield* stalled(pane, turn, "prompt_stalled", recipe.stallWindowMs);
        if (started === "interrupted") return yield* Effect.fail(interrupted);
        const ended = yield* awaitTurn(turn, () => factRows(pane, turn).some((row) => row.content.phase === "terminal"));
        if (ended === "interrupted") return yield* Effect.fail(interrupted);
        return { child: pane.child, turn: turn.id, facts: factRows(pane, turn).length };
      }),
    interrupt: (child) =>
      Effect.gen(function* () {
        const contactId = children.get(child);
        const pane = contactId === undefined ? undefined : panes.get(contactId);
        if (pane === undefined || pane.child !== child) return yield* Effect.fail(failure(`no cli child ${child} is running`));
        const handle = yield* machine(pane.contact);
        yield* write(pane, handle, "\u0003");
        const turn = pane.turn;
        if (turn === undefined) return;
        turn.interrupted = true;
        for (const wake of turn.wake) wake();
      }),
    close: () =>
      Effect.forEach([...panes.values()], (pane) => retire(pane, true).pipe(Effect.catch(() => Effect.void)), { discard: true }),
  };
}
