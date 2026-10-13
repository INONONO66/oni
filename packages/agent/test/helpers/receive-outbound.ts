import { Effect, Result } from "effect";
import type { SessionTransition } from "@openomni/protocol";
import type { SessionKernel } from "../../src/core/session/entity";
import { commitReceivedMessage } from "./ingress";
import { runTestSync } from "./isolated";

/** Lands an outbound message in the destination's chain exactly as a live dispatcher would. */
export function receiveOutbound(
  kernel: SessionKernel,
  message: SessionTransition.OutboundMessage,
  createdAt: number,
) {
  return Result.getOrThrowWith(
    runTestSync(
      Effect.result(
        commitReceivedMessage(kernel, {
          id: message.messageId,
          sessionId: message.destinationSessionId,
          kind: "prompt",
          content: message.content,
          origin: { encodingVersion: 1, value: message },
          createdAt,
          parentActionId: null,
        }),
      ),
    ),
    (error) => error,
  );
}
