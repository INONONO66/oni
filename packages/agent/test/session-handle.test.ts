import { turnIntent, openTurns, turnResume } from "../src/core/store/session-reads";
import { describe, expect, spyOn, test } from "bun:test";
import { Effect, } from "effect";
import { type LedgerAction, type L0Observation, PlainValueSchema } from "@oni/protocol";
import type { Delivery } from "@oni/protocol";
import type { SessionHandle } from "../src/core/session/run";
import type { SessionRunner, SessionRunnerInput } from "../src/core/session/run";
import { AgentFailure } from "../src/core/store/errors";

import { isolatedLedger } from "./helpers/isolated";
import { awaitSignal, boundedSignal as bounded } from "./helpers/g0-signals";
import {
  commitDelivery,
  declare,
  deliveries,
  deliveryRows,
  durableRequest,
  kernel,
  now,
  policyGeneration,
  policyHook,
  reactivate,
  recordingRunner,
  residentOptions,
  signal,
  suite,
  system,
  terminals,
  testProgram,
  tool,
  tree,
  useSessionHandleSuite,
} from "./helpers/session-handle-suite";

// Ported to the entity plane: handle-scoped kernels via
// `isolated()`, eager fence adoption at controller creation instead of TTL
// leases, the SQL delivery projection (`commitReceivedMessage`/`inputMessages`)
// instead of queue rows, and per-session `reactivateSession` instead of the
// boot sweep.
//
// Deleted with their planes, not ported:
// - "keeps the durable lease held through an ignored abort so no other
//   runtime can resume" and "reports typed lease contention from the
//   SQLite-backed session API": TTL lease-acquisition contention is
//   deleted - a successor activation adopts the next fence instead of being
//   refused, and the stale writer's commit dies at the fence CAS. Proven by
//   conformance T11, the owner_reclaimed_before_stale_transcript_flush crash
//   cell, and "does not overlap a resumed runner..." below.
// - "a retained runner whose lease lapsed does not wedge the handle": lease
//   TTL/expiry is deleted; there is no lapse. The surviving behavior (a
//   stubborn runner cannot wedge later turns) is covered by the resume and
//   close-grace tests below.
// - "a refused retained release surfaces once to the next turn start and then
//   clears": the empty lease-release commit is deleted; hibernation releases
//   no durable authority, so there is no release commit to refuse.
// - "heartbeat loss aborts the runner and the stale fence cannot seal its
//   result" and "default heartbeat uses an unreferenced timer and clears it
//   after the runner settles": the heartbeat scheduling plane is
//   deleted; fence adoption at activation is the takeover authority.
//   Stale-fence-cannot-seal is proven by conformance T11 and the
//   owner_reclaimed crash cell.
// - "watch installs its subscription before reading the initial snapshot":
//   the injectable storage-adapter seam it hooked is deleted,
//   and the ordering is structural now - `watchSnapshot` subscribes and takes
//   its initial snapshot inside one store transaction.

useSessionHandleSuite();

