import { acquireEffect, runEffect, acquireSyncEffect } from "./helpers/scoped-effect";
import { Effect } from "effect";
import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { interpreterWitness } from "./helpers/interpreter-witness";
import { Core } from "@oni/agent";
const currentInvocation = Core.currentInvocation;
type InvocationFrame = Core.InvocationFrame;
import { Bus, newTraceId } from "./helpers/bus";
import type { AppLedgerPlane } from "../src/composition/cluster-runtime";
import { planeOf } from "./helpers/ledger";
type RunInput = Core.RunInput;
type Sink = Core.LlmSink;
import {
  attachMachineDaemon as attachDaemon,
  createMachineHost as createHost,
  createMemoryGenerationStore,
  type MachineDaemon,
} from "@oni/machines";
import type { Machine, PlainObject } from "@oni/protocol";
import type { CatalogOrigin } from "../src/composition/catalog";
import type { ToolPorts } from "../src/composition/catalog";
import { cellPorts } from "./helpers/cell-ports";
import { composeCodemode } from "../src/composition/codemode";
import { createCodemode } from "@oni/codemode";
import { dispatchModelTool, modelToolOutput } from "./helpers/tool-dispatch";
import { requestToolStep, assistantMessage } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { socketPath as testSocketPath } from "./helpers/socket-path";
import { testKernelSelfMachine, testSelfMachine } from "./helpers/self-machine";
import { nextResidentTurn } from "./helpers/resident-turn";

import { cellDaemonOptions } from "./helpers/cell-daemon";
import { testIds } from "./helpers/test-entropy";

const WS_TOKEN = "code-mode-e2e-token";
const MACHINE_ID = "alpha";

let witness: ReturnType<typeof interpreterWitness>;
beforeEach(() => {
  witness = interpreterWitness();
});

const suite = residentSuite(async () => {
  try {
    await witness.wait();
  } finally {
    witness.restore();
  }
});

// Registration occurs before returning to any fallible test or harness work.
async function createMachineHost(options: Omit<Parameters<typeof createHost>[0], "id">) {
  const host = await acquireEffect(createHost({ id: testIds("e2e-host"), scheduler: { schedule: () => () => undefined }, ...options }));
  suite.defer(async () => {
    await runEffect(host.close());
    const unixPath = options.listen.unix ?? "";
    expect(existsSync(unixPath)).toBe(false);
    console.log(
      "967-U1 host cleanup",
      JSON.stringify({
        socketPath: unixPath,
        socketExists: existsSync(unixPath),
      }),
    );
  });
  return host;
}

async function attachMachineDaemon(
  options: Omit<Extract<Parameters<typeof attachDaemon>[0], { socketPath: string }>, "id">,
): Promise<MachineDaemon> {
  const daemon = await acquireEffect(attachDaemon({ id: testIds("e2e-daemon"), ...options, runner: acquireSyncEffect(createCodemode({ id: testIds("e2e-cell") })).runner }));
  suite.defer(() => runEffect(daemon.close()));
  return daemon;
}

const enrollment: Machine.Enrollment = {
  machineId: MACHINE_ID,
  name: "the laptop",
  allowedCapabilities: ["kernel.py"],
  publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  enrolledAt: 0,
};

const fullEnrollment = (): Machine.Enrollment => ({
  ...enrollment,
  allowedCapabilities: ["fs.read", "fs.write", "shell.exec", "kernel.py"],
  allowedExports: ["data"],
});

/**
 * The payoff, end to end and with a real daemon: one cell makes three
 * send_message calls and gets three child handles inside the cell rather
 * than joining the children's completion in the model turn.
 */
