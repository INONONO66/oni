import { APPROVAL_POLICY } from "../src/composition/policy";
import { expect, test } from "bun:test";
import { Cause, Effect, Layer } from "effect";
import { Bundle } from "@oni/agent";
const createTurnDispatcher = Bundle.createTurnDispatcher;
import { createCodemode } from "@oni/codemode";
import { attachMachineDaemon, createMachineHost, createMemoryGenerationStore, MachinesFailure } from "@oni/machines";
import { LedgerAction, type Machine } from "@oni/protocol";
import { catalogLayer, executorLayer } from "../../../packages/agent/test/helpers/service-layers";
import { runnerTestLayer } from "../../../packages/agent/test/helpers/isolated";
import { composeCodemode } from "../src/composition/codemode";
import { cellPorts } from "./helpers/cell-ports";
import { cellDaemonOptions } from "./helpers/cell-daemon";
import { acquireEffect, acquireSyncEffect, runEffect } from "./helpers/scoped-effect";
import { seededPolicy } from "./helpers/executor";
import { residentSuite } from "./helpers/resident-suite";
import { socketPath } from "./helpers/socket-path";
import { bundleTools, testToolPorts } from "./helpers/tool-ports";
import { testIds } from "./helpers/test-entropy";

const suite = residentSuite();

