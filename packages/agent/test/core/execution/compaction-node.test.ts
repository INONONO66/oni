import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { CommitRefused } from "../../../src/core/store/errors";
import { isolated } from "../../helpers/isolated";
import { failure } from "../../helpers/effect-g3";
import { overflowThenCompleteLlm } from "../../helpers/mock-llm";
import { expect, it } from "bun:test";
import type { Message } from "@oni/protocol";
import { runTestAgent } from "../../helpers/effect-g3";
import { compiledPolicy } from "../../helpers/compiled-policy";
import { recoveryRecording as recordingExecutor } from "../../helpers/effect-g3r";
import { runInput } from "../../helpers/run-input";
import { RunEvents } from "../../../src/core/loop/turn";
import { executeCompaction } from "../../../src/plugins/compaction/execute-cut";
import { createCompactionPlan, restoreCompactionProjection } from "../../../src/plugins/compaction/durable";
import { Compaction } from "../../../src/plugins/compaction/compact";
import { compactionExecutionInput, evidenceAssistant } from "../../helpers/compaction-cut";

const assistant = (id: string) => evidenceAssistant("compaction-937", id);

it("retains an original atomic entry when the configured protected tail is zero", async () => {
  // Given: a full-rewrite candidate with real completed call/result pairs.
  const prior = [assistant("original-1"), assistant("original-2")];
  // When: the real compaction strategy summarizes the window.
  const result = await isolated(Compaction.compact(
    prior,
    {
      contextWindowTokens: 1000,
      protectRecentMessages: 0,
      onSummarize: () => Effect.promise(async () => "summary"),
    },
    { traceId: "trace-937", sessionId: "compaction-937" },
    { publish: () => undefined },
    { trigger: "yield" },
  ));
  // Then: the suffix boundary is original content, not a synthesized anchor.
  expect(result.compacted).toBe(true);
  expect(result.messages.at(-1)).toEqual(prior.at(-1));
  expect(result).toHaveProperty("record.firstKeptEntryId", "original-2");
});

it("restores exact originals when a replacement has no shared suffix", () => {
  // Given: the review countercase, with a synthesized replacement only.
  const prior = [assistant("original-1"), assistant("original-2")];
  const replacement: Message.WithParts[] = [
    {
      info: {
        id: "new-anchor",
        sessionID: "compaction-937",
        role: "user",
        time: { created: 2 },
        agent: "resident",
        model: { providerID: "provider", modelID: "model" },
      },
      parts: [
        {
          id: "anchor-text",
          sessionID: "compaction-937",
          messageID: "new-anchor",
          type: "text",
          text: "summary",
          metadata: { compactionAnchor: true, anchorBody: "summary" },
        },
      ],
    },
  ];
  // When: the durable projection plan is constructed from that replacement.
  const plan = createCompactionPlan(prior, replacement, 450);
  // Then: its kept boundary is original and restoration removes the synthesis.
  expect(plan.record.firstKeptEntryId).toBe("original-2");
  expect(restoreCompactionProjection(plan.projection, plan.record)).toEqual(prior);
});

it("snapshots removed evidence independently of mutable source messages", () => {
  // Given: an ordinary shared original suffix.
  const prior = [assistant("first"), assistant("last")];
  const original = structuredClone(prior);
  const tail = prior[1];
  if (tail === undefined) throw new Error("missing fixture tail");
  // When: a plan is taken before the source is mutated.
  const plan = createCompactionPlan(prior, [tail], 450);
  prior[0]?.parts.splice(0);
  // Then: the revert payload still contains exact source-time evidence.
  expect(restoreCompactionProjection(plan.projection, plan.record)).toEqual(original);
});

it("refuses compaction restoration when the original kept boundary is missing", () => {
  const tail = assistant("last");
  const plan = createCompactionPlan([assistant("first"), tail], [tail], 450);
  // A concurrent replacement removed the kept boundary; restoring would splice
  // unrelated history onto the discarded entries rather than undo this cut.
  expect(() => restoreCompactionProjection([assistant("unrelated")], plan.record)).toThrow(Error);
});

it("retains concurrent entries after restoring a full-range elision", () => {
  // Given: both originals were replaced with elided same-ID entries.
  const prior = [assistant("first"), assistant("last")];
  const replacement = prior.map((entry) => ({ ...entry, parts: [] }));
  const concurrent = assistant("concurrent");
  // When: a full-range plan is projected, then another entry arrives.
  const plan = createCompactionPlan(prior, replacement, 450);
  const restored = restoreCompactionProjection([...plan.projection, concurrent], plan.record);
  // Then: there is one original copy per ID, followed by the concurrent entry.
  expect(plan.record.firstKeptEntryId).toBe("last");
  expect(restored).toEqual([...prior, concurrent]);
});

it("commits a reversible compaction result before completion observations and the next model call", async () => {
  // Given: a real executor and an overflow at the provider I/O seam.
  const recording = recordingExecutor();
  let durableAtObservation = false;
  let durableAtNextCall = false;
  const committedRecord = () =>
    recording.committed.some((action) => action.kind === "compaction" && "revert" in action);
  const overflow = overflowThenCompleteLlm(() => {
    durableAtNextCall = committedRecord();
  });
  // When: the production run loop recovers through its compaction path.
  await isolated(runTestAgent(
    runInput([
      { role: "user", content: "goal" },
      { role: "assistant", content: "prior evidence ".repeat(200) },
      { role: "user", content: "continue" },
    ]),
    {
      events: {
        publish(event) {
          if (event.name === RunEvents.CompactionCompleted.name)
            durableAtObservation = committedRecord();
        },
      },
      executor: recording.executor,
      model: { provider: "provider", id: "model" },
      compaction: {
        contextWindowTokens: 1000,
        protectRecentMessages: 1,
        speculate: false,
        onSummarize: () => Effect.promise(async () => "checkpoint"),
      },
      llm: overflow.llm,
    },
  ));
  // Then: the durable reversible action precedes both consumers.
  expect(durableAtObservation).toBe(true);
  expect(durableAtNextCall).toBe(true);
  expect(
    recording.committed.filter((action) => action.kind === "compaction" && "revert" in action),
  ).toHaveLength(1);
});