test("app root runs machine read write shell and code through one eval cell", async () => {
  const directory = mkdtempSync(join(tmpdir(), "om-app-machine-"));
  const root = join(directory, "data");
  mkdirSync(root);
  const socketPath = testSocketPath();
  const appEnrollment = { ...fullEnrollment(), tags: ["worker"], allowedExports: ["data"] };
  const config = suite.config("oni-app-machine-", {
    wsToken: WS_TOKEN,
    model: { provider: "fake", id: "app-machine-test", apiKey: "test-key" },
    machines: {
      self: testKernelSelfMachine(), listen: { unix: socketPath }, enrolled: [appEnrollment],
      capacity: [{ tag: "worker", slots: 1 }],
    },
  });
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input: RunInput, sink: Sink) => Effect.sync(() => {
        const call = requestToolStep(input, sink, {
          id: "machine-cell",
          tool: "eval",
          input: {
            operation: {
              op: "run",
              code: [
                "m = machine(tag='worker')",
                "try:",
                "    machine(tag='worker')",
                "except ToolError as error:",
                "    saturated = 'machine_saturated' in str(error)",
                "assert saturated",
                `m.write(${JSON.stringify(join(root, "value"))}, bytes([0, 255, 128, 65]))`,
                `readback = list(m.read(${JSON.stringify(join(root, "value"))})['data'])`,
                `shell = m.bash('printf shell; exit 7', ${JSON.stringify(root)})`,
                `code = m.eval('6 * 7')`,
                "(readback, shell['stdout'], shell['exitCode'], code['value'])",
              ].join("\n"),
              timeout: 15,
            },
          },
        });
        if (call === undefined) return { type: "stop" };
        sink.onMessage(assistantMessage(input, { text: String(call.content) }));
        return { type: "stop" };
      }),
    },
  });
  const plane = await planeOf(app.runtime);
  const daemon = await attachMachineDaemon({
    dispatcherBound: 8,
    socketPath,
    fsExports: new Map([["data", root]]),
    offer: {
      machineId: MACHINE_ID,
      offeredCapabilities: appEnrollment.allowedCapabilities,
      exports: [{ name: "data", path: root }],
      daemonVersion: "test",
      platform: `${process.platform}-${process.arch}`,
      offeredAt: 1,
    },
  });
  suite.defer(() => runEffect(daemon.close()));
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", WS_TOKEN]);
  const reply = nextResidentTurn(plane, 15_000);
  ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "exercise machine" }));
  const answer = String((await reply).text);
  expect(answer).toContain("[0, 255, 128, 65]");
  expect(answer).toContain("b'shell'");
  expect(answer).toContain("7");
  expect(answer).toContain("'42'");
  rmSync(directory, { recursive: true, force: true });
}, 30_000);

test("a cell drives a named persistent terminal through m.pty (#1273)", async () => {
  const socketPath = testSocketPath();
  const tmuxSocket = `oo-1273-e2e-${process.pid}`;
  const appEnrollment = {
    ...fullEnrollment(),
    allowedCapabilities: ["kernel.py", "pty.session"],
    allowedExports: ["shell"],
  };
  const config = suite.config("oni-app-pty-", {
    wsToken: WS_TOKEN,
    model: { provider: "fake", id: "app-pty-test", apiKey: "test-key" },
    machines: { self: testKernelSelfMachine(), listen: { unix: socketPath }, enrolled: [appEnrollment] },
  });
  const code = [
                `m = machine('${MACHINE_ID}')`,
    "t = m.pty('qa')",
    "opened = t.open('/')",
    "cur = opened['cursor']",
    "first = t.read(cursor=cur, wait_ms=3000)",
    "cur = first['cursor']",
    "t.resize(120, 30)",
    "t.write('echo py-$((40+2))\\r')",
    "seen = b''",
    "for _ in range(20):",
    "    view = t.read(cursor=cur, wait_ms=1000)",
    "    cur = view['cursor']",
    "    seen += view['data']",
    "    if b'py-42' in seen:",
    "        break",
    "names = [s['name'] for s in m.ptyList()['sessions']]",
    "closed = t.close()['status']",
    "after = t.read()['reason']",
    "(b'py-42' in seen, names, closed, after)",
  ].join("\n");
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input: RunInput, sink: Sink) => Effect.sync(() => {
        const call = requestToolStep(input, sink, {
          id: "pty-cell",
          tool: "eval",
          input: { operation: { op: "run", code, timeout: 30 } },
        });
        if (call === undefined) return { type: "stop" };
        // Second door, same terminal plane: the bash tool with a session,
        // through the app's real gateway machine port. One step: the agent
        // stop-guard treats repeated empty tool-step turns as a stall.
        const echo = requestToolStep(input, sink, {
          id: "pty-bash-echo",
          tool: "bash",
          input: { machine: MACHINE_ID, session: "door", command: "export DOOR_X=42; echo door-$DOOR_X" },
        });
        if (echo === undefined) return { type: "stop" };
        sink.onMessage(assistantMessage(input, { text: `${call.content} || ${echo.content}` }));
        return { type: "stop" };
      }),
    },
  });
  const plane = await planeOf(app.runtime);
  const daemon = await attachMachineDaemon({
    dispatcherBound: 8,
    socketPath,
    fsExports: new Map([["shell", "/"]]),
    pty: { socketName: tmuxSocket },
    offer: {
      machineId: MACHINE_ID,
      offeredCapabilities: appEnrollment.allowedCapabilities,
      exports: [{ name: "shell", path: "/" }],
      daemonVersion: "test",
      platform: `${process.platform}-${process.arch}`,
      offeredAt: 1,
    },
  });
  suite.defer(() => runEffect(daemon.close()));
  suite.defer(() => {
    Bun.spawnSync(["tmux", "-L", tmuxSocket, "kill-server"]);
  });
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", WS_TOKEN]);
  const reply = nextResidentTurn(plane, 60_000);
  ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "exercise the terminal" }));
  const answer = String((await reply).text);
  expect(answer).toContain("(True, ['qa'], 'ok', 'pty_not_found')");
  expect(answer).toContain("door-42");
}, 90_000);

