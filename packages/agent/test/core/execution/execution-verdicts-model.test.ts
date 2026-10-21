import { testExecutor } from "../../helpers/executor";
import { KERNEL_POLICY_REGISTRY } from "../../../src/core/gate/compile";
import { Effect, Fiber } from "effect";
import { isolated } from "../../helpers/isolated";
import { describe, expect, it, mock } from "bun:test";
import { recordingLedger, runTestOperation, failure as effectFailure, foreign, } from "../../helpers/effect-g2";
import { compilePolicySnapshot } from "../../../src/core/gate/compile";
import { ToolBodyFailed } from "../../../src/core/ports/failure";
import type { LedgerAction, PlainValue, PolicyRow } from "@oni/protocol";

const kinds = ["prompt", "turn", "llm", "tool"] as const;

function row(
  name: string,
  kind: (typeof kinds)[number],
  phase: PolicyRow.Phase,
  verdict: PlainValue,
  priority = 0,
): PolicyRow.Row {
  return {
    name,
    kind,
    phase,
    match: { encodingVersion: 1, value: { op: "test" } },
    verdict: { encodingVersion: 1, value: verdict },
    priority,
    generation: 1,
  };
}

const mandatory: PolicyRow.Row = {
  ...row("compaction", "turn", "post", { type: "allow" }),
  match: { encodingVersion: 1, value: { op: "compaction" } },
};

function harness(rows: readonly PolicyRow.Row[]) {
  const { committed: actions, ledger } = recordingLedger();
  const executor = testExecutor({
    policy: compilePolicySnapshot({
      registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      rows: [mandatory, ...rows],
      mandatory: ["compaction"],
    }),
    ledger,
    observations: { publish: () => undefined },
    identity: { sessionId: "session-1", role: "resident", parentActionId: null },
    clock: () => 100,
    entropy: (() => {
      let value = 0;
      return () => `action-${++value}`;
    })(),
    random: () => 0,
  });
  return { actions, executor };
}

/** Runs the unregistered `channel.send` kind through `executor` and asserts the typed admit refusal. */
function* refusedForeignKind(executor: ReturnType<typeof harness>["executor"], body: ReturnType<typeof okBody>) {
  const refused = executor.run(
    { kind: "channel.send", op: "test", intent: {}, effect: {} },
    body,
  );
  expect(yield* effectFailure(refused)).toMatchObject({
    _tag: "AgentFailure",
    operation: "executor.admit",
    cause: "unregistered_execution_kind:channel.send",
  });
}

/** Body double returning the canonical success payload; call counts stay assertable. */
function okBody() {
  return mock(() =>
    Effect.sync(() => {
      return { ok: true };
    }),
  );
}

/** Reverter double recording invocations for post-deny dispositions. */
function revertBody() {
  return mock(() =>
    Effect.sync(() => {
      return undefined;
    }),
  );
}

/** The compiled snapshot holding only the mandatory compaction row. */
function mandatoryOnlyPolicy() {
  return compilePolicySnapshot({
    registry: KERNEL_POLICY_REGISTRY,
    generation: 1,
    rows: [mandatory],
    mandatory: ["compaction"],
  });
}

/** Harness whose only extra row post-denies the given kind. */
function postDenyHarness(kind: (typeof kinds)[number], name = `deny-${kind}-post`) {
  return harness([row(name, kind, "post", { type: "deny", reason: "post blocked" })]);
}

type Executor = ReturnType<typeof harness>["executor"];
type RunRequest = Parameters<Executor["run"]>[0];

/** One "test" operation whose handler reports success; extras add revert/boundary. */
function runTestSuccess(
  executor: Executor,
  kind: (typeof kinds)[number],
  extras: Partial<RunRequest> = {},
) {
  return executor.run(
    { kind, op: "test", intent: { requested: true }, effect: { completed: true }, ...extras },
    () =>
      Effect.sync(() => {
        return { ok: true };
      }),
  );
}

