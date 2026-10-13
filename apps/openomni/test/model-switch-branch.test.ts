import { attemptIntentIds, isAttemptRow, isLogicalLlm } from "../../../packages/agent/test/helpers/llm-rows";
import { expect, test } from "bun:test";
import { LlmRunFailure, type FailureFacts } from "../../../packages/agent/src/core/ports/llm";
import { FakeProviderError } from "../../../packages/agent/test/helpers/fake-llm";
import { PlainObjectSchema, type LedgerAction } from "@openomni/protocol";
import { Effect } from "effect";
import { restoreModelSelection } from "../src/composition/model-selection";
import { requestLedger } from "../../../packages/agent/test/helpers/effect-g1";
import { testExecutor } from "../../../packages/agent/test/helpers/executor";
import { compiledPolicy } from "../../../packages/agent/test/helpers/compiled-policy";
import { isolated, isolatedLedger } from "../../../packages/agent/test/helpers/isolated";
import { sessionTree as kernelSessionTree } from "../../../packages/agent/test/helpers/session-tree";

/** Chain oracle over the active isolation's kernel. */
const sessionTree = (sessionId: string) => kernelSessionTree(isolatedLedger().kernel, sessionId);

const primary = { provider: "a", id: "primary" };
const fallback = { provider: "b", id: "fallback" };

function retryFailure() {
  const cause = new FakeProviderError({
    message: "overloaded", statusCode: 503, responseHeaders: { "retry-after-ms": "0" }, isRetryable: true,
  });
  return new LlmRunFailure({
    message: "overloaded", aborted: false, contextOverflow: false, visibleOutput: false,
    usage: { inputTokens: 1, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    cause, providerErrorName: cause.name,
  });
}

const classify = (_error: FailureFacts["error"]) => ({ kind: "retryable" as const, reason: "transient_error" as const, providerReason: "server_error" as const, afterMs: 0, directed: true, instant: false });

function attemptIntents(actions: readonly LedgerAction.Node[]) {
  return actions.filter((action) => isAttemptRow(action, attemptIntentIds(actions)) &&
    PlainObjectSchema.parse(action.intent.value).phase === "intent");
}

test("route transitions are committed attempt metadata and switching back does not reset the attempt cap", () => isolated(Effect.gen(function* () {
  const recording = yield* requestLedger();
  const options = { ...recording, policy: compiledPolicy(), observations: { publish: () => undefined } };
  const executor = testExecutor(options);
  const entered: string[] = [];
  const result = yield* Effect.result(executor.run({ kind: "llm", op: "chat", intent: {}, effect: {} },
    (parent) => executor.runAttempts(parent, {
      classify,
      prepare: (attempt) => {
        const model = attempt === 2 ? fallback : primary;
        return Effect.succeed({
          request: { op: "chat", intent: { provider: model.provider, model: model.id }, effect: {} },
          admit: () => Effect.void,
          body: () => Effect.gen(function* () {
            const children = attemptIntents(sessionTree(recording.identity.sessionId));
            expect(children).toHaveLength(attempt);
            const intent = children.at(-1);
            expect(intent?.intent.value).toMatchObject({ attempt, maxAttempts: 3 });
            if (attempt > 1) expect(PlainObjectSchema.parse(intent?.intent.value).routeChange)
              .toMatchObject({ kind: "route.changed", to: { provider: model.provider, model: model.id } });
            entered.push(model.provider);
            return yield* retryFailure();
          }),
        });
      },
    })));
  expect(result._tag).toBe("Failure");
  expect(entered).toEqual(["a", "b", "a"]);
  const children = attemptIntents(sessionTree(recording.identity.sessionId));
  expect(children.map((action) => PlainObjectSchema.parse(action.intent.value).attempt)).toEqual([1, 2, 3]);
  expect(PlainObjectSchema.parse(children[0]?.intent.value).routeChange).toBeNull();
  expect(PlainObjectSchema.parse(children[2]?.intent.value).routeChange).toMatchObject({ fromActionId: children[1]?.id });
})));

test("restoration honors a caller-captured pre-switch parent and appends a new branch", () => isolated(Effect.gen(function* () {
  const recording = yield* requestLedger();
  const options = { ...recording, policy: compiledPolicy(), observations: { publish: () => undefined } };
  const executor = testExecutor(options);
  yield* executor.run({ kind: "llm", op: "chat", intent: {}, effect: {} }, (parent) => executor.runAttempts(parent, {
    classify,
    prepare: (attempt) => {
      const model = attempt === 1 ? primary : fallback;
      return Effect.succeed({
        request: { op: "chat", intent: { provider: model.provider, model: model.id }, effect: {} },
        admit: () => Effect.void,
        body: () => attempt === 1 ? Effect.fail(retryFailure()) : Effect.succeed({ type: "stop" }),
      });
    },
  }));
  const before = sessionTree(recording.identity.sessionId);
  const switched = attemptIntents(before).at(-1);
  const change = PlainObjectSchema.parse(PlainObjectSchema.parse(switched?.intent.value).routeChange);
  const preSwitch = before.find((action) => action.id === change.fromActionId);
  if (preSwitch === undefined) throw new Error("missing pre-switch action");
  const branch = testExecutor({ ...options, identity: { ...recording.identity, parentActionId: preSwitch.id } });
  expect(yield* restoreModelSelection(branch, fallback, [primary, fallback])).toBe(0);
  const after = sessionTree(recording.identity.sessionId);
  expect(after.slice(0, before.length)).toEqual(before);
  const restoration = after.slice(before.length).find((action) => isLogicalLlm(action, attemptIntentIds(after)) &&
    PlainObjectSchema.parse(action.intent.value).phase === "intent");
  expect(restoration).toMatchObject({ parentId: preSwitch.id });
  expect(restoration?.intent.value).toMatchObject({ op: "restore_model_selection", value: { from: fallback, to: primary } });
  expect(restoration?.id).not.toBe(switched?.id);
  expect(attemptIntents(after)).toEqual(attemptIntents(before));
})));
