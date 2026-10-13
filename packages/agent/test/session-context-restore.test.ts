import { sessionTree } from "./helpers/session-tree";
import { allowConfigure, isolatedRuntime, type SessionFixture as SessionRuntime, type SessionFixture, withSessionServices } from "./helpers/session-services";
import { describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { seedPolicy as seed } from "./helpers/seed-policy";
import { nth } from "./helpers/nth";
import { answerThenCompact } from "./helpers/effect-g2";
import { isolated, isolatedLedger } from "./helpers/isolated";

import type { LedgerAction, Message, PlainObject } from "@openomni/protocol";
import { createTurnDispatcher } from "../src/plugins/tool";
import type { SessionRunner } from "../src/core/run";
import { Bus } from "./helpers/bus";
import { session } from "../src/testing/registry";
import type { SessionHandle, SessionRunnerInput } from "../src/core/run";
import { foldSessionHistory } from "../src/inspect/history";

let nextId = 0;
function runtime(): SessionRuntime {
  return {
    authorizeConfigure: allowConfigure,
    observations: Bus,
    clock: () => 1_000,
    entropy: () => `restore-id-${++nextId}`,
    processId: "restore-test",
    ...isolatedRuntime(),
  };
}
function intentRecord(action: LedgerAction.Node): PlainObject {
  const value = action.intent.value;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
function compactionIntent(
  actions: readonly LedgerAction.Node[],
): LedgerAction.Node {
  const found = actions.find(
    (action: LedgerAction.Node) =>
      action.kind === "compaction" &&
      intentRecord(action).phase === "intent" &&
      intentRecord(action).op === "compact",
  );
  if (found === undefined) throw new Error("missing compaction intent");
  return found;
}
function program<E>(
  body: (
    handle: SessionHandle,
    before: readonly LedgerAction.Node[],
  ) => Effect.Effect<void, E>,
  rows: NonNullable<Parameters<typeof seed>[0]> = [],
) {
  return Effect.scoped(
    Effect.gen(function* () {
      seed(rows);

      const current = runtime();
      const compactingRunner: SessionRunner = (input: SessionRunnerInput) => Effect.gen(function* () {
        const { executor } = yield* createTurnDispatcher(input, current);
        return yield* answerThenCompact(executor, input);
      });
      const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = current; return yield* withSessionServices(session({ id: "ctx", role: "resident", runner: compactingRunner }, fixture), fixture); });
      yield* handle.prompt("hello");
      const before = sessionTree(isolatedLedger().kernel, "ctx");
      yield* body(handle, before);
    }),
  );
}

