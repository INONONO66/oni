import { runAgentSync } from "./executor";
import { uniqueEntropy } from "./time";
import { fencedExecutionLedger } from "./execution-reads";
import { fencedTurnFixture, fencedTurnIdentity } from "./fenced-writer";
import { isolatedLedger, runTestSync } from "./isolated";
import { allowConfigure, kernelRuntime, type SessionFixture as SessionRuntime, } from "./session-services";
import { Effect, Result } from "effect";
import type { LedgerError } from "../../src/core/store/errors";
import type { SessionKernel } from "../../src/core/session/entity";
import type { ExecutionLedger } from "../../src/core/loop/executor";
import { commitSessionRequest } from "../../src/core/session/request";
import { commitFoldBatch } from "../../src/core/journal/compaction";
import type { LedgerAction, LedgerSession, SessionTransition } from "@openomni/protocol";
import { collector } from "./observation-collector";
import { fixtureCompactionPort } from "./fixture-compaction";
export { bounded } from "./bounded";

export function requestLedger(
  input: {
    id?: string;
    turnId?: string;
    resultId?: string;
    legacy?: boolean;
    clock?: () => number;
    onRequest?: (request: SessionTransition.Request) => void;
    domainRevisions?: SessionRuntime["requestDomainRevisions"];
    kernel?: SessionKernel;
  } = {},
) {
  const kernel = input.kernel ?? isolatedLedger().kernel;
  const id = input.id ?? "request-session";
  const clock = input.clock ?? (() => 100);
  const commit =
    input.legacy === true
      ? kernel.commit
      : (batch: LedgerSession.Commit) => commitFoldBatch(kernel, batch, fixtureCompactionPort);
  const opened = Result.getOrThrowWith(
    runTestSync(
      Effect.result(
        fencedTurnFixture(kernel, {
          id,
          clock,
          turnId: input.turnId,
          resultId: input.resultId,
          commit,
        }),
      ),
    ),
    (error: LedgerError) => error,
  );
  const { owner, fence, generation, turnId } = opened;
  const runtime: SessionRuntime = {
    authorizeConfigure: allowConfigure,
    clock,
    observations: collector(),
    requestDomainRevisions: input.domainRevisions,
    ...kernelRuntime(() => kernel),
  };
  const ledger: ExecutionLedger = {
    ...fencedExecutionLedger(kernel, id, { owner, fence }, clock, (batch) =>
      commitFoldBatch(kernel, batch, fixtureCompactionPort),
    ),
    transition(payload: SessionTransition.Payload, inputId: string, at: number) {
      return Effect.gen(function* () {
        const decision = yield* commitSessionRequest(
          kernel,
          id,
          { owner, fence },
          payload,
          inputId,
          at,
          runtime,
        );
        if (decision.request !== undefined) input.onRequest?.(decision.request);
        return decision;
      });
    },
  };
  return {
    commitBatch(
      actions: readonly LedgerAction.Append[],
      overrides: Partial<LedgerSession.Commit> = {},
    ) {
      const row = kernel.row(id);
      return runAgentSync(
        commitFoldBatch(kernel, {
          sessionId: id,
          owner,
          fence,
          now: clock(),
          expectedRevision: row.revision,
          actions: [...actions],
          state: row.state,
          ...overrides,
        }, fixtureCompactionPort),
      );
    },
    ledger,
    identity: fencedTurnIdentity(id, turnId, generation),
    entropy: uniqueEntropy(`${id}-entropy`),
    random: () => 0,
    clock,
  };
}