test("two cells in one turn each own a full completion budget", async () => {
  const path = socketPath();
  let cells: Effect.Success<ReturnType<typeof composeCodemode>>;
  const cellCalls = new Map<string, number>();
  const host = await acquireEffect(createMachineHost({
    generations: createMemoryGenerationStore(),
    dispatcherBound: 8,
    listen: { unix: path },
    id: testIds("budget-host"),
    scheduler: { schedule: () => () => undefined },
    enrollment: (machineId: string) => ({ machineId, name: "budget", allowedCapabilities: ["kernel.py"], publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", enrolledAt: 0 }),
    events: { publish: () => undefined }, now: () => 1,
    callTool: (call: Machine.ToolCall) => Effect.suspend(() => {
      cellCalls.set(call.cellId, (cellCalls.get(call.cellId) ?? 0) + 1);
      // callTool already surfaces a MachinesFailure({ operation: "code.tool" }).
      return cells.callTool(call);
    }),
  }));
  suite.defer(() => runEffect(host.close()));
  const daemon = await acquireEffect(attachMachineDaemon({
    ...cellDaemonOptions(path, "budget"), runner: acquireSyncEffect(createCodemode({ id: testIds("budget-cell") })).runner,
  }));
  suite.defer(() => runEffect(daemon.close()));
  expect(daemon.attachment.status).toBe("attached");
  cells = acquireSyncEffect(composeCodemode(host, { id: testIds("budget-compose"), selfMachineId: "budget" }));
  suite.defer(() => runEffect(cells.close()));
  let completions = 0;
  const definitions = bundleTools({ ...testToolPorts, cells: cellPorts(cells), llm: async () => {
    completions += 1;
    return "answer";
  } });
  const actions: LedgerAction.Node[] = [];
  let sequence = 0;
  const runnerServices = acquireSyncEffect(Layer.build(runnerTestLayer));
  const dispatcher = acquireSyncEffect(createTurnDispatcher({
    sessionId: "budget-session", role: "resident", actionId: "one-turn",
    ledger: { commit: (append: LedgerAction.Append) => {
      const ordinal = actions.length + 1;
      const action = LedgerAction.Node.parse({ ...append, ordinal });
      actions.push(action);
      return Effect.succeed({ action, revision: ordinal });
    } },
  }, { approvalPolicy: APPROVAL_POLICY }).pipe(
    Effect.provide(catalogLayer(definitions)),
    Effect.provide(executorLayer({ policy: seededPolicy, observations: { publish: () => undefined }, clock: () => 1, entropy: () => `budget-${++sequence}` })),
    Effect.provide(runnerServices),
  ));
  const code = [
    "answers = [completion(str(i)) for i in range(32)]",
    "refused = False",
    "try:",
    "    completion('over-budget')",
    "except Exception:",
    "    refused = True",
    "(len(answers), refused)",
  ].join("\n");
  for (const index of [1, 2]) {
    const result = await runEffect(dispatcher.execute({
      id: `cell-${index}`, tool: "eval", input: { operation: { op: "run", code, timeout: 15 } },
    }, { sessionId: "budget-session", turnId: "one-turn" }));
    expect(result.isError, result.content).toBeUndefined();
    expect(result.content).toBe("(32, True)");
    expect(completions).toBe(index * 32);
  }
  expect([...cellCalls.values()]).toEqual([33, 33]);
}, 15_000);

/**
 * #1258: the cell door's `catchDefect` folds ONLY a thrown ToolRefused into
 * the typed failed ToolCallResult; any other defect inside the dispatch (here
 * a result-parse throw on an empty failure text) must keep dying through
 * `callTool`, never surface to the cell as a failed result.
 */
test("a non-ToolRefused defect inside the cell door dies instead of folding to a failed result", async () => {
  const path = socketPath();
  let cells: Effect.Success<ReturnType<typeof composeCodemode>>;
  const causes: Cause.Cause<MachinesFailure>[] = [];
  const settled: Machine.ToolCallResult[] = [];
  const host = await acquireEffect(createMachineHost({
    generations: createMemoryGenerationStore(),
    dispatcherBound: 8,
    listen: { unix: path },
    id: testIds("defect-host"),
    scheduler: { schedule: () => () => undefined },
    enrollment: (machineId: string) => ({ machineId, name: "defect", allowedCapabilities: ["kernel.py"], publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", enrolledAt: 0 }),
    events: { publish: () => undefined }, now: () => 1,
    // The defect is recorded HERE, at the host's callback boundary, then
    // converted to the typed failure so the daemon and cell settle in teardown.
    callTool: (call: Machine.ToolCall) => Effect.suspend(() => cells.callTool(call)).pipe(
      Effect.tap((result: Machine.ToolCallResult) => Effect.sync(() => { settled.push(result); })),
      Effect.catchCause((cause) => {
        causes.push(cause);
        return Effect.fail(new MachinesFailure({ operation: "test.callTool", cause: "recorded" }));
      }),
    ),
  }));
  suite.defer(() => runEffect(host.close()));
  const daemon = await acquireEffect(attachMachineDaemon({
    ...cellDaemonOptions(path, "defect"), runner: acquireSyncEffect(createCodemode({ id: testIds("defect-cell") })).runner,
  }));
  suite.defer(() => runEffect(daemon.close()));
  expect(daemon.attachment.status).toBe("attached");
  cells = acquireSyncEffect(composeCodemode(host, { id: testIds("defect-compose"), selfMachineId: "defect" }));
  suite.defer(() => runEffect(cells.close()));
  let completions = 0;
  const definitions = bundleTools({ ...testToolPorts, cells: cellPorts(cells), llm: () => {
    completions += 1;
    // String("") renders an EMPTY failure text: the dispatch settles as a
    // failed result whose message is "", and the cell door's
    // ToolCallResult.parse (error: min 1) throws a genuine non-ToolRefused
    // defect inside the tools binding.
    return Promise.reject("");
  } });
  let sequence = 0;
  const runnerServices = acquireSyncEffect(Layer.build(runnerTestLayer));
  const dispatcher = acquireSyncEffect(createTurnDispatcher({
    sessionId: "defect-session", role: "resident", actionId: "one-turn",
    ledger: { commit: (append: LedgerAction.Append) => Effect.succeed({
      action: LedgerAction.Node.parse({ ...append, ordinal: sequence }), revision: sequence,
    }) },
  }, { approvalPolicy: APPROVAL_POLICY }).pipe(
    Effect.provide(catalogLayer(definitions)),
    Effect.provide(executorLayer({ policy: seededPolicy, observations: { publish: () => undefined }, clock: () => 1, entropy: () => `defect-${++sequence}` })),
    Effect.provide(runnerServices),
  ));
  const code = [
    "try:",
    "    completion('boom')",
    "    outcome = 'completed'",
    "except Exception as error:",
    "    outcome = type(error).__name__",
    "outcome",
  ].join("\n");
  const exit = await runEffect(Effect.exit(dispatcher.execute({
    id: "cell-defect", tool: "eval", input: { operation: { op: "run", code, timeout: 3 } },
  }, { sessionId: "defect-session", turnId: "one-turn" })));
  // The completion dispatch died through the cell door: the host observed the
  // defect itself, never a synthesized failed ToolCallResult.
  const defects = causes.flatMap((cause) => cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect));
  expect(completions).toBe(1);
  expect(defects).toHaveLength(1);
  expect(defects[0]).toBeInstanceOf(Error);
  expect((defects[0] as Error).name).not.toBe("ToolRefused");
  expect(settled).toEqual([]);
  // The turn never saw a completed cell value built from a folded result.
  expect(JSON.stringify(exit)).not.toContain("'completed'");
}, 15_000);