describe("restore_context_projection", () => {
  test("folding minus a selected subtree is a no-I/O what-if, not a live restoration", () => isolated(
    program((_handle, before) => Effect.sync(() => {
      const selected = compactionIntent(before);
      const excluded = new Set([selected.id]);
      const retained = before.filter((action) => {
        if (action.parentId !== null && excluded.has(action.parentId)) excluded.add(action.id);
        return !excluded.has(action.id);
      });
      const original = structuredClone([...before]);
      const expected = foldSessionHistory("ctx", before.slice(0, before.indexOf(selected)));
      const kernel = isolatedLedger().kernel;
      // The Storage singleton is gone; the what-if fold must touch neither the
      // kernel's read plane nor its commit plane.
      const reads = spyOn(kernel, "historyPage").mockImplementation(() => { throw new Error("what-if storage access"); });
      const writes = spyOn(kernel, "commit").mockImplementation(() => { throw new Error("what-if storage access"); });
      const publication = spyOn(Bus, "publish").mockImplementation(() => { throw new Error("what-if publication"); });
      try {
        expect(foldSessionHistory("ctx", retained)).toEqual(expected);
        expect(reads).not.toHaveBeenCalled();
        expect(writes).not.toHaveBeenCalled();
        expect(publication).not.toHaveBeenCalled();
        expect(before).toEqual(original);
      } finally {
        reads.mockRestore();
        writes.mockRestore();
        publication.mockRestore();
      }
      expect(sessionTree(isolatedLedger().kernel, "ctx")).toEqual(original);
    })),
  ));

  test("appends the typed compensation, restores the prior projection and leaves the compaction intact", () =>
    isolated(
      program((handle: SessionHandle, before: readonly LedgerAction.Node[]) =>
        Effect.gen(function* () {
          const compaction = compactionIntent(before);
          expect(
            foldSessionHistory("ctx", before).map((entry: Message.WithParts) => entry.info.role),
          ).toEqual(["assistant"]);
          const outcome = yield* handle.restoreContext(compaction.id);
          expect(outcome.terminal).toBe("executed");
          const after = sessionTree(isolatedLedger().kernel, "ctx");
          expect(after.slice(0, before.length)).toEqual([...before]);
          const appended = after.slice(before.length);
          expect(
            appended.map((action: LedgerAction.Node) => [
              action.kind,
              action.parentId,
            ]),
          ).toEqual([
            ["policy.decision", compaction.id],
            ["compaction", compaction.id],
            ["policy.decision", compaction.id],
            ["compaction", nth(appended, 1).id],
            ["fold.checkpoint", nth(appended, 3).id],
          ]);
          expect(nth(appended, 0).intent.value).toMatchObject({
            hook: "compaction.pre",
            op: "restore_context_projection",
          });
          expect(nth(appended, 1).intent.value).toMatchObject({
            op: "restore_context_projection",
            value: { compactionId: compaction.id },
            recovery: "local_transactional",
          });
          expect(nth(appended, 3).effect.value).toMatchObject({
            terminal: "executed",
            result: {
              restored: {
                compactionId: compaction.id,
                discarded: { count: 1 },
              },
            },
          });
          expect(
            foldSessionHistory("ctx", after).map((entry: Message.WithParts) => entry.info.role),
          ).toEqual(["user", "assistant"]);
          expect(foldSessionHistory("ctx", after)).toEqual(
            foldSessionHistory(
              "ctx",
              before.slice(0, before.indexOf(compaction)),
            ),
          );
          // No release plane: the adopted fence owner stays durable.
          expect(isolatedLedger().kernel.row("ctx").fenceOwner).not.toBeNull();
          expect(handle.inspect().compactions).toEqual([
            expect.objectContaining({
              compactionId: compaction.id,
              restoredBy: [nth(appended, 1).id],
            }),
          ]);
        }),
      ),
    ));

  test("a refused restoration records only the policy decision and changes nothing", () =>
    isolated(
      program(
        (handle: SessionHandle, before: readonly LedgerAction.Node[]) =>
          Effect.gen(function* () {
            const outcome = yield* handle.restoreContext(
              compactionIntent(before).id,
            );
            expect(outcome).toEqual({
              terminal: "blocked_pre",
              reason: "pinned_projection",
            });
            const after = sessionTree(isolatedLedger().kernel, "ctx");
            expect(
              after
                .slice(before.length)
                .map((action: LedgerAction.Node) => action.kind),
            ).toEqual(["policy.decision"]);
            expect(foldSessionHistory("ctx", after)).toEqual(
              foldSessionHistory("ctx", before),
            );
          }),
        // The untouched base-era fixture: restore restrictions once
        // lived on `turn/post` through the retired v3 point mapping.
        // Migration must keep this exact historical row refusing restores.
        [{
          name: "no-restore", kind: "turn", phase: "post",
          match: { encodingVersion: 1, value: { op: "restore_context_projection" } },
          verdict: { encodingVersion: 1, value: { type: "deny", reason: "pinned_projection" } },
          priority: 500,
        }],
      ),
    ));

  test("an unknown or unexecuted compaction is refused before anything is recorded", () =>
    isolated(
      program((handle: SessionHandle, before: readonly LedgerAction.Node[]) =>
        Effect.gen(function* () {
          const compaction = compactionIntent(before);
          const missing = yield* Effect.flip(handle.restoreContext("nope"));
          expect(missing).toMatchObject({
            _tag: "ContextRestoreError",
            reason: "unknown_compaction",
            message: "context restore refused: unknown_compaction",
          });
          // No release plane: the adopted fence owner stays durable.
          expect(isolatedLedger().kernel.row("ctx").fenceOwner).not.toBeNull();
          const result = before.find(
            (action: LedgerAction.Node) =>
              action.kind === "compaction" && action.parentId === compaction.id,
          );
          const unexecuted = yield* Effect.flip(
            handle.restoreContext(result?.id ?? ""),
          );
          expect(unexecuted).toMatchObject({
            _tag: "ContextRestoreError", reason: "not_executed",
            message: "context restore refused: not_executed",
          });
          expect(sessionTree(isolatedLedger().kernel, "ctx")).toEqual([...before]);
          // No release plane: the adopted fence owner stays durable.
          expect(isolatedLedger().kernel.row("ctx").fenceOwner).not.toBeNull();
        }),
      ),
    ));
});
