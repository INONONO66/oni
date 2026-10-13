import { attemptIntentIds, isAttemptRow } from "./helpers/llm-rows";
import { expect, test } from "bun:test";
import { LlmRunFailure, type RunInput, type LlmSink } from "../src/core/llm";
import { RETRY_HEADER_DELAY_CAP } from "../src/core/retry";
import { PlainObjectSchema, type LedgerAction, type Model } from "@openomni/protocol";
import { Effect } from "effect";
import { runAgent } from "../src/core/turn";
import { AgentFailure } from "../src/core/store/errors";
import { isolated } from "./helpers/isolated";
import { requestLedger } from "./helpers/effect-g1";
import { testExecutor } from "./helpers/executor";
import { compiledPolicy } from "./helpers/compiled-policy";
import { chatServices, fixtureStopEvidence, type ChatFixture } from "./helpers/chat-services";
import { runInput } from "./helpers/run-input";
import { TEST_BUDGET } from "./helpers/approval-policy";
import { FakeProviderError } from "./helpers/fake-llm";
import { createAssistantMessage } from "../src/core/message-factory";
import { messageSource } from "./helpers/message-source";

const primary = { provider: "route-a", id: "model-a" };
const fallback = { provider: "route-b", id: "model-b" };
const usage = { inputTokens: 17, outputTokens: 2 };
type Prefix = "none" | "reasoning" | "text" | "tool";

/**
 * The port's typed attempt failure (#1352): what the call layer states about
 * the attempt — billed usage, whether any output reached the Owner, and the
 * provider's wait floor — is the whole input to the loop's route decision.
 */
