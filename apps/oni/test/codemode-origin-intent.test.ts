import { APPROVAL_POLICY } from "../src/composition/policy";
import { beforeAll, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { Bundle } from "@oni/agent";
const createTurnDispatcher = Bundle.createTurnDispatcher;
import { createMachineHost, createMemoryGenerationStore } from "@oni/machines";
import { LedgerAction, type Machine } from "@oni/protocol";
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

test("the origin codemode attributed to a cell call rides in the tool.pre intent and the machine allowlist is the two model tools (#1841)", async () => {
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
  const definitions = bundleTools({ ...testToolPorts, cells: cellPorts(cells) });
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
  const result = await runEffect(dispatcher.execute({
    id: "cell-origin", tool: "eval", input: { operation: { op: "run", code: "[m['machineId'] for m in codemode.listMachines()]", timeout: 15 } },
  }, { sessionId: "origin-session", turnId: "one-turn" }));
  expect(result.isError, result.content).toBeUndefined();
  expect(result.content).toBe("['origin']");
  // The host stamped the call with the self machine; the boundary attributes that
  // to the session and the gate hashed that origin inside the request intent.
  const intents = actions.flatMap((action) => {
    const parsed = LedgerAction.Intent.safeParse(action.intent.value);
    return parsed.success ? [parsed.data] : [];
  });
  expect(intents.filter((intent) => intent.op === "codemode.listMachines").map((intent) => intent.value)).toEqual([{ source: { kind: "session" } }]);
  expect(MACHINE_ORIGIN_TOOLS).toEqual(["speech", "image"]);
}, 15_000);
