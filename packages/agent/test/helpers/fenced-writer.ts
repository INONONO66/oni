import type { CommitReceipt } from "../../src/core/store/services";
import type { LedgerError } from "../../src/core/store/errors";
import type { LedgerSession, SessionGeneration } from "@openomni/protocol";
import { Effect } from "effect";
import type { SessionKernel } from "../../src/core/session/entity";
import { sessionTree } from "./session-tree";

export interface FencedTurnFixture {
  readonly owner: string;
  readonly fence: number;
  readonly generation: SessionGeneration.Snapshot;
  readonly turnId: string;
}

/**
 * Materializes one session, adopts the next fence for `<id>:owner` and opens a
 * pending turn intent — the shared write authority every ledger-plane fixture
 * rides now that the TTL lease is gone (W5.2 F5).
 */
/** The identity every fenced-turn fixture hands its executor. */
export function fencedTurnIdentity(
  id: string,
  turnId: string,
  generation: { readonly generation: number; readonly toolsHash: string; readonly systemHash: string },
) {
  return {
    sessionId: id,
    role: "resident" as const,
    parentActionId: turnId,
    turnId,
    toolsGeneration: generation.generation,
    toolsHash: generation.toolsHash,
    systemHash: generation.systemHash,
  };
}

export function fencedTurnFixture(
  kernel: SessionKernel,
  input: {
    readonly id: string;
    readonly clock: () => number;
    readonly turnId?: string;
    readonly resultId?: string;
    readonly commit?: (commit: LedgerSession.Commit) => Effect.Effect<CommitReceipt, LedgerError>;
  },
): Effect.Effect<FencedTurnFixture, LedgerError> {
  return Effect.gen(function* () {
    const { id, clock } = input;
    const commit = input.commit ?? kernel.commit;
    const created = yield* kernel.materialize({
      id,
      role: "resident",
      parentId: null,
      policyGeneration: 1,
      tools: [],
      system: { preset: "", blocks: [] },
      actionId: `${id}:configure`,
      at: clock(),
    });
    const owner = `${id}:owner`;
    const adopted = yield* kernel.adoptFence({
      sessionId: id,
      owner,
      fence: created.row.fence + 1,
    });
    const generation = kernel.latestGenerationFor(id);
    const turnId = input.turnId ?? `${id}:turn`;
    if (!sessionTree(kernel, id).some((action) => action.id === turnId)) {
      yield* commit({
        sessionId: id,
        owner,
        fence: adopted.fence,
        now: clock(),
        expectedRevision: kernel.row(id).revision,
        state: "running",
        actions: [
          {
            id: turnId,
            sessionId: id,
            parentId: `${id}:configure`,
            kind: "turn",
            intent: {
              encodingVersion: 1,
              value: {
                phase: "intent",
                resultId: input.resultId ?? `${id}:result`,
                deliveryIds: [],
                resumeCount: 0,
                boundaryActionId: null,
                toolsGeneration: generation.generation,
                toolsHash: generation.toolsHash,
                systemHash: generation.systemHash,
                policyGeneration: 1,
              },
            },
            effect: { encodingVersion: 1, value: { phase: "pending" } },
            ts: clock(),
            irreversible: true,
          },
        ],
      });
    }
    return { owner, fence: adopted.fence, generation, turnId };
  });
}