function providerFailure(prefix: Prefix, floor: number): LlmRunFailure {
  const cause = new FakeProviderError({
    message: "overloaded", statusCode: 529, isRetryable: true, responseHeaders: { "retry-after-ms": String(floor) },
  });
  return new LlmRunFailure({
    message: "overloaded", cause, providerErrorName: cause.name, retryAfterMs: floor,
    usage: { ...usage, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    aborted: false, contextOverflow: false,
    visibleOutput: prefix === "text" || prefix === "tool",
  });
}

function portRun(prefix: Prefix, failed: boolean, floor: number, input: RunInput, sink: LlmSink) {
  return Effect.sync(() => {
    if (failed) return { type: "error" as const, error: providerFailure(prefix, floor) };
    sink.onMessage(createAssistantMessage("answer", input.messages.at(-1)?.info.id ?? "", input.trace.sessionId, messageSource));
    return { type: "stop" as const };
  });
}

function scenario(prefix: Prefix, floor = 0, veto = false) {
  return Effect.gen(function* () {
    const committed: LedgerAction.Append[] = [];
    const providers: string[] = [];
    const resolved: Model.Ref[] = [];
    const arms: number[] = [];
    const recording = yield* requestLedger({ clock: () => 1 });
    const executor = testExecutor({
      ...recording, policy: compiledPolicy(), observations: { publish: () => undefined },
      ledger: { ...recording.ledger, commit: (action) => {
        if (veto && action.kind === "message") return Effect.fail(new AgentFailure({
          operation: "canonical.write", cause: "refused",
        }));
        return recording.ledger.commit(action).pipe(Effect.tap(() => Effect.sync(() => { committed.push(action); })));
      } },
      retryAlarm: {
        arm: (input) => Effect.sync(() => { arms.push(input.fireAt); }),
        wait: () => Effect.void,
        settle: () => Effect.void,
      },
    });
    const fixture: ChatFixture = {
      model: primary, modelFallbacks: [fallback], executor, execution: executor,
      events: { publish: () => undefined },
      llm: {
        resolveModel: (model) => Effect.sync(() => {
          resolved.push(model);
          return { id: model.id, name: model.id, providerID: model.provider };
        }),
        run: (input, sink) => {
          providers.push(input.model.providerID);
          return portRun(prefix, !veto && providers.length === 1, floor, input, sink);
        },
      },
    };
    const { events: _events, llm: _llm, ...config } = fixture;
    const result = yield* Effect.result(runAgent(runInput([{ role: "user", content: "go" }]), { defaultBudget: TEST_BUDGET, ...config, stopEvidence: config.stopEvidence ?? fixtureStopEvidence })
      .pipe(Effect.provide(chatServices(fixture))));
    return { result, committed, providers, resolved, arms };
  });
}

function attempts(actions: readonly LedgerAction.Append[]) {
  const ids = attemptIntentIds(actions);
  return actions.filter((action) => isAttemptRow(action, ids) &&
    PlainObjectSchema.parse(action.intent.value).phase === "intent");
}

function expectFailedPrimaryAttempt(value: Effect.Success<ReturnType<typeof scenario>>): void {
  expect(value.result._tag).toBe("Failure");
  expect(value.providers).toEqual([primary.provider]);
  expect(value.arms).toEqual([]);
  expect(attempts(value.committed)).toHaveLength(1);
}

for (const prefix of ["text", "tool"] as const) {
  test(`a failed ${prefix} prefix forbids fallback and keeps billed evidence`, () => isolated(Effect.gen(function* () {
    const value = yield* scenario(prefix);
    expectFailedPrimaryAttempt(value);
    const result = value.committed.find((action) =>
      isAttemptRow(action, attemptIntentIds(value.committed)) &&
      PlainObjectSchema.parse(action.effect.value).phase === "result");
    expect(result?.effect.value).toMatchObject({ evidence: { failures: [{
      tag: "LlmRunFailure", visibleOutput: true, usage,
    }] } });
    expect(result?.parentId).toBe(attempts(value.committed)[0]?.id);
    expect(attempts(value.committed)[0]?.intent.value).toMatchObject({ value: { provider: primary.provider, model: primary.id } });
    expect(value.committed.filter((action) => action.kind === "message" || action.kind === "tool")).toEqual([]);
  })));
}

test("reasoning-only failure re-admits the fallback and attributes the failure to the original route", () => isolated(Effect.gen(function* () {
  const value = yield* scenario("reasoning");
  expect(value.result._tag).toBe("Success");
  expect(value.providers).toEqual([primary.provider, fallback.provider]);
  expect(value.resolved).toEqual([primary, fallback]);
  expect(value.arms).toEqual([1]);
  const children = attempts(value.committed);
  expect(children).toHaveLength(2);
  expect(children[1]?.intent.value).toMatchObject({
    attempt: 2, maxAttempts: 3, retryReason: "transient_error",
    routeChange: { kind: "route.changed", fromActionId: children[0]?.id,
      from: { provider: primary.provider, model: primary.id },
      to: { provider: fallback.provider, model: fallback.id } },
  });
  expect(value.committed.find((action) => action.parentId === children[0]?.id)?.effect.value)
    .toMatchObject({ evidence: { failures: [{ usage, visibleOutput: false }] } });
  expect(children[0]?.intent.value).toMatchObject({ value: { provider: primary.provider, model: primary.id } });
  expect(value.committed.filter((action) => action.kind === "message")).not.toHaveLength(0);
})));

test("a canonical assistant write refusal vetoes fallback after a successful provider attempt", () => isolated(Effect.gen(function* () {
  const value = yield* scenario("none", 0, true);
  expect(value.result).toMatchObject({ _tag: "Failure", failure: { _tag: "CommitFailed" } });
  expect(value.providers).toEqual([primary.provider]);
  expect(value.resolved).toEqual([primary]);
  expect(value.arms).toEqual([]);
  expect(value.committed.filter((action) => action.kind === "message" || action.kind === "tool")).toEqual([]);
})));

test("a provider floor beyond the retry header budget stops without scheduling an early retry", () => isolated(Effect.gen(function* () {
  const value = yield* scenario("none", RETRY_HEADER_DELAY_CAP + 1);
  expectFailedPrimaryAttempt(value);
})));