const executionInput = (executor: Parameters<typeof executeCompaction>[0]["executor"], observed: string[]) =>
  compactionExecutionInput(executor, observed, [assistant("first"), assistant("last")]);

it("holds completion observation until the reversible commit resolves", () =>
  isolated(Effect.scoped(Effect.gen(function* () {
    const reached = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const recording = recordingExecutor({
      beforeCommit: (action) => action.kind === "compaction" && "revert" in action
        ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))
        : Effect.void,
    });
    const observed: string[] = [];
    const pending = yield* Effect.forkScoped(executeCompaction(executionInput(recording.executor, observed)));
    yield* Deferred.await(reached).pipe(Effect.timeout("5 seconds"));
    expect(observed).toEqual([RunEvents.CompactionStarted.name]);
    expect(recording.committed.filter((action) => action.kind === "compaction" && "revert" in action)).toHaveLength(0);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(pending);
    expect(observed).toEqual([RunEvents.CompactionStarted.name, RunEvents.CompactionCompleted.name]);
  }))));

it("does not report completion or mutate history when the reversible commit fails", async () => {
  // Given: a fenced commit failure, not a mock compaction implementation.
  const commitFailure = new CommitRefused({ sessionId: "session-1", reason: "fence", expectedRevision: 1, currentRevision: 1, fence: 1, currentFence: 2 });
  const recording = recordingExecutor({
    beforeCommit: (action) => action.kind === "compaction" && "revert" in action
      ? Effect.fail(commitFailure)
      : Effect.void,
  });
  const observed: string[] = [];
  const input = executionInput(recording.executor, observed);
  const original = structuredClone(input.history);
  // When: the real strategy succeeds but its durable result cannot commit.
  expect(await isolated(failure(executeCompaction(input)))).toMatchObject({ _tag: "CommitFailed", error: commitFailure });
  expect(recording.committed.filter((action) => action.kind === "compaction" && "revert" in action)).toHaveLength(0);
  // Then: the active history and success observation remain untouched.
  expect(input.history).toEqual(original);
  expect(observed).toEqual([RunEvents.CompactionStarted.name]);
});

it("refuses compaction before the summarizer when compiled pre policy denies it", async () => {
  // Given: a real compiled compaction pre denial.
  const recording = recordingExecutor({
    policy: compiledPolicy([
      {
        name: "deny-compaction",
        kind: "compaction",
        phase: "pre",
        generation: 1,
        priority: 2000,
        match: { encodingVersion: 1, value: { op: "compact" } },
        verdict: { encodingVersion: 1, value: { type: "deny", reason: "hold" } },
      },
    ]),
  });
  const observed: string[] = [];
  // When: the projection is submitted through the executor.
  expect(await isolated(failure(executeCompaction(executionInput(recording.executor, observed))))).toMatchObject({ _tag: "CompactionExecutionError", reason: "hold" });
  // Then: neither compaction work nor observations ran.
  expect(observed).toEqual([]);
  expect(recording.committed.every((action) => action.kind === "policy.decision")).toBe(true);
});

it("forwards session cancellation into an in-flight compaction summarizer", () =>
  isolated(Effect.scoped(Effect.gen(function* () {
    const controller = new AbortController();
    const started = yield* Deferred.make<AbortSignal>();
    const recording = recordingExecutor();
    const observed: string[] = [];
    const base = executionInput(recording.executor, observed);
    const original = structuredClone(base.history);
    const pending = yield* Effect.forkScoped(Effect.exit(executeCompaction({
      ...base,
      signal: controller.signal,
      options: {
        ...base.options,
        onSummarize: (_messages, _anchor, _budget, signal) => Effect.gen(function* () {
          if (signal === undefined) return yield* Effect.die("missing summary signal");
          return yield* Effect.callback<string>((resume) => {
            const abort = () => resume(Effect.interrupt);
            signal.addEventListener("abort", abort, { once: true });
            Deferred.doneUnsafe(started, Effect.succeed(signal));
            return Effect.sync(() => signal.removeEventListener("abort", abort));
          });
        }),
      },
    })));
    const summarySignal = yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"));
    controller.abort();
    expect(summarySignal.aborted).toBe(true);
    const exit = yield* Fiber.join(pending).pipe(Effect.timeout("5 seconds"));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({
      _tag: "CompactionExecutionError", reason: "fiber_interrupted",
    });
    expect(recording.committed.filter((action) => action.kind === "compaction" && "revert" in action)).toHaveLength(0);
    const terminals = recording.committed.filter((action) => action.kind === "compaction" && typeof action.effect.value === "object" && action.effect.value !== null && "terminal" in action.effect.value);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.effect.value).toMatchObject({
      terminal: "interrupted", reason: "fiber_interrupted", evidence: { failures: [], defects: [], interrupted: true },
    });
    expect(base.history).toEqual(original);
    expect(observed).toEqual([RunEvents.CompactionStarted.name]);
  }))));