function resultEffects(actions: readonly LedgerAction.Append[], kind: LedgerAction.Kind) {
  return actions
    .filter((action: import("@oni/protocol").LedgerAction.Append) => action.kind === kind)
    .map((action: import("@oni/protocol").LedgerAction.Append) => action.effect.value)
    .filter((effect: import("@oni/protocol").PlainValue) =>
      typeof effect === "object" && effect !== null && !Array.isArray(effect)
        ? effect.phase === "result"
        : false,
    );
}

describe("the single L2 executor's four-kind verdict model", () => {
  it("refuses an unregistered kind with a typed error before policy or body", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const { actions, executor } = harness([]);
          const body = okBody();

          yield* refusedForeignKind(executor, body);
          expect(body).toHaveBeenCalledTimes(0);
          expect(actions).toHaveLength(0);
        }),
      ),
    ));

  it("admits exactly the registered core kinds — no extension injection seam", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          // The executor's kind table is the real registered set; a
          // foreign kind is refused typed before policy or body, and there is
          // no production option that widens the table for tests.
          const { actions, executor } = harness([]);
          const body = okBody();

          yield* refusedForeignKind(executor, body);

          const admitted = yield* executor.run(
            { kind: "tool", op: "test", intent: { requested: true }, effect: { completed: false } },
            body,
          );
          expect(admitted).toMatchObject({ terminal: "executed" });
          expect(body).toHaveBeenCalledTimes(1);
          // The admitted run records its real pre and post policy decisions;
          // the refused kind recorded nothing.
          expect(
            actions.filter((action: import("@oni/protocol").LedgerAction.Append) => action.kind === "policy.decision"),
          ).toHaveLength(2);
        }),
      ),
    ));

  it("passes the committed intent receipt to the body after its commit resolves", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const intentCommitReached = Promise.withResolvers<void>();
          const releaseIntentCommit = Promise.withResolvers<void>();
          let revision = 0;
          let committedIntent: LedgerAction.Receipt | undefined;
          let bodyIntent: LedgerAction.Receipt | undefined;
          const body = mock((intent: LedgerAction.Receipt) =>
            Effect.sync(() => {
              bodyIntent = intent;
              return { ok: true };
            }),
          );
          const executor = testExecutor({
            policy: mandatoryOnlyPolicy(),
            ledger: {
              commit(action: import("@oni/protocol").LedgerAction.Append) {
                return Effect.gen(function* () {
                  const isIntent = action.kind === "llm" && committedIntent === undefined;
                  if (isIntent) {
                    intentCommitReached.resolve();
                    yield* Effect.promise(() => releaseIntentCommit.promise);
                  }
                  revision += 1;
                  const receipt = {
                    action: {
                      ...action,
                      ordinal: revision,
                      prevHash: "fixture-prev",
                      actionHash: "fixture-hash",
                    },
                    revision,
                  } satisfies LedgerAction.Receipt;
                  if (isIntent) committedIntent = receipt;
                  return receipt;
                });
              },
            },
            observations: { publish: () => undefined },
            identity: {
              sessionId: "session-1",
              role: "resident",
              parentActionId: "turn-intent-1",
            },
            clock: () => 100,
            entropy: () => `receipt-${revision + 1}`,
            random: () => 0,
          });

          const running = yield* Effect.forkScoped(
            executor.run({ kind: "llm", op: "test", intent: {}, effect: {} }, body),
          );
          yield* Effect.promise(() => intentCommitReached.promise).pipe(
            Effect.timeout("5 seconds"),
          );
          expect(body).toHaveBeenCalledTimes(0);

          releaseIntentCommit.resolve();
          yield* Fiber.join(running);

          expect(body).toHaveBeenCalledTimes(1);
          expect(bodyIntent).toBe(committedIntent);
          expect(bodyIntent?.action.parentId).toBe("turn-intent-1");
        }),
      ),
    ));

  it("fails closed when a transform removes the result envelope", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const { actions, executor } = harness([
            row("remove-result", "tool", "post", {
              type: "transform",
              name: "redact",
              paths: ["result"],
            }),
          ]);

          const result = yield* executor.run(
            { kind: "tool", op: "test", intent: {}, effect: {} },
            () =>
              Effect.sync(() => {
                return { ok: true };
              }),
          );

          expect(result).toMatchObject({ terminal: "blocked_post", reason: "invalid_output" });
          expect(resultEffects(actions, "tool")).toEqual([
            expect.objectContaining({ terminal: "blocked_post", reason: "invalid_output" }),
          ]);
        }),
      ),
    ));

  it("commits a linked failed result carrying the typed body failure", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const { actions, executor } = harness([]);
          const failure = foreign("test", new TypeError("body failed"));

          const outcome = yield* effectFailure(
            executor.run(
              {
                kind: "tool",
                op: "test",
                intent: { requested: true },
                effect: { completed: false },
              },
              () => Effect.fail(failure),
            ),
          );
          expect(outcome).toBe(failure);

          expect(
            actions.map((action: import("@oni/protocol").LedgerAction.Append) => action.kind),
          ).toEqual(["policy.decision", "tool", "tool"]);
          const intent = actions[1];
          const result = actions[2];
          expect(result?.parentId).toBe(intent?.id);
          expect(result?.effect.value).toMatchObject({
            phase: "result",
            terminal: "executed",
            effect: { completed: false },
            evidence: {
              failures: [{ tag: "AgentFailure", operation: "test" }],
              defects: [],
              interrupted: false,
            },
          });
        }),
      ),
    ));

  // A structured Error cause on the typed body failure journals as the
  // stable `name: message` text — the Error object never reaches the journal.
  it("renders a structured Error body-failure cause as stable journal text", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const { actions, executor } = harness([]);
          const failure = new ToolBodyFailed({ tool: "test", cause: new RangeError("deep failure") });

          const outcome = yield* effectFailure(
            executor.run(
              { kind: "tool", op: "test", intent: { requested: true }, effect: { completed: false } },
              () => Effect.fail(failure),
            ),
          );
          expect(outcome).toBe(failure);
          const result = actions[2];
          expect(result?.effect.value).toMatchObject({
            phase: "result",
            terminal: "executed",
            evidence: {
              failures: [{ tag: "ToolBodyFailed", tool: "test", cause: "RangeError: deep failure" }],
              defects: [],
              interrupted: false,
            },
          });
        }),
      ),
    ));

  for (const kind of kinds) {
    it(`${kind}: pre deny commits no intent/result and never calls body`, () =>
      isolated(
        Effect.scoped(
          Effect.gen(function* () {
            const { actions, executor } = harness([
              row(`deny-${kind}-pre`, kind, "pre", { type: "deny", reason: "pre blocked" }),
            ]);
            const body = okBody();

            const result = yield* runTestOperation(executor, kind, body);

            expect(result).toMatchObject({ terminal: "blocked_pre", reason: "pre blocked" });
            expect(body).toHaveBeenCalledTimes(0);
            expect(
              actions.filter(
                (action: import("@oni/protocol").LedgerAction.Append) => action.kind === kind,
              ),
            ).toHaveLength(0);
            expect(resultEffects(actions, kind)).toHaveLength(0);
          }),
        ),
      ));

    it(`${kind}: allow commits intent/result and calls body exactly once`, () =>
      isolated(
        Effect.scoped(
          Effect.gen(function* () {
            const { actions, executor } = harness([]);
            const body = okBody();

            const result = yield* runTestOperation(executor, kind, body);

            expect(result).toMatchObject({ terminal: "executed", value: { ok: true } });
            expect(body).toHaveBeenCalledTimes(1);
            expect(
              actions.filter(
                (action: import("@oni/protocol").LedgerAction.Append) => action.kind === kind,
              ),
            ).toHaveLength(2);
            expect(resultEffects(actions, kind)).toEqual([
              expect.objectContaining({ phase: "result", terminal: "executed" }),
            ]);
          }),
        ),
      ));
  }

  // Prompt has no registered post point: a generation carrying a
  // prompt post row cannot even compile — the registry rejects it fail-closed.
  it("prompt: a post deny row rejects at compose — the post point is not registered", () => {
    expect(() => postDenyHarness("prompt")).toThrow(
      expect.objectContaining({
        data: expect.objectContaining({
          code: "compose_rejected",
          composeCode: "unknown_point",
          kind: "prompt.post",
        }),
      }),
    );
  });

  for (const kind of ["turn", "llm", "tool"] as const) {
    it(`${kind}: post deny reverts when a reverter exists`, () =>
      isolated(
        Effect.scoped(
          Effect.gen(function* () {
            const { actions, executor } = postDenyHarness(kind);
            const revert = revertBody();

            const result = yield* runTestSuccess(executor, kind, { revert });

            expect(result).toMatchObject({
              terminal: "blocked_post",
              disposition: "reverted",
              reason: "post blocked",
            });
            expect(revert).toHaveBeenCalledTimes(1);
            expect(resultEffects(actions, kind)).toEqual([
              expect.objectContaining({
                phase: "result",
                terminal: "blocked_post",
                disposition: "reverted",
              }),
            ]);
          }),
        ),
      ));

    it(`${kind}: post deny records irreversible when no reverter exists`, () =>
      isolated(
        Effect.scoped(
          Effect.gen(function* () {
            const { actions, executor } = postDenyHarness(kind);

            const result = yield* runTestSuccess(executor, kind);

            expect(result).toMatchObject({
              terminal: "blocked_post",
              disposition: "irreversible",
              reason: "post blocked",
            });
            expect(resultEffects(actions, kind)).toEqual([
              expect.objectContaining({
                phase: "result",
                terminal: "blocked_post",
                disposition: "irreversible",
              }),
            ]);
          }),
        ),
      ));
  }
});

