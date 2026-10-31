import { decodeChannelFailure, type createGatewayRouter } from "@oni/channels";
import type { Ingress } from "@oni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import type { ComputerPolicy } from "./computer-policy";

const ComputerApproval = z.object({
  operation: z.object({
    op: z.literal("computer_request"),
    args: z.object({ machineId: z.string().min(1) }),
  }),
});

type AnswerPort = Parameters<typeof createGatewayRouter>[0]["requests"];

/** The client filters tagged injections before publishing the person-only humanInput.lastAt. */
export function consentOrigin(
  computer: ComputerPolicy,
  requests: AnswerPort,
  now: () => number,
  id: () => string,
  record: (streamId: string, decision: Ingress.RoutingDecisionPayload, at: number) => void,
): AnswerPort["answer"] {
  return (input, context) => {
    const request = requests.list().find((row) => row.requestId === input.requestId && row.sessionId === input.sessionId);
    const approval = request?.mode === "approval" && request.state === "open"
      ? ComputerApproval.safeParse(request.parsedInput) : undefined;
    const machineId = approval?.success ? approval.data.operation.args.machineId : undefined;
    if (context === undefined || machineId === undefined || context.machineId !== machineId ||
      !computer.selfApprovalSuspected(machineId))
      return requests.answer(input, context);
    return Effect.try({
      try: () => {
        const at = now();
        record(`request_answer:${input.inputId}`, {
          traceId: id(), time: at, inboundId: input.inputId,
          surface: context.surfaceKey, mode: "direct", stage: "request_correlation",
          outcome: "block", reason: "self_approval_suspected",
          factsUsed: [`machine:${machineId}`, `request:${input.requestId}`],
        }, at);
        return "self_approval_suspected" as const;
      },
      catch: decodeChannelFailure("consent.refusal"),
    });
  };
}
