import { Core } from "@oni/agent";
import type { PlainValue } from "@oni/protocol";
import { Effect } from "effect";
import type { ComputerPolicy, LaunchedWindow } from "./computer-policy";

function closeWindow(policy: ComputerPolicy, entry: LaunchedWindow, executor: Core.Executor) {
  return Effect.gen(function* () {
    if (entry.keep !== undefined) return { ...entry, reason: entry.keep };
    const computer = policy.ports.host().get(entry.machineId).computer;
    if (computer === undefined) return { ...entry, reason: "machine_not_attached" };
    const answer = yield* computer.window.close({ target: entry.target }).pipe(
      Effect.provideService(Core.ExecutorContext, executor),
      Effect.catch((error) => Effect.succeed({ status: "failed", reason: error.message } as const)),
    );
    return answer.status === "ok" && answer.closed ? undefined : { ...entry, result: answer };
  });
}

export function computerTurn<R>(
  policy: ComputerPolicy,
  approvalPolicy: Core.ApprovalPolicy,
  runner: (input: Core.SessionRunnerInput) => Effect.Effect<Core.SessionRunnerResult, Core.ExecutionError, R>,
) {
  return (input: Core.SessionRunnerInput) => Effect.gen(function* () {
    policy.turns.set(input.sessionId, input.turnId);
    const stop = () => policy.stop(input.sessionId);
    input.signal.addEventListener("abort", stop, { once: true });
    if (input.signal.aborted) stop();
    const cleanup = Effect.gen(function* () {
      const launched = policy.launched.filter((entry) =>
        entry.launchedBy.sessionId === input.sessionId && entry.launchedBy.turn === input.turnId);
      if (launched.length === 0) return;
      const executor = yield* Core.createExecutor({
        approvalPolicy, ledger: input.ledger,
        identity: { sessionId: input.sessionId, role: input.role, turnId: input.turnId, parentActionId: input.turnId },
      });
      yield* executor.run({
        kind: "tool", op: "computer.cleanup", intent: {}, effect: { category: "execution" },
      }, () => Effect.gen(function* () {
        const retained: PlainValue[] = [];
        for (const entry of launched) {
          const kept = yield* closeWindow(policy, entry, executor);
          if (kept !== undefined) retained.push(kept);
        }
        return { retained };
      }));
    });
    return yield* runner(input).pipe(Effect.onExit(() => cleanup.pipe(Effect.orDie)), Effect.ensuring(Effect.sync(() => {
      input.signal.removeEventListener("abort", stop);
      policy.turns.delete(input.sessionId);
      for (let index = policy.launched.length - 1; index >= 0; index -= 1) {
        const entry = policy.launched[index];
        if (entry?.launchedBy.sessionId === input.sessionId && entry.launchedBy.turn === input.turnId) policy.launched.splice(index, 1);
      }
    })));
  });
}
