import { Core } from "@oni/agent";
import type { createRuleStore } from "@oni/channels";
import { Provisioning, type Delivery } from "@oni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import {
  createMessageDeliveryCommit, deliverPayload, materializeDeliveryTarget, pendingDeliveryRow, type MessageDeliveryDeps,
} from "./message-session";
import { AutomationWake } from "./automation-alarm";
import type { createResident } from "./resident";

const AutomationOrigin = z.object({
  rule: z.object({ id: z.string(), newSession: z.boolean(), instructions: z.string().optional(), agent: z.string().min(1).optional() }),
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
  store: ReturnType<typeof createRuleStore>,
  genesis: ReturnType<typeof createResident>["genesis"],
) {
  const commit = createMessageDeliveryCommit(deps);
  const refuse = (id: string, reason: string) => Effect.try({
    try: () => store.refused(id, reason),
    catch: (error) => new Core.AgentFailure({ operation: "automation.receipt", cause: String(error) }),
  }).pipe(Effect.andThen(Effect.fail(new Core.AgentFailure({ operation: "automation.deliver", cause: reason }))));
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
      const { rule: automation } = parsed.data;
      const exists = deps.plane.read.sessions.list().some((row) => row.id === input.sessionId);
      if (!automation.newSession && !exists) {
        // The app records the refusal through the channels store; channels never learns why.
        return yield* refuse(input.id, "target_not_found");
      }
      const target = exists
        ? input
        : yield* Effect.try({
            try: () => ({
              ...input,
              createSession: genesis(input.sessionId, null, "resident", "resident", automation.agent),
            }),
            catch: (error) => {
              if (Provisioning.AgentError.isInstance(error)) return error;
              throw error;
            },
          }).pipe(Effect.catch((error) => refuse(input.id, `agent_${error.data.code}`)));
      yield* materializeDeliveryTarget(deps.plane, target, deps.clock);
      const instructions = automation.newSession ? automation.instructions : undefined;
      if (instructions !== undefined && input.kind === "action") {
        yield* deliver({
          ...target, id: `${input.id}:instructions`, kind: "prompt",
          content: [{ kind: "text", text: instructions }],
        });
      }
      const row = yield* deliver(instructions !== undefined && input.kind === "prompt"
        ? { ...target, content: withInstructions(instructions, input.content) } : target);
      yield* Effect.try({
        try: () => store.delivered(input.id, row.sessionId, row.ordinal),
        catch: (error) => new Core.AgentFailure({ operation: "automation.receipt", cause: String(error) }),
      });
      return row;
    });
}
