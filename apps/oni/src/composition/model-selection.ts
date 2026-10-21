import type { Core } from "@oni/agent";
import type { Model, PlainObject, PlainValue } from "@oni/protocol";
import { Effect } from "effect";

function record(value: PlainValue | undefined): PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * The model an earlier turn's last provider attempt named, read back from
 * action history. Undefined when no earlier turn attempted a chat; the current
 * turn (including its resume actions) is excluded so a resumed turn keeps its
 * own selection.
 */
export function pinnedModelSelection(
  kernel: Core.SessionKernel,
  sessionId: string,
  turnId: string,
): Model.Ref | undefined {
  const action = kernel.priorModelAttempt(sessionId, turnId);
  const { provider, model } = record(record(action?.intent.value).value);
  return typeof provider === "string" && typeof model === "string" ? { provider, id: model } : undefined;
}

/**
 * Turn boundary: a fallback an earlier turn ended on is released back to the
 * primary only through a recorded `restore_model_selection` action the policy
 * admitted. Returns the index in `chain` this turn starts from: the primary
 * when nothing was pinned or the restoration executed, the pinned fallback when
 * the policy refused it.
 */
export function restoreModelSelection(
  executor: Pick<Core.Executor, "run">,
  pinned: Model.Ref | undefined,
  chain: readonly Model.Ref[],
): Effect.Effect<number, Core.ExecutionError> {
  return Effect.suspend(() => {
  const primary = chain[0];
  if (pinned === undefined || primary === undefined) return Effect.succeed(0);
  const index = chain.findIndex(
    (model) => model.provider === pinned.provider && model.id === pinned.id,
  );
  if (index <= 0) return Effect.succeed(0);
  return executor.run(
    {
      kind: "llm",
      op: "restore_model_selection",
      intent: {
        from: { provider: pinned.provider, id: pinned.id },
        to: { provider: primary.provider, id: primary.id },
      },
      effect: { model: { provider: primary.provider, id: primary.id } },
      recovery: "local_transactional",
    },
    () => Effect.succeed({ restored: true }),
  ).pipe(Effect.map((outcome) => outcome.terminal === "executed" ? 0 : index));
  });
}