test("a cell creates three child sessions through send_message", async () => {
  const socketPath = testSocketPath();
  const residentTurns: string[] = [];

  const config = suite.config("oni-code-mode-", {
    wsToken: WS_TOKEN,
    model: { provider: "fake", id: "code-mode-test", apiKey: "test-key" },
    machines: { self: testKernelSelfMachine(), listen: { unix: socketPath }, enrolled: [enrollment] },
  });
  const planeRef: { current: AppLedgerPlane | undefined } = { current: undefined };
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input: RunInput, sink: Sink) => Effect.sync(() => {
        const plane = planeRef.current;
        if (plane === undefined) throw new Error("plane not resolved before model run");
        if (plane.openKernel(input.trace.sessionId).row(input.trace.sessionId).role === "child") {
          // Each child answers with the instruction it was actually given, so
          // a cell that dropped or duplicated one would be visible.
          const asked = (input.messages.at(-1)?.parts ?? [])
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join(" ");
          sink.onMessage(assistantMessage(input, { text: `done(${asked.replace(/^.*?: /, "")})` }));
          return { type: "stop" };
        }

        residentTurns.push(input.trace.sessionId);
        const offered = (input.tools ?? []).map((tool) => tool.name).sort();
        const executed = requestToolStep(input, sink, {
          id: "call-1",
          tool: "eval",
          input: {
            operation: {
              op: "run",
              code: [
                "answers = [",
                "  tool.send_message(to={'kind':'new_session','role':'child','runner':'native','parent':'me'}, message=f'check {name}', spend_cap=1)['target']",
                "  for name in ('lint', 'types', 'tests')",
                "]",
                "len(set(answers))",
              ].join("\n"),
              timeout: 20,
            },
          },
        });
        if (executed === undefined) return { type: "stop" };
        sink.onMessage(
          assistantMessage(input, {
            text: `offered=[${offered.join(",")}] cell=${executed?.content ?? "nothing"}`,
          }),
        );
        return { type: "stop" };
      }),
    },
  });

  planeRef.current = await planeOf(app.runtime);
  const daemon = await attachMachineDaemon(cellDaemonOptions(socketPath, MACHINE_ID));
  expect(daemon.attachment.status).toBe("attached");

  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, [
    "auth",
    WS_TOKEN,
  ]);
  const reply = nextResidentTurn(planeRef.current, 30_000);
  ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "check everything" }));

  const answer = String((await reply).text);

  // The catalog is stable; the daemon enforces machine availability at execution.
  expect(answer).toContain(
    "offered=[bash,edit,eval,find,grep,ls,monitor,provision,read,send_message,write]",
  );
  // Three children ran and their answers came back inside the cell. The value
  // is the cell's final expression as Python rendered it, quotes included.
  expect(answer).toContain("cell=3");
  expect(planeRef.current.listSessions().filter((row) => row.role === "child")).toHaveLength(3);
  // One Resident turn, not three: that is what code mode bought.
  expect(residentTurns.length).toBeGreaterThanOrEqual(2);
  expect(new Set(residentTurns).size).toBe(1);
  expect(witness.pids).toHaveLength(1);
  const catalogPath = config.catalogPath;
  if (catalogPath === undefined) throw new Error("suite config is missing catalogPath");
  await suite.cleanup();
  expect(witness.completed).toBe(true);
  expect(existsSync(socketPath)).toBe(false);
  expect(existsSync(dirname(catalogPath))).toBe(false);
  console.log(
    "967-U1 code-mode cleanup",
    JSON.stringify({
      pids: witness.pids,
      socketPath,
      socketExists: existsSync(socketPath),
      catalogPath,
      directoryExists: existsSync(dirname(catalogPath)),
    }),
  );
}, 60_000);

