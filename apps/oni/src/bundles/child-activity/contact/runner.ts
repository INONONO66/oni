import type { ChannelInstanceStore } from "@oni/channels";
import type { MachineError, MachineHandle } from "@oni/machines";
import { L0Observation, type ObservationSink } from "@oni/protocol";
import { Effect } from "effect";
import type { ChildWatch } from "../index";
import { type ChildRow, contactCursor } from "../reconcile";
import { type CliContact, resolveCliContact } from "./declaration";

interface CliRunInput {
  readonly agent: string;
  readonly message: string;
  readonly sender: string;
  readonly turnId: string;
  readonly key: string;
  readonly deadlineMs?: number;
}

interface CliTurn {
  readonly child: string;
  readonly turn: string;
  readonly facts: number;
}

interface CliRefusal {
  readonly reason: string;
  readonly landed?: boolean;
  readonly code?: "turn_already_ended";
}

interface CliWatchPorts {
  install(spec: ChildWatch): Effect.Effect<void, CliRefusal>;
  close(id: string): Effect.Effect<void>;
  rows(sessionId: string, afterRevision: number): { readonly rows: readonly ChildRow[]; readonly revision: number };
}

interface DeadlineArm {
  readonly retire: Effect.Effect<void, CliRefusal>;
}

export interface CliRunnerDeps {
  readonly instances: Pick<ChannelInstanceStore, "get">;
  readonly machineKnown: (machineId: string) => boolean;
  readonly host: { get(machineId: string): Pick<MachineHandle, "agentSession"> };
  readonly watch: CliWatchPorts;
  readonly committed: (sessionId: string, listener: () => void) => (() => void) | undefined;
  readonly deadline?: (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly child: string;
    readonly contact: string;
    readonly at: number;
  }) => Effect.Effect<DeadlineArm, CliRefusal>;
  readonly now: () => number;
}

export interface CliRunner {
  run(input: CliRunInput): Effect.Effect<CliTurn, CliRefusal>;
  interrupt(child: string): Effect.Effect<void, CliRefusal>;
  close(): Effect.Effect<void>;
}

/** The runner's `committed` port over an observation sink: one listener per sender session's committed actions. */
export function committedOn(observations: Pick<ObservationSink, "subscribe">): CliRunnerDeps["committed"] {
  return (sessionId, listener) =>
    observations.subscribe?.(L0Observation.ActionCommittedEvent, () => listener(), { match: { sessionId } });
}

interface Active {
  readonly contact: CliContact;
  readonly child: string;
  readonly sender: string;
  readonly key: string;
  readonly watchId: string;
  deadline?: DeadlineArm;
  interrupted: boolean;
  ended: boolean;
  /** Re-checks the pending turn; set while a wait is parked, since the bus only wakes it on a commit. */
  wake?: () => void;
}

const refused = (reason: string, landed?: boolean): CliRefusal =>
  landed === undefined ? { reason } : { reason, landed };

const machineFailure = (operation: string) => (error: MachineError): CliRefusal =>
  refused(`${operation}: ${error instanceof Error ? error.message : String(error)}`);

function accepted<T extends { readonly status: "ok" } | { readonly status: "refused"; readonly reason: string }>(
  result: T,
  operation: string,
): Effect.Effect<Extract<T, { readonly status: "ok" }>, CliRefusal> {
  if (result.status === "refused") return Effect.fail(refused(`${operation} refused: ${result.reason}`));
  return Effect.succeed(result as Extract<T, { readonly status: "ok" }>);
}

