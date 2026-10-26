import { Effect, Result } from "effect";
import type * as SessionHandleStore from "../../../src/core/store/fence";
import type { LedgerError } from "../../../src/core/store/errors";
import type { LedgerAction, LedgerSession } from "@oni/protocol";
import { runLedgerSync } from "./effect";

export function promptAction(input: {
  readonly id: string;
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly content: string;
  readonly ts: number;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "prompt",
    intent: { encodingVersion: 1, value: { source: "test" } },
    effect: { encodingVersion: 1, value: { deliveryKind: "prompt", content: [{ kind: "text", text: input.content }] } },
    irreversible: true,
    ts: input.ts,
  };
}

/** A real configured L0 session row on the given kernel; no legacy JSON writer. */
export function materializeSession<E = never>(
  kernel: SessionHandleStore.SessionKernel,
  id: string,
  parentId: string | null = null,
  afterMaterialize?: (row: LedgerSession.Row) => Effect.Effect<void, E>,
) {
  return Result.getOrThrowWith(
    runLedgerSync(
      Effect.result(
        kernel
          .materialize({
            id,
            parentId,
            role: parentId === null ? "resident" : "child",
            tools: [],
            system: { preset: "", blocks: [] },
            policyGeneration: 0,
            actionId: `${id}:configure`,
            at: 1,
          })
          .pipe(
            Effect.tap(
              (result: LedgerSession.MaterializeResult) =>
                afterMaterialize?.(result.row) ?? Effect.void,
            ),
          ),
      ),
    ),
    (error: LedgerError | E) => error,
  ).row;
}

/** Adopts a fence for `owner` so fenced commits can run; returns the commit authority. */
export function adoptWriter(
  kernel: SessionHandleStore.SessionKernel,
  sessionId: string,
  owner = "writer",
  fence = 1,
) {
  const receipt = Result.getOrThrowWith(
    runLedgerSync(Effect.result(kernel.adoptFence({ sessionId, owner, fence }))),
    (error: LedgerError) => error,
  );
  return { sessionId, owner, fence: receipt.fence };
}