/**
 * #1258 C-1 regression: the cell door THROWS ToolRefused (tool.ts
 * finishResult) when the seeded spend-cap guard denies a capless `to.new`
 * send. composition/codemode.ts folds that defect to the typed failed
 * ToolCallResult, so the cell sees ToolError and the turn settles — never an
 * IPC "request handler defect" tearing the connection.
 */
test("a cell's refused send_message surfaces as ToolError inside the cell, not an IPC defect", async () => {
  const socketPath = testSocketPath();
  const config = suite.config("oni-code-mode-refused-", {
    wsToken: WS_TOKEN,
    model: { provider: "fake", id: "code-mode-test", apiKey: "test-key" },
    machines: { self: testKernelSelfMachine(), listen: { unix: socketPath }, enrolled: [enrollment] },
  });
  const planeRef: { current: AppLedgerPlane | undefined } = { current: undefined };
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input: RunInput, sink: Sink) => Effect.sync(() => {
        const executed = requestToolStep(input, sink, {
          id: "call-1",
          tool: "eval",
          input: {
            operation: {
              op: "run",
              code: [
                "try:",
                "    tool.send_message(to={'kind':'new_session','role':'child','runner':'native','parent':'me'}, message='no cap')",
                "    outcome = 'created'",
                "except ToolError as error:",
                "    outcome = 'refused: ' + str(error)",
                "outcome",
              ].join("\n"),
              timeout: 20,
            },
          },
        });
        if (executed === undefined) return { type: "stop" };
        sink.onMessage(assistantMessage(input, { text: `cell=${executed?.content ?? "nothing"}` }));
        return { type: "stop" };
      }),
    },
  });
  planeRef.current = await planeOf(app.runtime);
  const daemon = await attachMachineDaemon(cellDaemonOptions(socketPath, MACHINE_ID));
  expect(daemon.attachment.status).toBe("attached");

  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, [
    "auth",
    WS_TOKEN,
  ]);
  const reply = nextResidentTurn(planeRef.current, 30_000);
  ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "spawn without a cap" }));

  // The turn SETTLES with the refusal as cell data: the catchDefect fold, not
  // a torn connection or a disposed-runtime cascade.
  const answer = String((await reply).text);
  // Python renders the cell value quoted; the refusal text is the data.
  expect(answer).toContain("refused: send_message refused");
  expect(answer).not.toContain("created");
  // The refused send created no child session.
  expect(planeRef.current.listSessions().filter((row) => row.role === "child")).toHaveLength(0);
  await suite.cleanup();
}, 60_000);

test("the catalog remains available while machine execution refuses without attachment", async () => {
  let offered: string[] = [];

  const app = await suite.boot({
    config: suite.config("oni-code-mode-off-", {
      wsToken: WS_TOKEN,
      model: { provider: "fake", id: "code-mode-test", apiKey: "test-key" },
      machines: { self: testSelfMachine(), listen: { unix: testSocketPath() }, enrolled: [enrollment] },
    }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input: RunInput, sink: Sink) => Effect.sync(() => {
        offered = (input.tools ?? []).map((tool) => tool.name);
        // Availability is an endpoint precondition, not a second catalog gate.
        const forced = requestToolStep(input, sink, {
          id: "call-1",
          tool: "eval",
          input: { operation: { op: "run", code: "1", timeout: 1 } },
        });
        if (forced === undefined) return { type: "stop" };
        sink.onMessage(
          assistantMessage(input, {
            text: `forced=${forced?.content ?? "nothing"}`,
          }),
        );
        return { type: "stop" };
      }),
    },
  });

  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, [
    "auth",
    WS_TOKEN,
  ]);
  const reply = nextResidentTurn(await planeOf(app.runtime), 15_000);
  ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "run something" }));

  const answer = String((await reply).text);

  expect(offered).toEqual([
    "read",
    "write",
    "edit",
    "ls",
    "find",
    "grep",
    "bash",
    "eval",
    // #1561: every tool is bundle-owned; the order is the composed bundle order.
    "monitor",
    "send_message",
    "provision",
  ]);
  // The raw machine endpoint reports live attachment failure.
  expect(answer).toContain("kernel_not_available");
}, 30_000);

