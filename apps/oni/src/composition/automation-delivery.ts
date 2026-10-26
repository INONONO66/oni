import { Core } from "@oni/agent";
import type { createAutomationStore } from "@oni/channels";
import type { Delivery } from "@oni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import {
  createMessageDeliveryCommit, deliverPayload, materializeDeliveryTarget, pendingDeliveryRow, type MessageDeliveryDeps,
} from "./message-session";
import { AutomationWake } from "./automation-alarm";
import { deliveryMediaParts } from "./delivery-media";

const AutomationOrigin = z.object({
  automation: z.object({ id: z.string(), newSession: z.boolean(), instructions: z.string().optional() }),
});

/** A new session's instructions open its prompt: merged into a leading text part, or set before leading media. */
function withInstructions(instructions: string, content: Delivery.Content): Delivery.Content {
  const [head, ...rest] = content;
  return head?.kind === "text"
    ? [{ kind: "text", text: `${instructions}\n\n${head.text}` }, ...rest]
    : [{ kind: "text", text: instructions }, ...content];
}

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
    deps.media?.remember(input.id, deliveryMediaParts(input.content));
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
      if (!automation.newSession && !deps.plane.read.sessions.list().some((row) => row.id === input.sessionId)) {
        // The app records the refusal through the channels store; channels never learns why.
        yield* Effect.try({
          try: () => store.refused(input.id, "target_not_found"),
          catch: (error) => new Core.AgentFailure({ operation: "automation.receipt", cause: String(error) }),
        });
        return yield* new Core.AgentFailure({ operation: "automation.deliver", cause: "target_not_found" });
      }
      yield* materializeDeliveryTarget(deps.plane, input, deps.clock);
      const instructions = automation.newSession ? automation.instructions : undefined;
      if (instructions !== undefined && input.kind === "action") {
        yield* deliver({
          ...input, id: `${input.id}:instructions`, kind: "prompt",
          content: [{ kind: "text", text: instructions }],
        });
      }
      const row = yield* deliver(instructions !== undefined && input.kind === "prompt"
        ? { ...input, content: withInstructions(instructions, input.content) } : input);
      yield* Effect.try({
        try: () => store.delivered(input.id, row.sessionId, row.ordinal),
        catch: (error) => new Core.AgentFailure({ operation: "automation.receipt", cause: String(error) }),
      });
      return row;
    });
}
