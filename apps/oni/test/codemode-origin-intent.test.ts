import { APPROVAL_POLICY } from "../src/composition/policy";
import { beforeAll, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import { Bundle, Core } from "@oni/agent";
import { z } from "zod";
const createTurnDispatcher = Bundle.createTurnDispatcher;
import { createMachineHost, createMemoryGenerationStore } from "@oni/machines";
import { LedgerAction, type Machine, type ToolExecutionContext } from "@oni/protocol";
import { catalogLayer, executorLayer } from "../../../packages/agent/test/helpers/service-layers";
import { runnerTestLayer } from "../../../packages/agent/test/helpers/isolated";
import { composeCodemode, MACHINE_ORIGIN_TOOLS } from "../src/composition/codemode";
import { cellPorts } from "./helpers/cell-ports";
import { acquireEffect, acquireSyncEffect, runEffect } from "./helpers/scoped-effect";
import { attachAppMclient, mclientBinary } from "./helpers/mclient";
import { Bus } from "./helpers/bus";
import { seededPolicy } from "./helpers/executor";
import { residentSuite } from "./helpers/resident-suite";
import { socketPath } from "./helpers/socket-path";
import { bundleTools, testToolPorts } from "./helpers/tool-ports";
import { testIds } from "./helpers/test-entropy";

const suite = residentSuite();
beforeAll(mclientBinary, 300_000);

/** A cell-visible tool that parks the cell until the test releases it; `entered` carries the cell id the door dispatched under. */
function holdTool() {
  const entered = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  const definition = Core.defineTool({
    name: "hold", description: "Park the cell", category: "query",
    input: z.object({}).strict(), output: z.string(),
    visibility: { model: ["resident"], cell: ["resident"] },
    execute: async (_input, context: ToolExecutionContext) => { entered.resolve(context.turnId); await release.promise; return "released"; },
    render: (_input, output) => output,
  });
  return { definition, entered: entered.promise, release: () => release.resolve() };
}

test("the origin codemode attributed to a cell call rides in the tool.pre intent at both doors and the machine allowlist is the two model tools (#1841)", async () => {
  const path = socketPath();
  let cells: Effect.Success<ReturnType<typeof composeCodemode>>;
  const host = await acquireEffect(createMachineHost({
    generations: createMemoryGenerationStore(),
    dispatcherBound: 8,
    listen: { unix: path },
    id: testIds("origin-host"),
    scheduler: { schedule: () => () => undefined },
    enrollment: (machineId: string) => ({ machineId, name: "origin", allowedCapabilities: ["kernel.py"], publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", enrolledAt: 0 }),
    events: Bus, now: () => 1,
    callTool: (call: Machine.ToolCall) => Effect.suspend(() => cells.callTool(call)),
  }));
  suite.defer(() => runEffect(host.close()));
  const client = await attachAppMclient({ socketPath: path, machineId: "origin", root: suite.tempDir("origin-client-"), exports: [] });
  suite.defer(() => client.stop());
  cells = acquireSyncEffect(composeCodemode(host, { id: testIds("origin-compose"), selfMachineId: "origin" }));
  suite.defer(() => runEffect(cells.close()));
  const hold = holdTool();
  const stored: string[] = [];
  const definitions = [...bundleTools({
    ...testToolPorts, cells: cellPorts(cells),
    speech: async () => ({ bytes: new Uint8Array([1, 2, 3]), mediaType: "audio/mpeg" }),
    putOutput: (sessionId, write) => { stored.push(`${sessionId}:${write.outputId}`); },
  }), hold.definition];
  const actions: LedgerAction.Node[] = [];
  let sequence = 0;
  const runnerServices = acquireSyncEffect(Layer.build(runnerTestLayer));
  const dispatcher = acquireSyncEffect(createTurnDispatcher({
    sessionId: "origin-session", role: "resident", actionId: "one-turn",
    ledger: { commit: (append: LedgerAction.Append) => {
      const ordinal = actions.length + 1;
      const action = LedgerAction.Node.parse({ ...append, ordinal });
      actions.push(action);
      return Effect.succeed({ action, revision: ordinal });
    } },
  }, { approvalPolicy: APPROVAL_POLICY }).pipe(
    Effect.provide(catalogLayer(definitions)),
    Effect.provide(executorLayer({ policy: seededPolicy, observations: { publish: () => undefined }, clock: () => 1, entropy: () => `origin-${++sequence}` })),
    Effect.provide(runnerServices),
  ));
  const running = runEffect(dispatcher.execute({
    id: "cell-origin", tool: "eval", input: { operation: { op: "run", code: "tool.hold()\n[m['machineId'] for m in codemode.listMachines()]", timeout: 15 } },
  }, { sessionId: "origin-session", turnId: "one-turn" }));
  // While the cell is parked in `hold`, calls stamped by another attachment
  // reach the same cell binding: the allowlisted tool runs under that origin,
  // anything else is refused before the session catalog.
  const cellId = await hold.entered;
  const fromB = (name: string, args: Machine.ToolCall["arguments"]) =>
    runEffect(Effect.exit(cells.callTool({ cellId, name, arguments: args, source: { kind: "machine", machineId: "B" } })));
  const spoken = await fromB("speech", { text: "hi" });
  expect(spoken).toMatchObject({ _tag: "Success", value: { status: "completed", value: { kind: "audio", mime: "audio/mpeg", voice: true } } });
  const refused = await fromB("bash", { command: "id" });
  hold.release();
  expect(Exit.isFailure(refused)).toBe(true);
  if (Exit.isFailure(refused)) expect((Cause.squash(refused.cause) as { operation?: string }).operation).toBe("code.tool.machine_origin_refused");
  const result = await running;
  expect(result.isError, result.content).toBeUndefined();
  expect(result.content).toBe("['origin']");
  expect(stored).toHaveLength(1);
  // The host stamped each call with the attachment that delivered it; the
  // boundary attributes the self machine to the session, the gate hashed the
  // origin into the pre decision and the intent row records it beside the args.
  const intents = actions.flatMap((action) => {
    const parsed = LedgerAction.Intent.safeParse(action.intent.value);
    return parsed.success ? [parsed.data] : [];
  });
  const originOf = (op: string) => intents.filter((intent) => intent.op === op).map(({ value, origin }) => ({ value, origin }));
  expect(originOf("codemode.listMachines")).toEqual([{ value: {}, origin: { kind: "session" } }]);
  expect(originOf("hold")).toEqual([{ value: {}, origin: { kind: "session" } }]);
  expect(originOf("speech")).toEqual([{ value: { text: "hi" }, origin: { kind: "machine", machineId: "B" } }]);
  expect(originOf("bash")).toEqual([]);
  expect(MACHINE_ORIGIN_TOOLS).toEqual(["speech", "image"]);
}, 15_000);