export function createCliRunner(deps: CliRunnerDeps): CliRunner {
  const active = new Map<string, Active>();
  const byChild = new Map<string, Active>();
  const completed = new Map<string, CliTurn>();
  const ended = new Set<string>();

  function handle(contact: CliContact): Effect.Effect<NonNullable<MachineHandle["agentSession"]>, CliRefusal> {
    return Effect.try({
      try: () => deps.host.get(contact.machine).agentSession,
      catch: (error) => refused(`machine ${contact.machine}: ${String(error)}`),
    }).pipe(
      Effect.flatMap((session) =>
        session === undefined
          ? Effect.fail(refused(`machine ${contact.machine} does not support agent sessions`))
          : Effect.succeed(session),
      ),
    );
  }

  function stop(child: Active) {
    return Effect.gen(function* () {
      const session = yield* handle(child.contact);
      yield* session.stop({ sessionId: child.child }).pipe(
        Effect.mapError(machineFailure("agent.stop")),
        Effect.flatMap((result) => accepted(result, "agent.stop")),
      );
      yield* deps.watch.close(child.watchId);
      active.delete(child.contact.id);
      byChild.delete(child.child);
    });
  }

  function wake(child: Active): Effect.Effect<CliTurn, CliRefusal> {
    return Effect.callback<CliTurn, CliRefusal>((resume) => {
      let unsubscribe: (() => void) | undefined;
      // The callback cleanup runs only on interrupt, so a settled wait drops its listener itself.
      const settle = (exit: Effect.Effect<CliTurn, CliRefusal>) => {
        child.wake = undefined;
        unsubscribe?.();
        resume(exit);
      };
      const check = () => {
        if (child.interrupted) {
          settle(Effect.fail(refused("deadline expired; the child was interrupted", true)));
          return;
        }
        const rows = deps.watch.rows(child.sender, 0).rows;
        const facts = rows.filter((row): row is Extract<ChildRow, { kind: "child_fact" }> =>
          row.kind === "child_fact" && row.content.child === child.child && row.content.turn === child.key);
        if (facts.some((row) => row.content.phase === "terminal")) {
          child.ended = true;
          ended.add(child.child);
          settle(Effect.succeed({ child: child.child, turn: child.key, facts: facts.length }));
        }
      };
      unsubscribe = deps.committed(child.sender, check);
      if (unsubscribe === undefined) {
        resume(Effect.fail(refused("the observation bus offers no subscription; a cli turn cannot be awaited")));
        return;
      }
      child.wake = check;
      check();
      return Effect.sync(() => {
        child.wake = undefined;
        unsubscribe();
      });
    });
  }

  /** Opens a session for a new contact or re-arms the watch of its ended one; either way the child is watched for this turn. */
  function attach(
    contact: CliContact,
    input: CliRunInput,
    session: NonNullable<MachineHandle["agentSession"]>,
    previous: Active | undefined,
  ): Effect.Effect<Active, CliRefusal> {
    return Effect.gen(function* () {
      const saved = contactCursor(deps.watch.rows(input.sender, 0).rows, contact.id);
      let cursor = saved;
      let childId = previous?.child;
      if (previous === undefined) {
        const opened = yield* session.open({ project: contact.cwd, cli: contact.dialect })
          .pipe(Effect.mapError(machineFailure("agent.open")), Effect.flatMap((result) => accepted(result, "agent.open")));
        childId = opened.cursor.sessionId;
        cursor = saved?.sessionId === childId ? saved : opened.cursor;
      } else {
        yield* deps.watch.close(previous.watchId);
      }
      if (cursor === undefined || childId === undefined)
        return yield* Effect.fail(refused(`cli contact ${contact.id} has no transcript cursor`));
      const child: Active = {
        contact, child: childId, sender: input.sender, key: input.key,
        watchId: `cli:${childId}`, interrupted: false, ended: false,
      };
      active.set(contact.id, child);
      byChild.set(child.child, child);
      yield* deps.watch.install({
        id: child.watchId, sessionId: input.sender, contact: contact.id,
        child: child.child, turn: input.key, machine: contact.machine, cursor,
      });
      return child;
    });
  }

  function armDeadline(running: Active, input: CliRunInput): Effect.Effect<void, CliRefusal> {
    return Effect.gen(function* () {
      if (input.deadlineMs === undefined || deps.deadline === undefined) return;
      running.deadline = yield* deps.deadline({
        sessionId: input.sender, turnId: input.turnId, child: running.child,
        contact: `cli:${running.contact.id}`, at: deps.now() + input.deadlineMs,
      });
    });
  }

  function run(input: CliRunInput): Effect.Effect<CliTurn, CliRefusal> {
    return Effect.gen(function* () {
      const contact = resolveCliContact(input.agent, deps);
      if ("reason" in contact) return yield* Effect.fail(contact);
      const previous = active.get(contact.id);
      if (previous !== undefined && (previous.sender !== input.sender || !previous.ended))
        return yield* Effect.fail(refused(`cli contact ${contact.id} is busy`));
      if (previous?.key === input.key) {
        const replay = completed.get(`${previous.child}:${input.key}`);
        if (replay !== undefined) return replay;
      }
      const session = yield* handle(contact);
      const running = yield* attach(contact, input, session, previous);
      yield* armDeadline(running, input);
      const pending = wake(running);
      yield* session.send({ sessionId: running.child, text: input.message })
        .pipe(Effect.mapError(machineFailure("agent.send")), Effect.flatMap((result) => accepted(result, "agent.send")));
      const result = yield* pending;
      completed.set(`${running.child}:${input.key}`, result);
      if (running.deadline !== undefined) yield* running.deadline.retire.pipe(Effect.catch(() => Effect.void));
      return result;
    });
  }

  return {
    run,
    interrupt: (child) => Effect.gen(function* () {
      const running = byChild.get(child);
      if (running === undefined) return yield* Effect.fail(
        ended.has(child) ? { reason: "the child turn has already ended", code: "turn_already_ended" as const }
          : refused(`no cli child ${child} is running`),
      );
      if (running.ended) return yield* Effect.fail({ reason: "the child turn has already ended", code: "turn_already_ended" as const });
      running.interrupted = true;
      running.wake?.();
      yield* stop(running);
    }),
    close: () => Effect.forEach([...active.values()], stop, { discard: true }).pipe(Effect.catch(() => Effect.void)),
  };
}
