import { APPROVAL_POLICY } from "../src/bundles/approval-policy/index";
import { testToolPorts } from "./helpers/tool-ports";
import { executorLayer, catalogLayer } from "../../../packages/agent/test/helpers/service-layers";
import { runnerTestLayer } from "../../../packages/agent/test/helpers/isolated";
import { Effect, Layer } from "effect";
import { acquireEffect, runEffect, acquireSyncEffect } from "./helpers/scoped-effect";
import { expect, test } from "bun:test";
import { Bundle, Core } from "@openomni/agent";
const createTurnDispatcher = Bundle.createTurnDispatcher;
const currentInvocation = Core.currentInvocation;
import { createCodemode } from "@openomni/codemode";
import { attachMachineDaemon, createMachineHost, type MachinesFailure } from "@openomni/machines";
import { LedgerAction, type Machine, type PlainObject } from "@openomni/protocol";
import { z } from "zod";
import { cellPorts } from "./helpers/cell-ports";
import { composeCodemode } from "../src/composition/codemode";
import { catalogDefinitions } from "../src/composition/catalog";
import { cellDaemonOptions } from "./helpers/cell-daemon";
import { fixtureHashes } from "../../../packages/agent/test/helpers/compiled-policy";
import { seededPolicy } from "./helpers/executor";
import { bounded } from "./helpers/protected-dispatch";
import { residentSuite } from "./helpers/resident-suite";
import { socketPath } from "./helpers/socket-path";
import { testIds } from "./helpers/test-entropy";

const suite = residentSuite();
const ActionPhase = z.object({ op: z.string(), phase: z.string() });