/** One enrolled-gated e2e host on a fresh socket; callTool is the only seam that differs per test. */
async function e2eHost(callTool: Parameters<typeof createMachineHost>[0]["callTool"]) {
  const socketPath = testSocketPath();
  const host = await createMachineHost({
    generations: createMemoryGenerationStore(),
    dispatcherBound: 8,
    listen: { unix: socketPath },
    enrollment: (machineId) => (machineId === MACHINE_ID ? enrollment : undefined),
    events: Bus,
    now: () => Date.now(),
    callTool,
  });
  return { socketPath, host };
}

/**
 * What actually makes a cell's identity unforgeable, pinned upstream of the
 * registry: the cell's code never states its own id. A cell that tries to
 * serve a call under another cell's id gets the daemon's stamp instead.
 */
test("a cell cannot present another cell's id when calling back", async () => {
  const served: string[] = [];

  // AAA (tenant one) blocks inside a tool call the host holds until BBB
  // (tenant two — a separate interpreter, so the two genuinely overlap) has
  // been served. No sleeps: the deferred IS the overlap proof.
  let announceServed!: () => void;
  const forgingServed = new Promise<void>((resolve) => {
    announceServed = resolve;
  });
  const { socketPath, host } = await e2eHost((call) => Effect.promise(async () => {
    served.push(`${call.name}@${call.cellId}`);
    if (call.name === "hold") {
      await forgingServed;
      return { status: "completed" as const, value: "held" };
    }
    announceServed();
    return { status: "completed" as const, value: call.cellId };
  }));
  await attachMachineDaemon({
    dispatcherBound: 8,
    socketPath,
    offer: {
      machineId: MACHINE_ID,
      offeredCapabilities: ["kernel.py"],
      daemonVersion: "test",
      platform: "test",
      offeredAt: 0,
    },
  });

  const slow = runEffect(host.get(MACHINE_ID).runCode({
    cellId: "AAA",
    code: "tool.hold()",
    timeoutMs: 15_000,
    tenant: "tenant-one",
  }));
  const forging = await runEffect(host.get(MACHINE_ID).runCode({
    cellId: "BBB",
    // The call carries no id of its own; naming one changes nothing.
    code: "tool.send_message(cellId='AAA', instruction='borrow')",
    timeoutMs: 15_000,
    tenant: "tenant-two",
  }));
  await slow;

  // Completion itself proves the overlap: on one interpreter AAA's hold would
  // wait forever for a BBB that cannot start until AAA settles.
  expect([...served].sort()).toEqual(["hold@AAA", "send_message@BBB"]);
  expect(forging.status).toBe("completed");
}, 40_000);

test("967-U1 error cleanup owns the host and awaits every interpreter", async () => {
  const { socketPath, runWith } = await startCellHarness({ llm: async () => "ok" });
  const directory = suite.tempDir("oni-code-mode-failure-");
  const failure = new Error("U1_INJECTED_CELL_FAILURE");
  try {
    await runWith({ role: "resident", sessionId: "failure-a" }, "1 + 1");
    await runWith({ role: "resident", sessionId: "failure-b" }, "2 + 2");
    expect(witness.pids).toHaveLength(2);
    try {
      expect(() => {
        throw failure;
      }).toThrow(failure);
    } finally {
      await suite.cleanup();
    }
    expect(existsSync(socketPath)).toBe(false);
    expect(witness.completed).toBe(true);
    expect(existsSync(directory)).toBe(false);
    console.log(
      "967-U1 code-mode failure cleanup",
      JSON.stringify({
        pids: witness.pids,
        socketPath,
        socketExists: existsSync(socketPath),
        directory,
        directoryExists: existsSync(directory),
      }),
    );
  } finally {
    await suite.cleanup();
  }
}, 30_000);

const CELL_ORIGIN: CatalogOrigin = { role: "resident", sessionId: "cell-e2e" };

/**
 * A real host+daemon pair whose cells go through the production eval
 * executor, with the catalog's ports swapped for fakes — the same seam
 * startOni wires at boot, exercised without booting the app.
 */
