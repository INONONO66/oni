import type { LedgerError } from "../../src/core/store/errors";
import type { Delivery, LedgerAction, LedgerSession } from "@oni/protocol";
import { Effect } from "effect";
import type { SessionKernel } from "../../src/core/session/entity";
import { receivedMessageAction } from "../../src/core/journal/delivery";

export interface ReceivedMessageInput {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: Delivery.Kind;
  readonly content: string;
  readonly origin: Delivery.Origin;
  readonly createdAt: number;
  readonly parentActionId: string | null;
  /** Loop-consumption mode; absent folds to `followUp`. */
  readonly delivery?: "steer" | "followUp";
}

/**
 * Out-of-band ingress as one fenced received-message chain commit (the
 * input-queue table is gone; the chain is the queue). A session with a live writer keeps
 * that writer's authority — ingress rides the current owner+fence exactly like
 * the entity's requestCommand; an unowned session adopts the ingress fence.
 */
export function commitReceivedMessage(
  kernel: SessionKernel,
  input: ReceivedMessageInput,
): Effect.Effect<{ row: LedgerSession.Row; receipt: LedgerAction.Receipt }, LedgerError> {
  return Effect.suspend(() => {
    const current = kernel.row(input.sessionId);
    const writer =
      current.fenceOwner === null
        ? kernel
            .adoptFence({ sessionId: input.sessionId, owner: "ingress", fence: current.fence + 1 })
            .pipe(Effect.map((adopted) => ({ owner: "ingress", fence: adopted.fence })))
        : Effect.succeed({ owner: current.fenceOwner, fence: current.fence });
    return writer.pipe(
      Effect.flatMap(({ owner, fence }) =>
        kernel.commit({
          sessionId: input.sessionId,
          owner,
          fence,
          now: input.createdAt,
          expectedRevision: current.revision,
          actions: [
            receivedMessageAction({
              id: input.id,
              sessionId: input.sessionId,
              kind: input.kind,
              content: input.content,
              origin: input.origin,
              parentActionId: input.parentActionId,
              at: input.createdAt,
              ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
            }),
          ],
          state: current.state,
        }),
      ),
      Effect.map((committed) => {
        const receipt = committed.receipts[0];
        if (receipt === undefined) throw new Error("received-message receipt missing");
        return { row: committed.row, receipt };
      }),
    );
  });
}

/** Queues prompt `queued-${ordinal}` ("S", t=21+ordinal) on the isolated ledger behind the latest action with `delivery` mode. */
export function queuePromptOnS(
  kernel: SessionKernel,
  ordinal: number,
  content: string,
  delivery: "steer" | "followUp",
) {
  return commitReceivedMessage(kernel, {
    id: `queued-${ordinal}`,
    sessionId: "S",
    kind: "prompt",
    content,
    createdAt: 21 + ordinal,
    origin: { encodingVersion: 1, value: {} },
    parentActionId: kernel.latestAction("S")?.id ?? null,
    delivery,
  });
}