for (const stop of [false, true]) {
  test(`background completion retains generation until settlement; stop=${stop}`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<
      { result: Machine.ToolCallResult } | { error: Error }
    >();
    const actions: LedgerAction.Node[] = [];
    let nextId = 0;
    const origin = { role: "resident", sessionId: `completion-${stop}` } as const;
    // Only storage IO is replaced: real policy, record construction and settlement execute.
    const ledger: Parameters<typeof createTurnDispatcher>[0]["ledger"] = {
        commit(append: LedgerAction.Append) {
          const ordinal = actions.length + 1;
          const action = LedgerAction.Node.parse({ ...append, ordinal, ...fixtureHashes(ordinal) });
          actions.push(action);
          return Effect.succeed({ action, revision: action.ordinal });
        },
      };
    const path = socketPath();
    let cells: Effect.Success<ReturnType<typeof composeCodemode>>;
    const host = await acquireEffect(createMachineHost({
      dispatcherBound: 8,
      listen: { unix: path },
      id: testIds("lifetime-host"),
      enrollment: (machineId: string) => ({
        machineId,
        name: "completion-test",
        allowedCapabilities: ["kernel.py"],
        publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        enrolledAt: 0,
      }),
      events: { publish: () => undefined },
      now: () => 1,
      // callTool already surfaces a MachinesFailure({ operation: "code.tool" }).
      callTool: (call: Machine.ToolCall) => cells.callTool(call).pipe(
        Effect.tap((result: Machine.ToolCallResult) => Effect.sync(() => completed.resolve({ result }))),
        Effect.tapError((error: MachinesFailure) => Effect.sync(() => completed.resolve({ error }))),
      ),
    }));
    suite.defer(async () => { await runEffect(host.close()); });
    const daemon = await acquireEffect(attachMachineDaemon({
      ...cellDaemonOptions(path, "completion-test"),
      runner: acquireSyncEffect(createCodemode({ id: testIds("lifetime-cell") })).runner,
    }));
    suite.defer(async () => { await runEffect(daemon.close()); });
    expect(daemon.attachment.status).toBe("attached");
    cells = acquireSyncEffect(composeCodemode(host, { id: testIds("lifetime-compose") }));
    suite.defer(async () => { await runEffect(cells.close()); });
    let calls = 0;
    const definitions = catalogDefinitions(
      { ...testToolPorts,
        cells: cellPorts(cells),
        llm: async () => {
          expect(currentInvocation().policy).toBe(seededPolicy);
          calls += 1;
          entered.resolve();
          await release.promise;
          return "late";
        },
      },
    );
    const runnerServices = acquireSyncEffect(Layer.build(runnerTestLayer));
    const dispatcher = acquireSyncEffect(createTurnDispatcher({
      sessionId: origin.sessionId, role: origin.role, actionId: "completion-turn", ledger,
    }, { approvalPolicy: APPROVAL_POLICY }).pipe(Effect.provide(catalogLayer(definitions)), Effect.provide(executorLayer({ policy: seededPolicy, observations: { publish: () => undefined }, clock: () => 1, entropy: () => `${origin.sessionId}-${++nextId}` })), Effect.provide(runnerServices)));
    let nextCall = 0;
    const execute = (operation: PlainObject) =>
      bounded(
        runEffect(dispatcher.execute(
          { id: `eval-${++nextCall}`, tool: "eval", input: { operation } },
          { sessionId: origin.sessionId, turnId: "completion-turn" },
        )),
      );
    const toolActions = (op: string, phase: string) =>
      actions.filter((action: LedgerAction.Node) => {
        const intent = ActionPhase.safeParse(action.intent.value);
        return (
          action.kind === "tool" &&
          intent.success &&
          intent.data.op === op &&
          intent.data.phase === phase
        );
      });

    try {
      // The one-second wait is eval's public background-run boundary, not a polling delay;
      // the interpreter is warmed first so a cold start cannot stand in for that boundary.
      expect((await execute({ op: "run", code: "0", timeout: 15 })).content).toBe("0");
      const running = execute({
        op: "run",
        code: "print('started')\nanswer = completion('hold')\nanswer",
        timeout: 1,
      });
      await bounded(entered.promise);
      const started = await running;
      expect(started.isError).toBeUndefined();
      const cellId = /^cell (\S+) is still running; peek or stop it by cell_id\nstarted\n$/.exec(
        started.content,
      )?.[1];
      if (cellId === undefined) throw new Error(`expected running cell: ${started.content}`);
      expect(toolActions("completion", "intent")).toHaveLength(1);
      expect(toolActions("completion", "result")).toHaveLength(0);

      if (stop) {
        expect((await execute({ op: "stop", cell_id: cellId })).content).toBe(
          "the cell was stopped\nstarted\n",
        );
        expect((await execute({ op: "peek", cell_id: cellId })).isError).toBe(true);
      }
      // A detached cell keeps authority; stopping it revokes the pending call.
      release.resolve();
      const completion = await bounded(completed.promise);
      if (stop) {
        expect(completion).toMatchObject({ error: { _tag: "MachinesFailure", operation: "code.tool" } });
      } else {
        expect(completion).toEqual({ result: { status: "completed", value: "late" } });
      }
      // Same-tenant execution is a barrier for the Python result/late-answer handling.
      expect((await execute({ op: "run", code: "6 * 7", timeout: 15 })).content).toBe("42");
      if (stop) {
        expect(
          (await execute({ op: "run", code: "'answer' in globals()", timeout: 15 })).content,
        ).toBe("False");
        expect((await execute({ op: "peek", cell_id: cellId })).isError).toBe(true);
      } else {
        expect((await execute({ op: "peek", cell_id: cellId })).content).toBe("'late'");
        expect((await execute({ op: "peek", cell_id: cellId })).isError).toBe(true);
      }
      const intents = toolActions("completion", "intent");
      const results = toolActions("completion", "result");
      expect(intents).toHaveLength(1);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        parentId: intents[0]?.id,
        sessionId: origin.sessionId,
        effect: { value: stop
          ? { terminal: "interrupted", reason: "fiber_interrupted" }
          : { terminal: "executed", result: { status: "success", output: "late" } } },
      });
      expect(
        actions
          .filter(
            (action: LedgerAction.Node) =>
              action.kind === "policy.decision" &&
              z.object({ op: z.literal("completion") }).safeParse(action.intent.value).success,
          )
          .map((action: LedgerAction.Node) => z.object({ hook: z.string() }).parse(action.intent.value).hook),
      ).toEqual(stop ? ["tool.pre"] : ["tool.pre", "tool.post"]);
      expect(actions.every((action: LedgerAction.Node) => action.sessionId === origin.sessionId)).toBe(true);
      expect(calls).toBe(1);
    } finally {
      release.resolve();
    }
  }, 15_000);
}
