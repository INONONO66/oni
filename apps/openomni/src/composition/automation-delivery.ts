import { Core } from "@openomni/agent";
import type { createAutomationStore } from "@openomni/channels";
import type { Delivery } from "@openomni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import {
  createMessageDeliveryCommit, deliverPayload, materializeDeliveryTarget, pendingDeliveryRow, type MessageDeliveryDeps,
} from "./message-session";
import { AutomationWake } from "./automation-alarm";

const AutomationOrigin = z.object({
  automation: z.object({ id: z.string(), newSession: z.boolean(), instructions: z.string().optional() }),
});

/** Genesis and both inputs use the core create/Deliver doors; channels alone owns receipts. */
export function createAutomationDelivery(
  deps: MessageDeliveryDeps,
  store: ReturnType<typeof createAutomationStore>,
) {
  const commit = createMessageDeliveryCommit(deps);
  const deliver = (input: Delivery.Commit) => Effect.gen(function* () {
    const wake = yield* AutomationWake;
    if (wake?.sessionId !== input.sessionId) return yield* commit(input);
    if (wake.deliver === undefined)
      return yield* new Core.AgentFailure({ operation: "automation.deliver", cause: "alarm intake is not composed" });
    const payload = yield* deliverPayload(input);
    const receipt = yield* wake.deliver(payload).pipe(
      Effect.mapError((error) => new Core.AgentFailure({ operation: "automation.deliver", cause: error._tag })),
    );
    return pendingDeliveryRow(input, receipt.seq);
  });
  return (input: Delivery.Commit): Effect.Effect<Delivery.Row, Core.AgentFailure> =>
    Effect.gen(function* () {
      const parsed = AutomationOrigin.safeParse(input.origin.value);
      if (!parsed.success) return yield* deliver(input);
      const { automation } = parsed.data;
      if (!automation.newSession && !deps.plane.listSessions().some((row) => row.id === input.sessionId))
        return yield* new Core.AgentFailure({ operation: "automation.deliver", cause: "target_not_found" });
      yield* materializeDeliveryTarget(deps.plane, input, deps.clock);
      const instructions = automation.newSession ? automation.instructions : undefined;
      if (instructions !== undefined && input.kind === "action") {
        yield* deliver({
          ...input, id: `${input.id}:instructions`, kind: "prompt", content: instructions,
        });
      }
      const row = yield* deliver(instructions !== undefined && input.kind === "prompt"
        ? { ...input, content: `${instructions}\n\n${input.content}` } : input);
      yield* Effect.try({
        try: () => store.delivered(input.id, row.sessionId, row.ordinal),
        catch: (error) => new Core.AgentFailure({ operation: "automation.receipt", cause: String(error) }),
      });
      return row;
    });
}
