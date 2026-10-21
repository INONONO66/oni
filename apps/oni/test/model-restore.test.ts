import { messageSource } from "../../../packages/agent/test/helpers/message-source";
import { recordingResolveModel } from "../../../packages/agent/test/helpers/resolve-model";
import { testExecutor } from "../../../packages/agent/test/helpers/executor";
import { restoreModelSelection } from "../src/composition/model-selection";
import { chatServices, fixtureStopEvidence } from "../../../packages/agent/test/helpers/chat-services";
import { Effect } from "effect";
import { isolated } from "../../../packages/agent/test/helpers/isolated";
import { recordingLedger } from "../../../packages/agent/test/helpers/effect-g2";
import { describe, expect, it } from "bun:test";
import type { LlmSink as Sink, RunInput } from "../../../packages/agent/src/core/ports/llm";
import type { LedgerAction, Model, PlainObject, PolicyRow } from "@oni/protocol";
import { runAgent } from "../../../packages/agent/src/core/loop/turn";
import { createAssistantMessage } from "../../../packages/agent/src/core/journal/message-factory";
import { compiledPolicy, opPhaseOf } from "../../../packages/agent/test/helpers/compiled-policy";
import { createStopOutcome } from "../../../packages/agent/test/helpers/mock-llm";
import { runInput } from "../../../packages/agent/test/helpers/run-input";
import { TEST_BUDGET } from "../../../packages/agent/test/helpers/approval-policy";

const primary = { provider: "anthropic", id: "primary-model" };
const fallback = { provider: "openai", id: "fallback-model" };

const refuseRestore: PolicyRow.Row[] = [
  {
    name: "keep-fallback",
    kind: "llm",
    phase: "pre",
    match: { encodingVersion: 1, value: { op: "restore_model_selection" } },
    verdict: { encodingVersion: 1, value: { type: "deny", reason: "fallback_pinned" } },
    priority: 500,
    generation: 1,
  },
];

function intentOf(action: LedgerAction.Append): PlainObject {
  const value = action.intent.value;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected object intent");
  return value;
}

async function turn(options: {
  pinnedModel?: Model.Ref;
  modelFallbacks?: Model.Ref[];
  rows?: PolicyRow.Row[];
}) {
  const recording = recordingLedger();
  const resolved: Model.Ref[] = [];
  const executor = testExecutor({
    policy: compiledPolicy(options.rows),
    ledger: recording.ledger,
    observations: { publish: () => undefined },
    clock: () => 1,
    entropy: recording.entropy,
    random: () => 0,
    identity: {
      sessionId: "session",
      role: "resident",
      parentActionId: "turn-2",
      turnId: "turn-2",
    },
  });
  const result = await isolated(
    Effect.gen(function* () {
      const fixture = {
        executor,
        execution: executor,
        events: { publish: () => undefined },
        model: primary,
        ...(options.modelFallbacks === undefined ? {} : { modelFallbacks: options.modelFallbacks }),
        ...(options.pinnedModel === undefined ? {} : { pinnedModel: options.pinnedModel }),
        restoreModelSelection,
        stopEvidence: fixtureStopEvidence,
        llm: {
          run: (_input: RunInput, sink: Sink) =>
            Effect.promise(async () => {
              sink.onMessage(createAssistantMessage("done", "", "session", messageSource));
              return createStopOutcome();
            }),
          resolveModel: recordingResolveModel(resolved),
        },
      };
      const { events: _events, llm: _llm, ...acquiredConfig } = fixture;
      return yield* runAgent(runInput([{ role: "user", content: "go" }]), { defaultBudget: TEST_BUDGET, ...acquiredConfig }).pipe(
        Effect.provide(chatServices(fixture)),
      );
    }),
  );
  // #1252: attempts share the llm kind; logical rows carry no attempt ordinal
  // and are not children of an attempt intent.
  const attemptIds = new Set(
    recording.committed
      .filter(
        (action: import("@oni/protocol").LedgerAction.Append) =>
          action.kind === "llm" &&
          (action.intent.value as { attempt?: number }).attempt !== undefined,
      )
      .map((action: import("@oni/protocol").LedgerAction.Append) => action.id),
  );
  const llm = recording.committed.filter(
    (action: import("@oni/protocol").LedgerAction.Append) =>
      action.kind === "llm" &&
      (action.intent.value as { attempt?: number }).attempt === undefined &&
      !attemptIds.has(action.parentId ?? ""),
  );
  const decisions = recording.committed
    .filter(
      (action: import("@oni/protocol").LedgerAction.Append) =>
        action.kind === "policy.decision",
    )
    .map(intentOf);
  return { result, resolved, llm, decisions, intents: llm.map(opPhaseOf) };
}

describe("restore_model_selection at the turn boundary", () => {
  it("records an executed restoration before chatting on the primary again", async () => {
    const { resolved, llm, intents } = await turn({
      pinnedModel: fallback,
      modelFallbacks: [fallback],
    });
    expect(intents).toEqual([
      "restore_model_selection:intent",
      "restore_model_selection:result",
      "chat:intent",
      "chat:result",
    ]);
    const intent = llm[0];
    if (intent === undefined) throw new Error("missing restoration intent");
    expect(intentOf(intent)).toMatchObject({
      value: { from: fallback, to: primary },
      effect: { model: primary },
      recovery: "local_transactional",
    });
    expect(llm[1]?.effect.value).toMatchObject({ terminal: "executed" });
    expect(resolved).toEqual([primary]);
  });

  it("keeps the fallback pinned when the policy refuses the restoration", async () => {
    const { resolved, decisions, intents } = await turn({
      pinnedModel: fallback,
      modelFallbacks: [fallback],
      rows: refuseRestore,
    });
    // A refused restoration never admits an intent; the policy decision is its record.
    expect(intents).toEqual(["chat:intent", "chat:result"]);
    expect(decisions[0]).toMatchObject({
      hook: "llm.pre",
      op: "restore_model_selection",
      verdict: "deny",
      matchedRuleIds: ["keep-fallback"],
    });
    expect(resolved).toEqual([fallback]);
  });

  it("records nothing when the earlier turn was already on the primary or off the chain", async () => {
    const onPrimary = await turn({ pinnedModel: primary, modelFallbacks: [fallback] });
    expect(onPrimary.intents).toEqual(["chat:intent", "chat:result"]);
    const unconfigured = await turn({ pinnedModel: fallback });
    expect(unconfigured.intents).toEqual(["chat:intent", "chat:result"]);
    expect(unconfigured.resolved).toEqual([primary]);
  });
});