describe("the durable boundary child action commits only for executed outcomes", () => {
  const boundaryChildren = (actions: readonly LedgerAction.Append[]) =>
    actions.filter((action: import("@oni/protocol").LedgerAction.Append) =>
      action.id.endsWith(":boundary"),
    );

  it("an executed boundary request commits exactly one boundary child under its intent", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const { actions, executor } = harness([]);

          const result = yield* runTestSuccess(executor, "tool", { boundary: true });

          expect(result).toMatchObject({ terminal: "executed", value: { ok: true } });
          const children = boundaryChildren(actions);
          expect(children).toHaveLength(1);
          const child = children[0];
          const intent = actions.find(
            (action: import("@oni/protocol").LedgerAction.Append) =>
              `${action.id}:boundary` === child?.id,
          );
          expect(child?.parentId).toBe(intent?.id);
          expect(child?.kind).toBe("tool");
          expect(child !== undefined && "irreversible" in child && child.irreversible).toBe(true);
          expect(child?.effect?.value).toMatchObject({ phase: "boundary", result: { ok: true } });
        }),
      ),
    ));

  it("a post-denied boundary request commits NO boundary child: recovery must never resurrect a reverted outcome as executed", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const { actions, executor } = postDenyHarness("tool", "deny-boundary-post");
          const revert = revertBody();

          const result = yield* runTestSuccess(executor, "tool", { boundary: true, revert });

          expect(result).toMatchObject({
            terminal: "blocked_post",
            disposition: "reverted",
            reason: "post blocked",
          });
          expect(revert).toHaveBeenCalledTimes(1);
          expect(boundaryChildren(actions)).toEqual([]);
          expect(resultEffects(actions, "tool")).toEqual([
            expect.objectContaining({ phase: "result", terminal: "blocked_post" }),
          ]);
        }),
      ),
    ));
});