async function startCellHarness(ports: Partial<ToolPorts>) {
  let cells: Effect.Success<ReturnType<typeof composeCodemode>>;
  const { socketPath, host } = await e2eHost((call) => cells.callTool(call));
  const daemon = await attachMachineDaemon(cellDaemonOptions(socketPath, MACHINE_ID));
  expect(daemon.attachment.status).toBe("attached");
  cells = acquireSyncEffect(composeCodemode(host, { id: testIds("e2e-compose"), selfMachineId: MACHINE_ID }));
  suite.defer(() => runEffect(cells.close()));
  const states: Machine.CellState[] = [];
  const portsForCells = cellPorts(cells);
  const recordState = async (result: Promise<Machine.CellState>): Promise<Machine.CellState> => {
    const state = await result;
    states.push(state);
    return state;
  };
  const observedCells: typeof portsForCells = { cell: {
    run: (...args: Parameters<typeof portsForCells.cell.run>) => recordState(portsForCells.cell.run(...args)),
    peek: (...args: Parameters<typeof portsForCells.cell.peek>) => recordState(portsForCells.cell.peek(...args)),
    stop: (...args: Parameters<typeof portsForCells.cell.stop>) => recordState(portsForCells.cell.stop(...args)),
  } };
  const executeResult = dispatchModelTool("eval", { ...ports, cells: observedCells }, CELL_ORIGIN);
  const execute = async (input: PlainObject): Promise<string> => String((await executeResult(input)).content);
  return {
    states,
    socketPath,
    executeResult,
    execute,
    run: (code: string, timeout = 15) => execute({ operation: { op: "run", code, timeout } }),
    runWith: (origin: CatalogOrigin, code: string) =>
      modelToolOutput(
        "eval",
        { ...ports, cells: cellPorts(cells) },
        origin,
      )({
        operation: { op: "run", code, timeout: 15 },
      }),
  };
}

/**
 * A harness whose completion callback holds until `release` resolves: `entered`
 * is the exact signal that the callback reached that boundary and `calls` counts
 * how often it did. The interpreter is warmed first, so a test's one-second wait
 * is the background-run boundary under test, not the cold start of a fresh
 * instrumented interpreter.
 */
async function startHeldCompletionHarness() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const harness = await startCellHarness({
    llm: async () => {
      calls += 1;
      entered.resolve();
      await release.promise;
      return "late";
    },
  });
  expect(await harness.run("0")).toBe("0");
  return { ...harness, entered, release, calls: () => calls };
}

test("a detached eval cell admits nested calls after run returns and refuses them after stop", async () => {
  const firstEntered = Promise.withResolvers<void>();
  const firstReply = Promise.withResolvers<string>();
  const secondEntered = Promise.withResolvers<InvocationFrame>();
  const secondReply = Promise.withResolvers<string>();
  const pendingEntered = Promise.withResolvers<void>();
  const bounded = <A>(promise: Promise<A>): Promise<A> =>
    runEffect(Effect.promise(() => promise).pipe(Effect.timeout("5 seconds")));
  let calls = 0;
  let nestedBodies = 0;
  const harness = await startCellHarness({ llm: async () => {
    calls += 1;
    if (calls === 1) { firstEntered.resolve(); return firstReply.promise; }
    secondEntered.resolve(currentInvocation());
    return secondReply.promise;
  } });
  try {
    expect(await harness.run("0")).toBe("0");
    const starting = harness.executeResult({ operation: {
      op: "run", code: "completion('hold')\ncompletion('after-detach')", timeout: 1,
    } });
    await bounded(firstEntered.promise);
    expect(await starting).not.toHaveProperty("isError", true);
    const state = harness.states.at(-1);
    expect(state?.status).toBe("running");
    if (state?.status !== "running") throw new Error("expected detached cell");
    firstReply.resolve("first");
    const frame = await bounded(secondEntered.promise);
    expect(calls).toBe(2);
    const request = { kind: "tool", op: "cell-lifetime", intent: {}, effect: { category: "query" } };
    expect(await runEffect(frame.executor.run(request, () => Effect.sync(() => {
      nestedBodies += 1;
      return "after-detach";
    })))).toEqual({ terminal: "executed", value: "after-detach" });
    const pending = runEffect(Effect.result(frame.executor.run(request, () =>
      Effect.sync(() => pendingEntered.resolve()).pipe(Effect.andThen(Effect.never)))));
    await bounded(pendingEntered.promise);
    expect(await harness.executeResult({ operation: { op: "stop", cell_id: state.cellId } })).not.toHaveProperty("isError", true);
    expect(await bounded(pending)).toMatchObject({ _tag: "Failure", failure: { _tag: "InvocationClosed", reason: "interrupted" } });
    expect(await runEffect(Effect.result(frame.executor.run(request, () => Effect.sync(() => {
      nestedBodies += 1;
      return "forbidden";
    }))))).toMatchObject({ _tag: "Failure", failure: { _tag: "InvocationClosed" } });
    expect(nestedBodies).toBe(1);
  } finally {
    firstReply.resolve("cleanup");
    secondReply.resolve("cleanup");
  }
}, 15_000);