describe("durable session handle: admission and turn sealing", () => {
  test("records prompt and turn policy once at their existing durable envelopes", () =>
    testProgram(
      Effect.gen(function* () {
        const observedBeforeCommit: string[] = [];
        const observedDecisionIds = new Set<string>();
        suite.sink.onCommit = (committed: L0Observation.ActionCommitted) => {
          if (committed.kind !== "policy.decision") return;
          observedDecisionIds.add(committed.id);
          if (!tree("policy-topology").some((action) => action.id === committed.id)) {
            observedBeforeCommit.push(committed.id);
          }
        };
        const policies = isolatedLedger().catalog.policies;
        const runner: SessionRunner = () =>
          Effect.sync(() => {
            for (const row of policies.rows(1)) policies.append({ ...row, generation: 2 });
            policies.append({
              name: "deny-new-generation-turn-post",
              kind: "turn",
              phase: "post",
              match: { encodingVersion: 1, value: { op: "session" } },
              verdict: { encodingVersion: 1, value: { type: "deny", reason: "new generation" } },
              priority: 2_000,
              generation: 2,
            });
            return { kind: "result", text: "complete" };
          });
        const handle = yield* declare(residentOptions("policy-topology", runner));

        const result = yield* awaitSignal(handle.prompt("run once"));

        const actions = tree(handle.id);
        // The delivery row shares the prompt kind; the admission row has no delivery phase.
        const isAdmittedPrompt = (action: (typeof actions)[number]) =>
          action.kind === "prompt" &&
          (action.effect.value as { phase?: string } | null)?.phase !== "delivery";
        const prompt = actions.find(isAdmittedPrompt);
        const turn = actions.find((action) => turnIntent(action) !== undefined);
        const decisions = actions.filter((action) => action.kind === "policy.decision");
        expect(result).toEqual({ kind: "result", text: "complete" });
        expect(actions.filter(isAdmittedPrompt)).toHaveLength(1);
        expect(actions.filter((action) => action.kind === "turn")).toHaveLength(2);
        // Prompt has no post point: the executor consults prompt.pre only.
        expect(decisions.map(policyHook).sort()).toEqual([
          "prompt.pre",
          "turn.post",
          "turn.pre",
        ]);
        expect(
          decisions
            .filter((action) => policyHook(action)?.startsWith("prompt."))
            .every((action) => action.parentId === prompt?.id),
        ).toBe(true);
        expect(
          decisions
            .filter((action) => policyHook(action)?.startsWith("turn."))
            .every((action) => action.parentId === turn?.id),
        ).toBe(true);
        expect(decisions.map(policyGeneration)).toEqual([1, 1, 1]);
        expect(observedDecisionIds).toEqual(new Set(decisions.map((action) => action.id)));
        expect(observedBeforeCommit).toEqual([]);
      }),
    ));

  /** Runs one prompt against an isolation whose only extra policy row denies prompts at `phase`. */
  function promptDeniedAt(
    phase: "pre" | "post",
    reason: string,
    assertOutcome: (outcome: {
      readonly hooks: (string | undefined)[];
      readonly deliveries: Delivery.Row["status"][];
    }) => void,
  ) {
    return testProgram(
      Effect.gen(function* () {
        let calls = 0;
        const handle = yield* declare(
          residentOptions(`prompt-${phase}-deny`, () =>
            Effect.sync(() => {
              calls += 1;
              return { kind: "result", text: "must not run" };
            }),
          ),
        );
        const result = yield* awaitSignal(handle.prompt("blocked prompt"));
        expect(result).toMatchObject({
          kind: "error",
          cause: { _tag: "SessionPolicyRefusal", reason },
        });
        expect(calls).toBe(0);
        expect(tree(handle.id).filter((action) => action.kind === "turn")).toEqual([]);
        assertOutcome({
          hooks: tree(handle.id)
            .filter((action) => action.kind === "policy.decision")
            .map(policyHook),
          deliveries: deliveryRows(handle.id).map((row) => row.status),
        });
      }),
      {
        policies: [
          {
            name: `deny-prompt-${phase}`,
            kind: "prompt",
            phase,
            match: { encodingVersion: 1, value: { op: "delivery" } },
            verdict: { encodingVersion: 1, value: { type: "deny", reason } },
            priority: 2_000,
          },
        ],
      },
    );
  }

  test("a prompt pre denial consumes the pending row without constructing or running a turn", () =>
    promptDeniedAt("pre", "prompt refused", ({ hooks, deliveries }) => {
      expect(hooks).toEqual(["prompt.pre"]);
      expect(deliveries).toEqual(["consumed"]);
    }));

  // Prompt has no post point: a generation carrying a prompt post row
  // is rejected wholesale by the point registry at compile, and every
  // execution against the rejected generation fails closed.
  test("a generation with a prompt post row fails closed: the registry rejects it and no turn runs", () =>
    testProgram(
      Effect.gen(function* () {
        let calls = 0;
        const handle = yield* declare(
          residentOptions("prompt-post-rejected", () =>
            Effect.sync(() => {
              calls += 1;
              return { kind: "result", text: "must not run" };
            }),
          ),
        );
        const result = yield* handle.prompt("rejected generation").pipe(Effect.match({
          onFailure: (left) => ({ _tag: "Left", left }),
          onSuccess: (right) => ({ _tag: "Right", right }),
        }));
        expect(result).toMatchObject({
          _tag: "Left",
          left: { _tag: "AgentFailure", operation: "generation.policy", cause: expect.stringContaining("unknown_point") },
        });
        expect(calls).toBe(0);
        expect(tree(handle.id).filter((action) => action.kind === "turn")).toEqual([]);
      }),
      {
        policies: [
          {
            name: "deny-prompt-post",
            kind: "prompt",
            phase: "post",
            match: { encodingVersion: 1, value: { op: "delivery" } },
            verdict: { encodingVersion: 1, value: { type: "deny", reason: "prompt post refused" } },
            priority: 2_000,
          },
        ],
      },
    ));

  for (const path of ["result.usage", "result.text"] as const) {
    test(`accepts a turn post transform of ${path} only when the result still satisfies its contract`, () =>
      testProgram(
        Effect.gen(function* () {
          let calls = 0;
          const handle = yield* declare(
            residentOptions(`turn-transform-${path}`, () =>
              Effect.sync(() => {
                calls += 1;
                return {
                  kind: "result",
                  text: "typed result",
                  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
                };
              }),
            ),
          );

          const result = yield* awaitSignal(handle.prompt("transform turn result"));

          expect(calls).toBe(1);
          if (path === "result.usage") {
            expect(result).toEqual({ kind: "result", text: "typed result" });
          } else {
            expect(result).toMatchObject({
              kind: "error",
              cause: { _tag: "SessionPolicyRefusal", reason: "invalid_output" },
            });
          }
        }),
        {
          policies: [
            {
              name: `transform-turn-${path}`,
              kind: "turn",
              phase: "post",
              match: { encodingVersion: 1, value: { op: "session" } },
              verdict: {
                encodingVersion: 1,
                value: { type: "transform", name: "redact", paths: [path] },
              },
              priority: 2_000,
            },
          ],
        },
      ));
  }

  for (const sample of [
    {
      name: "required counters",
      valid: true,
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    },
    {
      name: "optional counters",
      valid: true,
      usage: {
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
        reasoningTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
      },
    },
    { name: "missing required counter", valid: false, usage: { inputTokens: 4, outputTokens: 5 } },
    {
      name: "invalid optional counter",
      valid: false,
      usage: {
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
        reasoningTokens: "invalid",
      },
    },
    {
      name: "unknown counter",
      valid: false,
      usage: {
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
        unknownTokens: 1,
      },
    },
  ] as const) {
    test(`validates transformed session usage with ${sample.name}`, () =>
      testProgram(
        Effect.gen(function* () {
          const handle = yield* declare(
            residentOptions("usage-transform", () =>
              Effect.sync(() => {
                return {
                  kind: "result",
                  text: "result",
                  finishReason: "stop",
                  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
                };
              }),
            ),
          );
          const result = yield* awaitSignal(
            bounded(handle.prompt("measure"), "transformed usage terminal"),
          );
          if (sample.valid) {
            expect(result).toEqual({
              kind: "result",
              text: "result",
              finishReason: "stop",
              usage: sample.usage,
            });
          } else {
            expect(result).toMatchObject({
              kind: "error",
              cause: { _tag: "SessionPolicyRefusal", reason: "invalid_output" },
            });
          }
          expect(terminals(handle.id)).toMatchObject([{ kind: sample.valid ? "result" : "error" }]);
        }),
        {
          policies: [
            {
              name: "transform-usage",
              kind: "turn",
              phase: "post",
              match: { encodingVersion: 1, value: { op: "session" } },
              verdict: {
                encodingVersion: 1,
                value: {
                  type: "transform",
                  name: "redact",
                  paths: ["result.usage"],
                  replacement: PlainValueSchema.parse(sample.usage),
                },
              },
              priority: 2_000,
            },
          ],
        },
      ));
  }

  for (const phase of ["pre", "post"] as const) {
    test(`turn ${phase} policy denial distinguishes body-zero pre from irreversible post`, () =>
      testProgram(
        Effect.gen(function* () {
          let calls = 0;
          const handle = yield* declare(
            residentOptions(`turn-${phase}-deny`, () =>
              Effect.sync(() => {
                calls += 1;
                return { kind: "result", text: "body result" };
              }),
            ),
          );

          const result = yield* awaitSignal(handle.prompt("start the turn"));

          const hooks = tree(handle.id)
            .filter((action) => action.kind === "policy.decision")
            .map(policyHook);
          expect(result).toMatchObject({
            kind: "error",
            cause: { _tag: "SessionPolicyRefusal", reason: `turn ${phase} refused` },
          });
          expect(calls).toBe(phase === "pre" ? 0 : 1);
          expect(hooks).toEqual(
            phase === "pre"
              ? ["prompt.pre", "turn.pre"]
              : ["prompt.pre", "turn.pre", "turn.post"],
          );
          expect(terminals(handle.id).at(0)).toMatchObject({ kind: "error" });
        }),
        {
          policies: [
            {
              name: `deny-turn-${phase}`,
              kind: "turn",
              phase,
              match: { encodingVersion: 1, value: { op: "session" } },
              verdict: {
                encodingVersion: 1,
                value: { type: "deny", reason: `turn ${phase} refused` },
              },
              priority: 2_000,
            },
          ],
        },
      ));
  }

  test("refuses a turn when its pinned generation has no mandatory policy row", () =>
    testProgram(
      Effect.gen(function* () {
        let calls = 0;
        const handle = yield* declare(
          residentOptions("missing-policy", () =>
            Effect.sync(() => {
              calls += 1;
              return { kind: "result", text: "ran" };
            }),
          ),
        );

        const result = yield* handle.prompt("must be refused").pipe(Effect.match({
          onFailure: (left) => ({ _tag: "Left", left }),
          onSuccess: (right) => ({ _tag: "Right", right }),
        }));

        expect(calls).toBe(0);
        expect(result).toMatchObject({
          _tag: "Left",
          left: { _tag: "AgentFailure", operation: "generation.policy", cause: expect.stringContaining("missing mandatory rule compaction") },
        });
        expect(tree(handle.id).filter((action) => action.kind === "turn")).toEqual([]);
      }),
      { seedPolicies: false },
    ));

  test("serializes one runner and drains concurrent prompts as distinct ordered messages", () =>
    testProgram(
      Effect.gen(function* () {
        const entered = signal<SessionRunnerInput>();
        const releaseBoundary = signal<void>();
        let active = 0;
        let maximumActive = 0;
        let runs = 0;
        const drained: SessionRunnerInput["messages"][] = [];
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.gen(function* () {
            const treeAtEntry = tree(input.sessionId);
            const intent = treeAtEntry.find((action) => action.id === input.turnId);
            expect(turnIntent(intent)?.resultId).toBe(input.resultId);
            expect(treeAtEntry.some((action) => action.id === input.resultId)).toBe(false);
            runs += 1;
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            entered.resolve(input);
            yield* awaitSignal(releaseBoundary.promise);
            drained.push([...(yield* awaitSignal(input.boundary("after_llm"))).messages]);
            active -= 1;
            return { kind: "result", text: "done" };
          });
        const handle = yield* declare(residentOptions("single-flight", runner));

        const first = yield* Effect.forkChild(handle.prompt("first prompt"));
        const firstInput = yield* awaitSignal(bounded(entered.promise, "runner entry"));
        const secondCommitted = signal<void>();
        const thirdCommitted = signal<void>();
        suite.sink.onCommit = () => {
          const rows = deliveryRows(handle.id);
          if (rows.some((row) => row.content === "second prompt")) secondCommitted.resolve();
          if (rows.some((row) => row.content === "third prompt")) thirdCommitted.resolve();
        };
        const second = yield* Effect.forkChild(handle.prompt("second prompt"));
        yield* bounded(secondCommitted.promise, "second prompt committed");
        const third = yield* Effect.forkChild(handle.prompt("third prompt"));
        yield* bounded(thirdCommitted.promise, "third prompt committed");
        releaseBoundary.resolve();
        yield* awaitSignal(
          bounded(
            Effect.all([awaitSignal(first), awaitSignal(second), awaitSignal(third)], {
              concurrency: "unbounded",
            }),
            "serialized prompt completion",
          ),
        );

        // The mid-turn backlog is followUp by default, so the first
        // turn's boundary drains nothing and the queued prompts feed one
        // follow-up turn at turn end — still a single serialized runner.
        expect(runs).toBe(2);
        expect(maximumActive).toBe(1);
        expect(firstInput.messages).toEqual([
          { id: deliveryRows(handle.id)[0]?.id, role: "user", text: "first prompt" },
        ]);
        expect(drained).toEqual([[], []]);
        expect(deliveryRows(handle.id).map((row) => [row.content, row.status])).toEqual([
          ["first prompt", "consumed"],
          ["second prompt", "consumed"],
          ["third prompt", "consumed"],
        ]);
        expect(deliveries(handle.id).map((delivery) => delivery.deliveryId)).toEqual(
          deliveryRows(handle.id).map((row) => row.id),
        );
      }),
    ));

  test("a turn's ledger refuses a request transition once that turn has sealed", () =>
    testProgram(
      Effect.gen(function* () {
        const entered = signal<SessionRunnerInput>();
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.sync(() => {
            entered.resolve(input);
            return { kind: "result", text: "done" };
          });
        const handle = yield* declare(residentOptions("late-transition", runner));
        yield* awaitSignal(bounded(handle.prompt("first prompt"), "prompt completion"));
        const input = yield* awaitSignal(bounded(entered.promise, "runner entry"));
        const request = durableRequest(handle.id, input.turnId);
        const before = tree(handle.id);
        if (input.ledger.transition === undefined) throw new Error("missing transition port");
        const late = input.ledger.transition({ kind: "request.open", request }, "late:open", now);
        const refused = yield* Effect.flip(late);
        expect(refused).toMatchObject({
          _tag: "AgentFailure",
          operation: "session.request.transition",
          cause: "stale",
        });
        expect(tree(handle.id)).toEqual(before);
        expect(kernel().requestRows()).toEqual([]);
      }),
    ));

  test("an interrupt landing during turn.pre admission seals interrupted without entering the runner", () =>
    testProgram(
      Effect.gen(function* () {
        let runs = 0;
        const handle = yield* declare(
          residentOptions("interrupt-before-body", () =>
            Effect.sync(() => {
              runs += 1;
              return { kind: "result", text: "ran" };
            }),
          ),
        );
        const admitted = signal<void>();
        const interrupted = signal<void>();
        const target = kernel();
        const commit = target.commit.bind(target);
        const gate = spyOn(target, "commit").mockImplementation(
          (input: Parameters<typeof commit>[0]) =>
            Effect.gen(function* () {
              const receipt = yield* commit(input);
              if (input.state === "interrupted") interrupted.resolve();
              if (
                input.actions.some(
                  (action: LedgerAction.Append) => policyHook(action) === "turn.pre",
                )
              ) {
                admitted.resolve();
                yield* Effect.promise(() => interrupted.promise);
              }
              return receipt;
            }),
        );
        let result: Effect.Success<ReturnType<SessionHandle["prompt"]>>;
        try {
          const prompt = yield* Effect.forkChild(handle.prompt("never reaches the runner"));
          yield* bounded(admitted.promise, "turn.pre committed");
          const interrupt = yield* Effect.forkChild(handle.interrupt());
          result = yield* bounded(prompt, "prompt completion");
          yield* bounded(interrupt, "interrupt receipt");
        } finally {
          gate.mockRestore();
        }
        expect(result).toEqual({ kind: "interrupted", text: "" });
        expect(runs).toBe(0);
        expect(handle.get().state).toBe("interrupted");
        expect(openTurns(tree(handle.id))).toEqual([]);
      }),
    ));

  test("a storage failure during turn admission seals the turn as an error", () =>
    testProgram(
      Effect.gen(function* () {
        let runs = 0;
        const handle = yield* declare(
          residentOptions("admission-storage-failure", () =>
            Effect.sync(() => {
              runs += 1;
              return { kind: "result", text: "ran" };
            }),
          ),
        );
        const target = kernel();
        const commit = target.commit.bind(target);
        const explode = spyOn(target, "commit").mockImplementation(
          (input: Parameters<typeof commit>[0]) => {
            const decision = input.actions.find(
              (action: LedgerAction.Append) => action.kind === "policy.decision",
            );
            if (decision === undefined || policyHook(decision) !== "turn.pre") return commit(input);
            explode.mockRestore();
            return Effect.fail(
              new AgentFailure({ operation: "session.commit", cause: "admission fixture" }),
            );
          },
        );
        const result = yield* awaitSignal(
          bounded(handle.prompt("admission fails"), "prompt completion"),
        );
        expect(result).toMatchObject({
          kind: "error",
          cause: {
            _tag: "CommitFailed",
            error: {
              _tag: "AgentFailure",
              operation: "session.commit",
              cause: "admission fixture",
            },
          },
        });
        expect(runs).toBe(0);
        expect(handle.get().state).toBe("idle");
        expect(openTurns(tree(handle.id))).toEqual([]);
      }),
    ));

  test("records an idle interrupt as a no-op without resuming the next prompt", () =>
    testProgram(
      Effect.gen(function* () {
        const { runner, inputs } = recordingRunner("ran once");
        const handle = yield* declare(residentOptions("idle-interrupt", runner));
        yield* commitDelivery({
          id: "idle-interrupt:interrupt",
          sessionId: handle.id,
          kind: "interrupt",
          content: "",
          origin: { encodingVersion: 1, value: { source: "test" } },
          createdAt: now,
          parentActionId: tree(handle.id).at(-1)?.id ?? null,
        });

        const result = yield* awaitSignal(handle.prompt("run after the no-op"));

        expect(result).toEqual({ kind: "result", text: "ran once" });
        expect(inputs).toHaveLength(1);
        expect(inputs[0]?.resumeCount).toBe(0);
        expect(openTurns(tree(handle.id))).toEqual([]);
        expect(
          tree(handle.id).filter((action) => turnResume(action) !== undefined),
        ).toEqual([]);
      }),
    ));

  test("seals a queued prompt followed by an interrupt without entering the runner", () =>
    testProgram(
      Effect.gen(function* () {
        let entries = 0;
        const runner: SessionRunner = () =>
          Effect.sync(() => {
            entries += 1;
            return { kind: "result", text: "must not run" };
          });
        yield* kernel().materialize({
          id: "queued-interrupt",
          parentId: null,
          role: "resident",
          tools: [tool("read")],
          system,
          policyGeneration: kernel().currentPolicyGeneration(),
          actionId: "queued-interrupt:configure",
          at: now,
        });
        yield* commitDelivery({
          id: "queued-interrupt:prompt",
          sessionId: "queued-interrupt",
          kind: "prompt",
          content: "do not run",
          origin: { encodingVersion: 1, value: { source: "test" } },
          createdAt: now,
          parentActionId: tree("queued-interrupt").at(-1)?.id ?? null,
        });
        yield* commitDelivery({
          id: "queued-interrupt:interrupt",
          sessionId: "queued-interrupt",
          kind: "interrupt",
          content: "",
          origin: { encodingVersion: 1, value: { source: "test" } },
          createdAt: now + 1,
          parentActionId: tree("queued-interrupt").at(-1)?.id ?? null,
        });

        yield* awaitSignal(reactivate("queued-interrupt", runner));

        expect(entries).toBe(0);
        expect(openTurns(tree("queued-interrupt"))).toEqual([]);
        expect(kernel().getSnapshot("queued-interrupt", 4)).toMatchObject({
          state: "interrupted",
          turns: [{ terminal: { kind: "interrupted" } }],
        });
      }),
    ));

  test("a leading idle interrupt is consumed before a later prompt starts", () =>
    testProgram(
      Effect.gen(function* () {
        const { runner, inputs } = recordingRunner("ran once");
        yield* kernel().materialize({
          id: "leading-idle-interrupt",
          parentId: null,
          role: "resident",
          tools: [tool("read")],
          system,
          policyGeneration: kernel().currentPolicyGeneration(),
          actionId: "leading-idle-interrupt:configure",
          at: now,
        });
        yield* commitDelivery({
          id: "leading-idle-interrupt:interrupt",
          sessionId: "leading-idle-interrupt",
          kind: "interrupt",
          content: "",
          origin: { encodingVersion: 1, value: { source: "test" } },
          createdAt: now,
          parentActionId: tree("leading-idle-interrupt").at(-1)?.id ?? null,
        });
        yield* commitDelivery({
          id: "leading-idle-interrupt:prompt",
          sessionId: "leading-idle-interrupt",
          kind: "prompt",
          content: "run afterward",
          origin: { encodingVersion: 1, value: { source: "test" } },
          createdAt: now + 1,
          parentActionId: tree("leading-idle-interrupt").at(-1)?.id ?? null,
        });

        yield* awaitSignal(reactivate("leading-idle-interrupt", runner));

        expect(inputs).toHaveLength(1);
        expect(inputs[0]?.resumeCount).toBe(0);
        expect(inputs[0]?.messages).toEqual([
          {
            id: deliveryRows("leading-idle-interrupt").find((row) => row.kind === "prompt")?.id,
            role: "user",
            text: "run afterward",
          },
        ]);
      }),
    ));

  test("consumes a running interrupt and seals interrupted rather than error", () =>
    testProgram(
      Effect.gen(function* () {
        const ready = signal<AbortSignal>();
        const aborted = signal<void>();
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.gen(function* () {
            input.signal.addEventListener(
              "abort",
              () => {
                aborted.resolve();
              },
              { once: true },
            );
            ready.resolve(input.signal);
            yield* awaitSignal(aborted.promise);
            return { kind: "result", text: "late result must not commit" };
          });
        const handle = yield* declare(residentOptions("interrupt", runner));

        const running = yield* Effect.forkChild(handle.prompt("start"));
        const runnerSignal = yield* awaitSignal(
          bounded(ready.promise, "interrupt listener installation"),
        );
        const interrupted = yield* Effect.forkChild(handle.interrupt());
        yield* awaitSignal(bounded(aborted.promise, "runner abort"));
        yield* awaitSignal(
          bounded(
            Effect.all([awaitSignal(running), awaitSignal(interrupted)], {
              concurrency: "unbounded",
            }),
            "interrupted terminal",
          ),
        );

        expect(runnerSignal.aborted).toBe(true);
        expect(deliveryRows(handle.id).map((row) => row.status)).toEqual(["consumed", "consumed"]);
        expect(terminals(handle.id)).toHaveLength(1);
        expect(terminals(handle.id)[0]?.kind).toBe("interrupted");
        expect(handle.get().state).toBe("interrupted");
      }),
    ));
});
