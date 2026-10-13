import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Option } from "effect";
import type { LedgerAction } from "@openomni/protocol";
import { runAgent } from "../helpers/executor";
import { TestClock } from "effect/testing";
import { CommitRefused } from "../../src/core/store/errors";
import { CommitFailed } from "../../src/core/ports/failure";
import type { ExecutorOptions } from "../../src/core/loop/executor";
import { createRetryAlarmPort, type AlarmFired } from "../../src/core/ports/alarm";
import type { RetryAlarmDeps } from "../../src/core/ports/alarm-ports";

// Type-level drop-in proof: the chain-backed port replaces the timer port.
type RetryPortSlot = NonNullable<ExecutorOptions["retryAlarm"]>;
const _dropIn: RetryPortSlot = createRetryAlarmPort({
  sessionId: "s",
  commitArm: () => Effect.void,
  send: () => Effect.void,
  clock: () => 0,
});
void _dropIn;

interface Recorded {
  readonly commits: LedgerAction.Append[];
  readonly sent: AlarmFired[];
  readonly order: string[];
}

function recordingDeps(clock: () => number): { readonly deps: RetryAlarmDeps } & Recorded {
  const commits: LedgerAction.Append[] = [];
  const sent: AlarmFired[] = [];
  const order: string[] = [];
  return {
    commits,
    sent,
    order,
    deps: {
      sessionId: "s1",
      commitArm: (action) =>
        Effect.sync(() => {
          commits.push(action);
          order.push(`commit:${action.id}`);
        }),
      send: (occurrence) =>
        Effect.sync(() => {
          sent.push(occurrence);
          order.push(`send:${occurrence.alarmId}:${occurrence.fireAt}`);
        }),
      clock,
    },
  };
}

describe("retry alarm port over the alarm chain", () => {
  const schedule = { id: "attempt-1", attempt: 1, reason: "transient_error", fireAt: 150 };

  test("arm commits the chain arm row strictly before the DeliverAt send", () =>
    runAgent(
      Effect.gen(function* () {
        const recorded = recordingDeps(() => 100);
        yield* createRetryAlarmPort(recorded.deps).arm(schedule);
        expect(recorded.order).toEqual(["commit:attempt-1:retry:arm:1", "send:attempt-1:retry:150"]);
        const occurrence = recorded.sent[0];
        expect(occurrence?.purpose).toBe("retry");
        expect(occurrence?.alarmId).toBe("attempt-1:retry");
        expect(occurrence?.armSeq).toBe(1);
        expect(occurrence?.fireAt).toBe(150);
        // The committed arm names the SAME occurrence the send carries.
        const effect = recorded.commits[0]?.effect.value;
        expect(effect).toEqual({ occurrenceId: occurrence?.occurrenceId ?? "" });
      }),
    ));

  test("a second attempt supersedes the first attempt's occurrence", () =>
    runAgent(
      Effect.gen(function* () {
        const recorded = recordingDeps(() => 100);
        const port = createRetryAlarmPort(recorded.deps);
        yield* port.arm(schedule);
        yield* port.arm({ ...schedule, attempt: 2, fireAt: 300 });
        expect(recorded.commits.map((action) => action.id)).toEqual([
          "attempt-1:retry:arm:1",
          "attempt-1:retry:arm:3",
        ]);
        const second = recorded.commits[1]?.intent.value as { supersedes?: string };
        expect(second.supersedes).toBe(recorded.sent[0]?.occurrenceId ?? "");
      }),
    ));

  test("a refused chain commit fails the arm and never sends the rearm", () =>
    runAgent(
      Effect.gen(function* () {
        let sent = 0;
        const refusal = new CommitFailed({
          error: new CommitRefused({
            sessionId: "s",
            reason: "revision",
            expectedRevision: 0,
            currentRevision: 1,
            fence: 1,
            currentFence: 1,
          }),
        });
        const port = createRetryAlarmPort({
          sessionId: "s1",
          commitArm: () => Effect.fail(refusal),
          send: () =>
            Effect.sync(() => {
              sent += 1;
            }),
          clock: () => 100,
        });
        expect(yield* Effect.flip(port.arm(schedule))).toBe(refusal);
        expect(sent).toBe(0);
      }),
    ));

  test("settle retires the chain with an at:null arm and sends nothing", () =>
    runAgent(
      Effect.gen(function* () {
        const recorded = recordingDeps(() => 100);
        const port = createRetryAlarmPort(recorded.deps);
        yield* port.arm(schedule);
        yield* port.settle({ id: schedule.id, attempt: schedule.attempt });
        expect(recorded.sent).toHaveLength(1);
        expect(recorded.commits.map((action) => action.id)).toEqual([
          "attempt-1:retry:arm:1",
          "attempt-1:retry:arm:2",
        ]);
        const retire = recorded.commits[1]?.intent.value as {
          at?: number | null;
          supersedes?: string;
        };
        expect(retire.at).toBeNull();
        expect(retire.supersedes).toBe(recorded.sent[0]?.occurrenceId ?? "");
      }),
    ));

  test("wait sleeps exactly the residual and resolves immediately when due", () =>
    runAgent(
      Effect.gen(function* () {
        let now = 100;
        const port = createRetryAlarmPort({
          sessionId: "s1",
          commitArm: () => Effect.void,
          send: () => Effect.void,
          clock: () => now,
        });
        yield* port.wait(100);
        now = 120;
        const fiber = yield* Effect.forkScoped(port.wait(150));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(29);
        expect(Option.isNone(Option.fromUndefinedOr(fiber.pollUnsafe()))).toBe(true);
        yield* TestClock.adjust(1);
        yield* Fiber.join(fiber);
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    ));

  test("an aborted signal interrupts the residual wait", () =>
    runAgent(
      Effect.gen(function* () {
        const port = createRetryAlarmPort({
          sessionId: "s1",
          commitArm: () => Effect.void,
          send: () => Effect.void,
          clock: () => 100,
        });
        const controller = new AbortController();
        const fiber = yield* Effect.forkScoped(port.wait(100_000, controller.signal));
        yield* Effect.yieldNow;
        controller.abort();
        const exit = yield* Fiber.await(fiber);
        expect(exit._tag).toBe("Failure");
      }).pipe(Effect.scoped),
    ));
});