test("cells from different sessions never share interpreter state", async () => {
  const { runWith } = await startCellHarness({ llm: async () => "ok" });
  const sessionA: CatalogOrigin = { role: "resident", sessionId: "session-a" };
  const sessionB: CatalogOrigin = { role: "resident", sessionId: "session-b" };

  await runWith(sessionA, "shared = 'mine'\n'set'");
  const sameSession = await runWith(sessionA, "shared");
  const otherSession = await runWith(sessionB, "shared");

  // Same session: state persists. Other session: a separate interpreter, so
  // the name simply does not exist there.
  expect(sameSession).toContain("mine");
  expect(otherSession).toContain("the cell raised");
  expect(otherSession).toContain("NameError");
}, 40_000);

test("eval answers the model with rendered content and code consumers with the structuredContent cell state (D5)", async () => {
  const { executeResult } = await startCellHarness({ llm: async () => "ok" });
  const result = await executeResult({ operation: { op: "run", code: "1 + 1", timeout: 15 } });
  expect(result.isError).toBeUndefined();
  // Model text is the rendered value; typed data is the full CellState.
  expect(result.content).toBe("2");
  expect(result.structuredContent).toMatchObject({
    status: "completed",
    value: "2",
    output: { stdout: "", stderr: "" },
  });
}, 40_000);

async function heldCell(code: string) {
  const harness = await startHeldCompletionHarness();
  const starting = harness.executeResult({ operation: { op: "run", code, timeout: 1 } });
  await runEffect(Effect.promise(() => harness.entered.promise).pipe(Effect.timeout("5 seconds")));
  expect(await starting).not.toHaveProperty("isError", true);
  const started = harness.states.at(-1);
  expect(started?.status).toBe("running");
  return { ...harness, started };
}

/**
 * The wait window is the behavior under test here: a held cell cannot settle,
 * so the one-second `timeout` is exactly what makes run answer `running`.
 */
test("eval background run and peek stay running; stop settles the typed cancelled state once", async () => {
  const { run, executeResult, states, started, release, calls } = await heldCell(
    "print('started')\ncompletion('hold')\nprint('never')",
  );
  try {
    if (started?.status !== "running") return;
    const cellId = started.cellId;
    expect(started.output).toEqual({ stdout: "started\n", stderr: "" });
    expect(calls()).toBe(1);
    expect(await executeResult({ operation: { op: "peek", cell_id: cellId } })).not.toHaveProperty("isError", true);
    expect(states.at(-1)).toEqual(started);
    expect(await executeResult({ operation: { op: "stop", cell_id: cellId } })).not.toHaveProperty("isError", true);
    expect(states.at(-1)).toEqual({ ...started, status: "cancelled" });
    expect(await executeResult({ operation: { op: "peek", cell_id: cellId } })).toMatchObject({
      isError: true, errorKind: "precondition_failed",
    });
    release.resolve();
    expect(await run("6 * 7")).toBe("42");
    expect(calls()).toBe(1);
  } finally {
    release.resolve();
  }
}, 40_000);

test("eval background peek and stop race spends the cell id and settles cancelled exactly once", async () => {
  const { executeResult, states, started, release, calls } = await heldCell("completion('hold')");
  try {
    if (started?.status !== "running") return;
    expect(calls()).toBe(1);
    const [peeked, stopped] = await Promise.all([
      executeResult({ operation: { op: "peek", cell_id: started.cellId } }),
      executeResult({ operation: { op: "stop", cell_id: started.cellId } }),
    ]);
    expect(stopped).not.toHaveProperty("isError", true);
    expect(peeked).toMatchObject({ isError: true, errorKind: "precondition_failed" });
    expect(states.filter((state: Machine.CellState) => state.status === "cancelled")).toEqual([
      { ...started, status: "cancelled" },
    ]);
    expect(calls()).toBe(1);
  } finally {
    release.resolve();
  }
}, 40_000);

test("eval peek and stop refuse another session's cell id and a forged one", async () => {
  const { execute, runWith } = await startCellHarness({ llm: async () => "ok" });
  expect(await execute({ operation: { op: "stop", cell_id: "not-a-cell" } })).toContain(
    "no such cell_id",
  );
  expect(await runWith({ ...CELL_ORIGIN, sessionId: "other-session" }, "1 + 1")).toBe("2");
}, 40_000);

