import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { createDispatcher, createTurnDispatcher } from "../../src/plugins/tool";
import { defineTool } from "../../src/core/tool";
import type { Executor } from "../../src/core/gate/decide";
import type { AnyToolDefinition, LedgerAction } from "@openomni/protocol";
import { recordingLedger } from "../../test/helpers/recording-ledger";
import { runAgentSync } from "../helpers/executor";
import { catalogLayer } from "../helpers/service-layers";
import { recordingExecutor } from "../helpers/effect-g2";
import { valueTool } from "../helpers/query-tool";
import { isolated } from "../helpers/isolated";
import { TEST_APPROVAL_POLICY } from "../helpers/approval-policy";

const context = { sessionId: "session-1", turnId: "turn-1" };
const call = { id: "call-1", tool: "echo", input: { value: "input" } };
const echoOk = () => valueTool({ name: "echo", description: "Echo a value", execute: async () => "ok" });

/** Builds the plugin dispatcher over `executor` with `tool` as its only catalog entry and executes `call`. */
function dispatchEcho(executor: Executor, tool: AnyToolDefinition) {
  const dispatch = runAgentSync(
    createDispatcher({ executor }).pipe(Effect.provide(catalogLayer([tool]))),
  );
  return dispatch.execute(call, context);
}

describe("plugins/tool dispatcher export (#1316)", () => {
  it("builds a dispatcher through the plugin export and records the dispatched tool action", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const recording = recordingExecutor();
          const result = yield* dispatchEcho(recording.executor, echoOk());
          expect(result).toMatchObject({ id: call.id, toolName: "echo", content: "ok" });
          expect(result.isError).toBeUndefined();
          expect(recording.committed.some((action) => action.kind === "tool")).toBe(true);
        }),
      ),
    ));

  it("maps an executor value that is not a tool-body outcome to invalid_output", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const bogus: Executor = {
            run: () => Effect.succeed({ terminal: "executed", value: { bogus: true } }),
            runBatch: (items) =>
              Effect.succeed(items.map(() => ({ terminal: "executed" as const, value: { bogus: true } }))),
          };
          const result = yield* dispatchEcho(bogus, echoOk());
          expect(result).toMatchObject({ isError: true, errorKind: "invalid_output", content: "echo produced invalid output" });
        }),
      ),
    ));

  it("fails closed when the output transform produces a non-plain value", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const recording = recordingExecutor();
          const result = yield* dispatchEcho(
            recording.executor,
            defineTool({
              name: "echo",
              description: "Echo a value",
              category: "query",
              input: z.object({ value: z.string() }).strict(),
              // First pass (body decode) maps "ok" -> "first" (plain); the dispatcher's
              // second pass maps "first" -> undefined, a non-plain final value.
              output: z.string().transform((value): string | undefined => (value === "ok" ? "first" : undefined)),
              visibility: { model: ["resident"], cell: ["resident"] },
              execute: async () => "ok",
              render: () => "rendered",
            }),
          );
          expect(result).toMatchObject({ isError: true, errorKind: "invalid_output", content: "echo produced invalid output" });
        }),
      ),
    ));

  it("pages guarded operations past a full 256-row page during turn recovery", () =>
    isolated(
      Effect.gen(function* () {
        const payload = { encodingVersion: 1 as const, value: null };
        const node = (ordinal: number): LedgerAction.Node => ({
          id: `node-${ordinal}`,
          parentId: null,
          sessionId: "session-1",
          kind: "turn",
          intent: payload,
          effect: payload,
          revert: payload,
          ts: 1,
          ordinal,
          prevHash: "",
          actionHash: "",
        });
        const cursors: number[] = [];
        const fullPage = Array.from({ length: 256 }, (_, index) => node(index + 1));
        const recording = recordingLedger();
        const dispatcher = yield* createTurnDispatcher(
          {
            sessionId: "session-1",
            role: "resident",
            actionId: "turn-1",
            ledger: {
              ...recording.ledger,
              guardedOperationsPage: (_turnId, cursor) => {
                cursors.push(cursor);
                return cursor === 0 ? fullPage : [];
              },
            },
          },
          { approvalPolicy: TEST_APPROVAL_POLICY },
        ).pipe(Effect.provide(catalogLayer([
          valueTool({ name: "echo", description: "Echo a value", execute: async () => "ok" }),
        ])));
        yield* dispatcher.executor.recover();
        expect(cursors).toEqual([0, 256]);
      }),
    ));
});
