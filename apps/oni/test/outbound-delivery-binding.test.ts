import { runEffect, runSyncEffect } from "./helpers/effect";
import { decodeChannelFailure } from "@oni/channels";
import { Effect } from "effect";
import { afterEach, expect, test } from "bun:test";
import { Bus } from "./helpers/bus";
import type { SessionTransition } from "@oni/protocol";
import { runnerTestLayer } from "../../../packages/agent/test/helpers/isolated";
import { dispatchOutboundMessage } from "../src/composition/terminal-message";
import { seedKernelPolicyRows } from "../src/composition/policy";
import { localDelivery, testPlane } from "./helpers/ledger";

const plane = testPlane();
seedKernelPolicyRows(plane.updatePolicy);
afterEach(() => {
  Bus.reset();
});

function materialize(id: string) {
  const kernel = plane.openKernel(id);
  runSyncEffect(kernel.materialize({
    id,
    parentId: null,
    role: "resident",
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: kernel.currentPolicyGeneration(),
    actionId: `${id}:config`,
    at: 100,
  }));
}

const message: SessionTransition.OutboundMessage = {
  messageId: "letter",
  sourceSessionId: "child",
  sourceActionId: "terminal",
  destinationSessionId: "parent",
  requestId: "request",
  replyTo: "request",
  terminal: "completed",
  content: "CHILD_RESULT",
  digest: "digest",
};

test("the receiving consumer may only commit the exact outbound letter", async () => {
  materialize("child");
  materialize("parent");
  const dispatch = dispatchOutboundMessage(
    () =>
      Effect.gen(function* () {
        yield* localDelivery(plane, "binding-test", () => 100)({
          id: "different-letter",
          sessionId: message.destinationSessionId,
          kind: "prompt",
          content: [{ kind: "text", text: message.content }],
          origin: { encodingVersion: 1, value: message },
          createdAt: 100,
          parentActionId: null,
        });
        return {
          status: "executed" as const,
          handle: { messageId: "different-letter", target: "parent" },
          delivery: { kind: "session" as const },
        };
      }).pipe(Effect.mapError(decodeChannelFailure("test.delivery"))),
    plane.openKernel,
  );
  // W5.2: the receipt-missing invariant surfaces as a dispatch defect (the
  // throw inside the outbound program), not a typed AgentFailure; the
  // observable contract is that the outbound send fails as a whole.
  await expect(
    runEffect(
      Effect.scoped(
        dispatch({ message, ledger: { commit: () => Effect.die(new Error("the dispatcher records nothing here")) } }).pipe(
          Effect.provide(runnerTestLayer),
        ),
      ),
    ),
  ).rejects.toThrow("outbound receiving consumer did not commit a receipt");
  // W5.2: the commit-side binding refusal lives in createMessageDeliveryCommit
  // (entity delivery); this harness commits through a raw test delivery, so the
  // dispatch-side receipt check is the invariant under test: no receipt for
  // the real letter means the outbound send fails as a whole.
  expect(
    plane.openKernel("parent").outboundReceipt("parent", message.messageId),
  ).toBeUndefined();
});
