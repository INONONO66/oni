import { uniqueEntropy } from "./time";
import { fencedExecutionLedger } from "./execution-reads";
import { testExecutor } from "./executor";
import { allowConfigure, kernelRuntime, type SessionFixture as SessionRuntime, } from "./session-services";
import type { ResolvedExecutorOptions } from "../../src/core/loop/executor";
import { Cause, Effect, Exit } from "effect";
import type { LedgerAction, SessionTransition } from "@openomni/protocol";
import type { SessionKernel } from "../../src/core/session/entity";
import type { ExecutorOptions, ExecutionLedger } from "../../src/core/loop/executor";
import type {} from "../../src/core/session/run";
import { commitSessionRequest } from "../../src/core/session/request";
import { AgentFailure } from "../../src/core/ports/failure";
import { allowAllPolicy, fixtureHashes } from "./compiled-policy";
import { fencedTurnFixture, fencedTurnIdentity } from "./fenced-writer";
import { isolatedLedger } from "./isolated";
import type { CompiledPolicySnapshot } from "../../src/core/gate/compile";
export { createTestAgent, runTestAgent, runChatAttempts } from "./effect-g2";
export const nullRetryAlarm: NonNullable<ExecutorOptions["retryAlarm"]> = {
  arm: () => Effect.void,
  wait: () => Effect.void,
  settle: () => Effect.void,
};
export function recordingExecutor(
  options: {
    policy?: CompiledPolicySnapshot;
    onCommit?: (action: LedgerAction.Append) => void | Promise<void>;
    onObservation?: (name: string) => void;
    clock?: () => number;
  } = {},
) {
  const committed: LedgerAction.Append[] = [];
  let ordinal = 0;
  const executor = testExecutor({
    policy: options.policy ?? allowAllPolicy,
    retryAlarm: nullRetryAlarm,
    ledger: {
      commit: (action: LedgerAction.Append) =>
        Effect.gen(function* () {
          committed.push(action);
          yield* Effect.promise(async () => {
            await options.onCommit?.(action);
          });
          ordinal += 1;
          return { action: { ...action, ordinal, ...fixtureHashes(ordinal) }, revision: ordinal };
        }),
    },
    observations: { publish: (event) => options.onObservation?.(event.name) },
    identity: { sessionId: "session-1", role: "resident", parentActionId: null },
    clock: options.clock ?? (() => 1),
    entropy: () => `action-${committed.length + 1}`,
    random: () => 0,
  });
  return { executor, committed };
}
export function turnExecutor(
  policy: CompiledPolicySnapshot,
  committed: LedgerAction.Append[] = [],
  overrides: Partial<ResolvedExecutorOptions> = {},
) {
  let ordinal = 0;
  const executor = testExecutor({
    policy,
    retryAlarm: nullRetryAlarm,
    ledger: {
      commit: (action: LedgerAction.Append) =>
        Effect.sync(() => {
          committed.push(action);
          ordinal += 1;
          return { action: { ...action, ordinal, ...fixtureHashes(ordinal) }, revision: ordinal };
        }),
    },
    observations: { publish: () => undefined },
    identity: { sessionId: "session-1", role: "resident", parentActionId: "turn-1" },
    clock: () => 1,
    entropy: () => `action-${committed.length + 1}`,
    random: () => 0,
    ...overrides,
  });
  return { executor, committed };
}
export function failure<A, E, R>(program: Effect.Effect<A, E, R>) {
  return Effect.exit(program).pipe(
    Effect.map((exit: Exit.Exit<A, E>) => {
      if (Exit.isSuccess(exit)) throw new Error("expected failed Effect");
      return Cause.squash(exit.cause);
    }),
  );
}
export function requestLedger(
  input: {
    id?: string;
    clock?: () => number;
    onRequest?: (request: SessionTransition.Request) => void;
    domainRevisions?: SessionRuntime["requestDomainRevisions"];
    kernel?: SessionKernel;
  } = {},
) {
  return Effect.gen(function* () {
    const kernel = input.kernel ?? isolatedLedger().kernel;
    const id = input.id ?? "request-session";
    const clock = input.clock ?? (() => 100);
    const { owner, fence, generation, turnId } = yield* fencedTurnFixture(kernel, { id, clock });
    const runtime: SessionRuntime = {
      clock,
      observations: { publish: () => undefined },
      requestDomainRevisions: input.domainRevisions,
      authorizeConfigure: allowConfigure,
      ...kernelRuntime(() => kernel),
    };
    const ledger: ExecutionLedger = {
      ...fencedExecutionLedger(kernel, id, { owner, fence }, clock),
      transition: (payload: SessionTransition.Payload, inputId: string, at: number) =>
        commitSessionRequest(kernel, id, { owner, fence }, payload, inputId, at, runtime).pipe(
          Effect.tap((decision) =>
            Effect.sync(() => {
              if (decision.request !== undefined) input.onRequest?.(decision.request);
            }),
          ),
        ),
    };
    return {
      ledger,
      identity: fencedTurnIdentity(id, turnId, generation),
      entropy: uniqueEntropy(`${id}-entropy`),
      random: () => 0,
      clock,
    };
  });
}
export type RequestLedger = Effect.Success<ReturnType<typeof requestLedger>>;
export function crashAfterRequestOpen(initial: RequestLedger, operation: string): RequestLedger {
  const transition = initial.ledger.transition;
  if (transition === undefined) throw new Error("missing transition");
  return {
    ...initial,
    ledger: {
      ...initial.ledger,
      transition: (payload: SessionTransition.Payload, inputId: string, at: number) =>
        transition(payload, inputId, at).pipe(
          Effect.flatMap((decision) =>
            payload.kind === "request.open"
              ? Effect.fail(new AgentFailure({ operation, cause: "crash" }))
              : Effect.succeed(decision),
          ),
        ),
    },
  };
}