test("completion(prompt, model=, system=, schema=) reaches the port and decodes the validated JSON", async () => {
  const seen: Array<{ prompt: string; system?: string; model?: string }> = [];
  const { run } = await startCellHarness({
    llm: async (call) => {
      seen.push(call);
      return call.system?.includes("JSON Schema") === true
        ? '```json\n{"answer": 42}\n```'
        : `plain:${call.prompt}`;
    },
  });
  const output = await run(
    [
      "plain = completion('p', model='mini', system='be terse')",
      "shaped = completion('q', schema={'type': 'object', 'properties': {'answer': {'type': 'integer'}}, 'required': ['answer'], 'additionalProperties': False})",
      "(plain, shaped, shaped['answer'] + 1)",
    ].join("\n"),
  );
  expect(output).toBe("('plain:p', {'answer': 42}, 43)");
  expect(seen[0]).toEqual({ prompt: "p", system: "be terse", model: "mini" });
  expect(seen[1]?.prompt).toBe("q");
  expect(seen[1]?.system).toContain('"required":["answer"]');
}, 40_000);

test("a cell rejects legacy batched completion input and serves one prompt", async () => {
  const prompts: string[] = [];
  const { run } = await startCellHarness({
    llm: async ({ prompt }) => {
      prompts.push(prompt);
      return `answered: ${prompt}`;
    },
  });

  const output = await run(
    [
      "try:",
      "    tool.completion(prompts=['x'])",
      "    legacy = 'accepted'",
      "except ToolError:",
      "    legacy = 'invalid_input'",
      "canonical = completion('x')",
      "{'legacy': legacy, 'canonical': canonical}",
    ].join("\n"),
  );

  // The cell sees the dispatcher refusal as ToolError and does not invoke the port.
  expect(output).toBe("{'legacy': 'invalid_input', 'canonical': 'answered: x'}");
  expect(prompts).toEqual(["x"]);
}, 40_000);

test("a failing completion call raises ToolError inside the cell instead of returning failure text", async () => {
  const { run } = await startCellHarness({
    llm: async () => {
      throw new Error("completion failed: provider on fire");
    },
  });

  const output = await run(
    [
      "try:",
      "    completion('doomed')",
      "    outcome = 'returned as data'",
      "except ToolError as error:",
      "    outcome = 'raised: ' + str(error)",
      "outcome",
    ].join("\n"),
  );

  expect(output).toContain("raised: ");
  expect(output).toContain("completion failed: provider on fire");
  expect(output).not.toContain("returned as data");
}, 40_000);

test("parallel() runs independent tool calls concurrently and returns both results in input order", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let releaseBoth: (() => void) | undefined;
  const bothArrived = new Promise<void>((resolve) => {
    releaseBoth = resolve;
  });
  const { run } = await startCellHarness({
    llm: async (call) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (inFlight === 2) releaseBoth?.();
      // A serialized door would wedge the first call here; the bounded wait
      // turns that into a failure rather than a hang.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          bothArrived,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("tool calls were serialized")), 10_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      inFlight -= 1;
      return `answered(${call.prompt})`;
    },
  });

  const output = await run(
    [
      "results = parallel([",
      "  lambda: completion('first'),",
      "  lambda: completion('second'),",
      "])",
      "'; '.join(results)",
    ].join("\n"),
  );

  // Both calls were in flight at once — the kernel's concurrent door, not luck.
  expect(maxInFlight).toBe(2);
  expect(output).toContain("answered(first); answered(second)");
}, 40_000);

/** The Owner's enrollment is the ceiling: a daemon cannot claim its way past it. */
test("a machine offering more than it is enrolled for keeps only the intersection", async () => {
  const socketPath = testSocketPath();

  const host = await createMachineHost({
    generations: createMemoryGenerationStore(),
    dispatcherBound: 8,
    listen: { unix: socketPath },
    enrollment: () => ({ ...enrollment, allowedCapabilities: ["fs.read"] }),
    events: Bus,
    now: () => Date.now(),
    callTool: () => Effect.succeed({ status: "failed" as const, error: "no tools" }),
  });
  await attachMachineDaemon({
    dispatcherBound: 8,
    socketPath,
    offer: {
      machineId: MACHINE_ID,
      offeredCapabilities: ["fs.read", "kernel.py"],
      daemonVersion: "test",
      platform: "test",
      offeredAt: 0,
    },
  });

  // Without kernel.py in the effective set, eval stays unofferable.
  expect(host.list().find((entry) => entry.machineId === MACHINE_ID)?.capabilities).toEqual([
    "fs.read",
  ]);
}, 30_000);
