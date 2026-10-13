import { messageSource } from "../../helpers/message-source";
import { testExecutor } from "../../helpers/executor";
import { chatServices, fixtureStopEvidence } from "../../helpers/chat-services";
import { KERNEL_POLICY_REGISTRY } from "../../../src/core/gate/compile";
import type { RunInput, LlmSink as Sink } from "../../../src/core/ports/llm";
import { Effect } from "effect";
import { isolated } from "../../helpers/isolated";
import { expect, test } from "bun:test";
import { compilePolicySnapshot, SEEDED_POLICY_ROWS } from "../../../src/core/gate/compile";
import { LedgerAction } from "@openomni/protocol";
import { runAgent } from "../../../src/core/loop/turn";
import { createAssistantMessage } from "../../../src/core/journal/message-factory";
import { recordingLedger } from "../../helpers/g0-effect";
import { runInput } from "../../helpers/run-input";
import { TEST_BUDGET } from "../../helpers/approval-policy";

// Message has no registered post point: a message post row cannot even
// compile — the registry rejects the generation fail-closed at compose.
test("a message post transform row rejects at compose: message has no post point", () => {
  expect(() =>
    compilePolicySnapshot({ registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      kinds: LedgerAction.Kind.options,
      rows: [
        ...SEEDED_POLICY_ROWS.map((row: (typeof SEEDED_POLICY_ROWS)[number]) => ({
          ...row,
          generation: 1,
        })),
        {
          name: "redact-assistant",
          generation: 1,
          kind: "message",
          phase: "post",
          priority: 1000,
          match: { encodingVersion: 1, value: { op: "assistant" } },
          verdict: {
            encodingVersion: 1,
            value: { type: "transform", name: "redact", paths: ["result.parts"] },
          },
        },
      ],
    }),
  ).toThrow(
    expect.objectContaining({
      data: expect.objectContaining({ code: "compose_rejected", composeCode: "unknown_point" }),
    }),
  );
});

// The canonical assistant passes through the admitted generation unchanged.
test("the canonical assistant text is never rewritten after the turn", async () => {
  const recording = recordingLedger();
  const executor = testExecutor({
    policy: compilePolicySnapshot({ registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      kinds: LedgerAction.Kind.options,
      rows: [
        ...SEEDED_POLICY_ROWS.map((row: (typeof SEEDED_POLICY_ROWS)[number]) => ({
          ...row,
          generation: 1,
        })),
      ],
    }),
    ledger: recording.ledger,
    observations: { publish: () => undefined },
    clock: () => 1,
    entropy: recording.entropy,
    random: () => 0,
    identity: { sessionId: "session", role: "resident", parentActionId: "turn" },
  });
  const result = await isolated(
    Effect.gen(function* () { const fixture = {
      events: { publish: () => undefined },
      executor,
      execution: executor,
      model: { provider: "test", id: "test" },
      stopEvidence: fixtureStopEvidence,
      llm: {
        resolveModel: () => Effect.succeed({ providerID: "test", id: "test", name: "test" }),
        run: (_input: RunInput, sink: Sink) =>
          Effect.sync(() => {
            sink.onMessage(createAssistantMessage("raw text", "", "session", messageSource));
            return { type: "stop" as const };
          }),
      },
    }; const { events: _events, llm: _llm, ...acquiredConfig } = fixture; return yield* runAgent(runInput([{ role: "user", content: "question" }]), { defaultBudget: TEST_BUDGET, ...acquiredConfig }).pipe(Effect.provide(chatServices(fixture))); }),
  );
  expect(result.text).toBe("raw text");
  expect(result.steps).toEqual([{ type: "text", content: "raw text" }]);
});
