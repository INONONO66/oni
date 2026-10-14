import { runEffect, acquireEffect, acquireSyncEffect } from "./helpers/scoped-effect";
import { Effect } from "effect";
import { createCodemode } from "@openomni/codemode";
import { describe, expect, test } from "bun:test";
import { connectIpcClient, createMachineHost, typedCall } from "@openomni/machines";
import { Machine } from "@openomni/protocol";
import { attachMachineDaemon } from "@openomni/machines";
import type { MachineHost } from "@openomni/machines";
import type { PlainObject } from "@openomni/protocol";
import { MachineCellError } from "@openomni/machines";
import { socketPath } from "./helpers/socket-path";

import { bridgeDaemon, bridgeHost, bridgeOffer, bridgeProbe } from "./helpers/machine-bridge";
import { dispatchModelTool } from "./helpers/tool-dispatch";
import { testMachinePorts } from "./helpers/native-tool-ports";
import { testIds } from "./helpers/test-entropy";
import { refusingToolPort } from "./helpers/tool-port";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * A host whose tool port only knows `add`, standing in for the composition
 * root's placement-gated executor: everything else comes back refused.
 */
async function withBridge(
  run: (context: { host: MachineHost; calls: Machine.ToolCall[] }) => Promise<void>,
  callTool?: (call: Machine.ToolCall) => Promise<Machine.ToolCallResult>,
): Promise<void> {
  const path = socketPath();
  const calls: Machine.ToolCall[] = [];
  const host = await bridgeHost(path, {
    callTool: async (call) => {
      calls.push(call);
      if (callTool) return callTool(call);
      if (call.name === "add") {
        return {
          status: "completed",
          value: (call.arguments.a as number) + (call.arguments.b as number),
        };
      }
      return { status: "failed", error: `tool is not offerable: ${call.name}` };
    },
  });
  const daemon = await bridgeDaemon(path);
  try {
    await run({ host, calls });
  } finally {
    await runEffect(daemon.close());
    await runEffect(host.close());
  }
}

/** The canonical daemon handshake: attach a live connection as machine m-1. */
function attachAsBridgeMachine(client: Effect.Success<ReturnType<typeof connectIpcClient>>) {
  return runEffect(typedCall(client, Machine.WireMethod.Attach, bridgeOffer(), 5000));
}

describe("code-mode tool bridge", () => {
  test("a cell reaches host tools repeatedly within one eval", async () => {
    await withBridge(async ({ host, calls }) => {
      // The whole point of code mode: two tool calls, one round trip.
      const result = await runEffect(host.get("m-1").runCode({
        cellId: "batch",
        code: "first = tool.add(a=1, b=2)\nsecond = tool.add(a=first, b=10)\nsecond",
        timeoutMs: 15_000,
      }));

      expect(result).toMatchObject({ status: "completed", value: "13" });
      expect(calls.map((call) => call.name)).toEqual(["add", "add"]);
      expect(calls[0]).toMatchObject({ cellId: "batch", arguments: { a: 1, b: 2 } });
    });
  });

  test("parallel tool calls overlap and interleaved answers route by callId in input order", async () => {
    const secondArrived = deferred<void>();
    let arrivals = 0;
    await withBridge(
      async ({ host }) => {
        const result = await runEffect(host.get("m-1").runCode({
          cellId: "parallel-routing",
          code: [
            "parallel([",
            "    lambda: tool.echo(value='left'),",
            "    lambda: tool.echo(value='right'),",
            "])",
          ].join("\n"),
          timeoutMs: 15_000,
        }));

        expect(result).toMatchObject({
          status: "completed",
          value: "['answer:left', 'answer:right']",
        });
      },
      async (call) => {
        arrivals += 1;
        if (arrivals === 1) {
          await secondArrived.promise;
        } else {
          secondArrived.resolve();
        }
        return { status: "completed", value: `answer:${String(call.arguments.value)}` };
      },
    );
    expect(arrivals).toBe(2);
  });

  test("completion calls the cell-only tool with one prompt and returns its value unchanged", async () => {
    await withBridge(
      async ({ host, calls }) => {
        const result = await runEffect(host.get("m-1").runCode({
          cellId: "completion-sugar",
          code: "completion('summarize this')",
          timeoutMs: 15_000,
        }));

        expect(result).toMatchObject({ status: "completed", value: "'summary'" });
        expect(calls).toEqual([
          {
            cellId: "completion-sugar",
            name: "completion",
            arguments: { prompt: "summarize this" },
          },
        ]);
      },
      () => Promise.resolve({ status: "completed", value: "summary" }),
    );
  });

  test("parallel batches completion calls and returns results in input order", async () => {
    await withBridge(
      async ({ host, calls }) => {
        const result = await runEffect(host.get("m-1").runCode({
          cellId: "completion-parallel",
          code: "parallel([lambda: completion('first'), lambda: completion('second')])",
          timeoutMs: 15_000,
        }));

        expect(result).toMatchObject({
          status: "completed",
          value: "['summary:first', 'summary:second']",
        });
        // Threads race to the door; the cell still returns results in input order.
        expect(calls.map((call) => call.arguments.prompt).sort()).toEqual(["first", "second"]);
      },
      (call) =>
        Promise.resolve({ status: "completed", value: `summary:${String(call.arguments.prompt)}` }),
    );
  });

  test("parallel waits for other thunks before propagating an exception", async () => {
    const completed = deferred<void>();
    await withBridge(
      async ({ host, calls }) => {
        const result = await runEffect(host.get("m-1").runCode({
          cellId: "parallel-error",
          code: [
            "def fail():",
            "    raise ValueError('parallel boom')",
            "parallel([fail, lambda: tool.complete()])",
          ].join("\n"),
          timeoutMs: 15_000,
        }));

        expect(result.status).toBe("raised");
        expect(result.status === "raised" && result.error).toContain("ValueError: parallel boom");
        expect(calls.map((call) => call.name)).toEqual(["complete"]);
        await completed.promise;
      },
      () => {
        completed.resolve();
        return Promise.resolve({ status: "completed", value: "done" });
      },
    );
  });

  test("a tool the host refuses raises a catchable error and does not run", async () => {
    await withBridge(async ({ host, calls }) => {
      const result = await runEffect(host.get("m-1").runCode({
        cellId: "refused",
        code: [
          "try:",
          "    tool.not_offerable(x=1)",
          "    outcome = 'tool ran'",
          "except ToolError as error:",
          "    outcome = 'refused: ' + str(error)",
          "outcome",
        ].join("\n"),
        timeoutMs: 15_000,
      }));

      expect(result).toMatchObject({
        status: "completed",
        value: "'refused: tool is not offerable: not_offerable'",
      });
      // The host saw the attempt and answered it; nothing executed on its side.
      expect(calls.map((call) => call.name)).toEqual(["not_offerable"]);
    });
  });

  test("a dotted tool name reaches the host under its canonical spelling", async () => {
    await withBridge(async ({ host, calls }) => {
      await runEffect(host.get("m-1").runCode({
        cellId: "dotted",
        code: "try:\n    tool['screen.capture'](region='full')\nexcept ToolError:\n    pass",
        timeoutMs: 15_000,
      }));

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        name: "screen.capture",
        arguments: { region: "full" },
      });
    });
  });

  test("a tool that fails on the host surfaces the failure inside the cell", async () => {
    await withBridge(
      async ({ host }) => {
        const result = await runEffect(host.get("m-1").runCode({
          cellId: "failing",
          code: "tool.add(a=1, b=2)",
          timeoutMs: 15_000,
        }));

        expect(result).toMatchObject({ status: "raised" });
        expect(result.status === "raised" && result.error).toContain("disk on fire");
      },
      () => Promise.resolve({ status: "failed", error: "disk on fire" }),
    );
  });

  test("a cell blocked on a slow tool still honours its deadline and recovers", async () => {
    await withBridge(
      async ({ host }) => {
        const blocked = await runEffect(host.get("m-1").runCode({
          cellId: "blocked",
          code: "tool.add(a=1, b=2)",
          timeoutMs: 800,
        }));
        expect(blocked).toMatchObject({ status: "timed_out", cellId: "blocked" });

        // The interpreter was replaced while it sat inside a tool call; the
        // next cell must still get a working one.
        const next = await runEffect(host.get("m-1").runCode({
          cellId: "after",
          code: "'alive'",
          timeoutMs: 15_000,
        }));
        expect(next).toMatchObject({ status: "completed", value: "'alive'" });
      },
      () => new Promise<Machine.ToolCallResult>(() => undefined),
    );
  });

  test("a duplicate in-flight cellId is refused with a typed error on a live connection", async () => {
    const path = socketPath();
    const host = await bridgeHost(path);
    let announceFirst!: () => void;
    const firstReceived = new Promise<void>((resolve) => {
      announceFirst = resolve;
    });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let runCellRequests = 0;
    const daemon = await acquireEffect(connectIpcClient(path, {
      dispatcherBound: 8,
      idSource: testIds("ipc"),
      onRequest: (method, params, respond) => Effect.promise(async () => {
        if (method !== Machine.WireMethod.RunCode) return;
        runCellRequests += 1;
        const request = Machine.CellRequest.parse(params);
        announceFirst();
        await firstBlocked;
        respond({
          status: "completed",
          cellId: request.cellId,
          output: { stdout: "", stderr: "" },
        });
      }),
    }));
    try {
      await attachAsBridgeMachine(daemon);
      const first = runEffect(host.get("m-1").runCode({
        cellId: "duplicate",
        code: "'first'",
        timeoutMs: 15_000,
      }));
      await firstReceived;

      const duplicateError = await runEffect(Effect.flip(host.get("m-1").runCode({
        cellId: "duplicate",
        code: "'second'",
        timeoutMs: 15_000,
      })));
      expect(duplicateError).toBeInstanceOf(MachineCellError);
      if (!(duplicateError instanceof MachineCellError)) {
        throw new Error("expected a typed duplicate-cell refusal");
      }
      expect(duplicateError).toMatchObject({
        _tag: "MachineCellError",
        code: "duplicate_cell_id",
        cellId: "duplicate",
      });
      expect(runCellRequests).toBe(1);

      releaseFirst();
      await expect(first).resolves.toMatchObject({ status: "completed", cellId: "duplicate" });
    } finally {
      releaseFirst();
      await runEffect(daemon.close());
      await runEffect(host.close());
    }
  });

  test("a connection that never attached cannot reach host tools", async () => {
    const path = socketPath();
    const { host, reached } = await bridgeProbe(path);
    // A bare connection: no offer, no attach, straight to the tool channel.
    const intruder = await acquireEffect(connectIpcClient(path, { idSource: testIds("ipc"), dispatcherBound: 8 }));
    try {
      await expect(
        runEffect(typedCall(
          intruder,
          Machine.WireMethod.CallTool,
          { cellId: "c", name: "add", arguments: {} },
          5000,
        )),
      ).rejects.toThrow("no cell in flight: c");
      expect(reached()).toBe(false);
    } finally {
      await runEffect(intruder.close());
      await runEffect(host.close());
    }
  });

  test("an attached daemon cannot invoke tools outside a cell the host dispatched", async () => {
    const path = socketPath();
    const { host, reached } = await bridgeProbe(path);
    const client = await acquireEffect(connectIpcClient(path, { idSource: testIds("ipc"), dispatcherBound: 8 }));
    try {
      await attachAsBridgeMachine(client);
      // Attached, but this host never dispatched a cell called "ghost".
      // (See the sibling test for a cellId that WAS dispatched and settled.)
      await expect(
        runEffect(typedCall(
          client,
          Machine.WireMethod.CallTool,
          { cellId: "ghost", name: "add", arguments: {} },
          5000,
        )),
      ).rejects.toThrow("no cell in flight: ghost");
      expect(reached()).toBe(false);
    } finally {
      await runEffect(client.close());
      await runEffect(host.close());
    }
  });

  test("a cellId stops working the moment its cell settles", async () => {
    const path = socketPath();
    const { host, reached } = await bridgeProbe(path);
    // A stand-in daemon: it answers RunCell itself, so the replay below comes
    // from the very connection the cell ran on — the only way to prove the
    // cell is retired rather than merely unknown to some other connection.
    const daemon = await acquireEffect(connectIpcClient(path, {
      dispatcherBound: 8,
      idSource: testIds("ipc"),
      onRequest: (method, _params, respond) => Effect.sync(() => {
        if (method === Machine.WireMethod.RunCode) {
          respond({
            status: "completed",
            cellId: "spent",
            output: { stdout: "", stderr: "" },
          });
        }
      }),
    }));
    try {
      await attachAsBridgeMachine(daemon);
      const cell = await runEffect(host.get("m-1").runCode({
        cellId: "spent",
        code: "'done'",
        timeoutMs: 15_000,
      }));
      expect(cell).toMatchObject({ status: "completed" });

      // Same connection, same cellId — but the cell is over, so its name
      // buys nothing. This is what a background thread leaking a call after
      // its cell returned looks like from the host's side.
      await expect(
        runEffect(typedCall(
          daemon,
          Machine.WireMethod.CallTool,
          { cellId: "spent", name: "add", arguments: {} },
          5000,
        )),
      ).rejects.toThrow("no cell in flight: spent");
      expect(reached()).toBe(false);
    } finally {
      await runEffect(daemon.close());
      await runEffect(host.close());
    }
  });

  test("a superseded daemon loses tool access mid-cell without wedging it", async () => {
    const path = socketPath();
    let release: () => void = () => {
      return;
    };
    const firstCallBlocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let announceEntered: () => void = () => {
      return;
    };
    const firstCallEntered = new Promise<void>((resolve) => {
      announceEntered = resolve;
    });
    let calls = 0;
    const host = await bridgeHost(path, {
      callTool: async () => {
        calls += 1;
        if (calls === 1) {
          announceEntered();
          await firstCallBlocked;
        }
        return { status: "completed", value: calls };
      },
    });
    const offer = bridgeOffer();
    const first = await acquireEffect(attachMachineDaemon({
      dispatcherBound: 8,
      id: testIds("bridge-first"),
      runner: acquireSyncEffect(createCodemode({ id: testIds("bridge-first-cell") })).runner,
      socketPath: path,
      offer,
    }));
    let second: Effect.Success<ReturnType<typeof attachMachineDaemon>> | undefined;
    try {
      const cell = runEffect(host.get("m-1").runCode({
        cellId: "live",
        code: [
          "a = tool.t()",
          "try:",
          "    b = tool.t()",
          "except ToolError as error:",
          "    b = 'lost'",
          "(a, b)",
        ].join("\n"),
        timeoutMs: 15_000,
      }));

      // Take the machine over while the cell sits inside its first tool call.
      await firstCallEntered;
      second = await acquireEffect(attachMachineDaemon({
        dispatcherBound: 8,
        id: testIds("bridge-second"),
        runner: acquireSyncEffect(createCodemode({ id: testIds("bridge-second-cell") })).runner,
        socketPath: path,
        offer,
      }));
      release();

      // Being superseded revokes tools, but the cell still finishes on its
      // own terms instead of hanging on an answer that will never come.
      const result = await cell;
      expect(result).toMatchObject({ status: "completed", value: "(1, 'lost')" });
    } finally {
      await runEffect(first.close());
      if (second !== undefined) await runEffect(second.close());
      await runEffect(host.close());
    }
  });

  test("a thread outliving its cell is refused tools instead of inheriting the next cell", async () => {
    await withBridge(async ({ host, calls }) => {
      // The reviewer's exploit: cell one leaves a thread behind, cell two
      // wakes it, and the call — if allowed — would run under cell two's
      // identity, catalog, and budget. join() makes the ordering exact.
      const armed = await runEffect(host.get("m-1").runCode({
        cellId: "cell-one",
        code: [
          "import threading",
          "evt = threading.Event()",
          "box = []",
          "def late():",
          "    evt.wait()",
          "    try:",
          "        tool.add(a=1, b=2)",
          "        box.append('ran')",
          "    except ToolError as error:",
          "        box.append('refused: ' + str(error))",
          "leak = threading.Thread(target=late)",
          "leak.start()",
          "'armed'",
        ].join("\n"),
        timeoutMs: 15_000,
      }));
      expect(armed).toMatchObject({ status: "completed", value: "'armed'" });

      const outcome = await runEffect(host.get("m-1").runCode({
        cellId: "cell-two",
        code: "evt.set()\nleak.join()\nbox[0]",
        timeoutMs: 15_000,
      }));
      expect(outcome.status).toBe("completed");
      expect(outcome.status === "completed" && outcome.value).toContain("tool call refused");
      expect(calls).toEqual([]);
    });
  });

  test("a forged frame claiming another cell is refused without a host call", async () => {
    await withBridge(async ({ host, calls }) => {
      // Cell code can write raw frames to the driver's real stdout. A frame
      // stamped with a different cellId must never become a host call; the
      // legit call after it proves the kernel kept serving this cell.
      const result = await runEffect(host.get("m-1").runCode({
        cellId: "honest",
        code: [
          "import json, sys",
          "sys.__stdout__.write(json.dumps({",
          "    'kind': 'tool_call', 'callId': 'forged', 'cellId': 'someone-else',",
          "    'name': 'add', 'arguments': {'a': 1, 'b': 2},",
          "}) + '\\n')",
          "sys.__stdout__.flush()",
          "tool.add(a=2, b=3)",
        ].join("\n"),
        timeoutMs: 15_000,
      }));

      expect(result).toMatchObject({ status: "completed", value: "5" });
      expect(calls.map((call) => call.name)).toEqual(["add"]);
      expect(calls[0]).toMatchObject({ cellId: "honest", arguments: { a: 2, b: 3 } });
    });
  });

  test("each tenant gets its own interpreter: state persists within, never across", async () => {
    await withBridge(async ({ host }) => {
      const set = await runEffect(host.get("m-1").runCode({
        cellId: "a-1",
        code: "x = 41\n'set'",
        timeoutMs: 15_000,
        tenant: "session-a",
      }));
      expect(set).toMatchObject({ status: "completed" });

      const sameTenant = await runEffect(host.get("m-1").runCode({
        cellId: "a-2",
        code: "x + 1",
        timeoutMs: 15_000,
        tenant: "session-a",
      }));
      expect(sameTenant).toMatchObject({ status: "completed", value: "42" });

      const otherTenant = await runEffect(host.get("m-1").runCode({
        cellId: "b-1",
        code: "x",
        timeoutMs: 15_000,
        tenant: "session-b",
      }));
      expect(otherTenant.status).toBe("raised");
      expect(otherTenant.status === "raised" && otherTenant.error).toContain("NameError");

      // Back-compat: a tenantless request reads as the "default" tenant and
      // shares one interpreter with other tenantless requests.
      await runEffect(host.get("m-1").runCode({ cellId: "d-1", code: "y = 7", timeoutMs: 15_000 }));
      const defaulted = await runEffect(host
        .get("m-1")
        .runCode({ cellId: "d-2", code: "y", timeoutMs: 15_000 }));
      expect(defaulted).toMatchObject({ status: "completed", value: "7" });
    });
  });

  test("a host wired without a tool port says so instead of pretending", async () => {
    const path = socketPath();
    const host = await bridgeHost(path);
    const daemon = await bridgeDaemon(path);
    try {
      const result = await runEffect(host.get("m-1").runCode({
        cellId: "no-tools",
        code: "tool.add(a=1, b=2)",
        timeoutMs: 15_000,
      }));

      expect(result).toMatchObject({ status: "raised" });
      expect(result.status === "raised" && result.error).toContain("host_tool_missing");
    } finally {
      await runEffect(daemon.close());
      await runEffect(host.close());
    }
  });
});

/**
 * bash{session} door (#1273): the existing bash tool drives a named
 * persistent tmux terminal on the daemon. Real tmux on a private socket.
 */
describe("bash session door", () => {
  const TMUX_SOCKET = `oo-1273-bridge-${process.pid}`;
  const offer: Machine.Offer = {
    machineId: "m-1",
    daemonVersion: "0.1.0",
    platform: "darwin",
    offeredAt: 2000,
    offeredCapabilities: ["pty.session"],
    exports: [{ name: "shell", path: "/" }],
  };
  async function sessionFixture(
    run: (api: {
      bash: ReturnType<typeof dispatchModelTool>;
      stdoutUntil: (marker: string, command: string) => Promise<string>;
      restartDaemon: () => Promise<void>;
    }) => Promise<void>,
  ) {
    const path = socketPath();
    const host = await acquireEffect(createMachineHost({
      dispatcherBound: 8,
      callTool: refusingToolPort,
      listen: { unix: path },
      id: testIds("pty-bridge-host"),
      enrollment: () => ({
        name: "workstation",
        machineId: "m-1",
        allowedCapabilities: ["pty.session"],
        allowedExports: ["shell"],
        publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        enrolledAt: 1000,
      }),
      events: { publish: () => undefined },
      now: () => 5000,
    }));
    // Each daemon generation mints ids from its own stream, as production
    // entropy does: reusing the registry generation id across a restart lets
    // a pre-restart cursor parse as a native offset into the new daemon's
    // stream and skip output (PR #1283 CI, tmux 3.4 runner).
    let generation = 0;
    const daemonOptions = () => {
      generation += 1;
      return {
        socketPath: path,
        id: testIds(`pty-bridge-daemon-g${generation}`),
        dispatcherBound: 8,
        offer,
        fsExports: new Map([["shell", "/"]]),
        pty: { socketName: TMUX_SOCKET },
      };
    };
    let daemon = await acquireEffect(attachMachineDaemon(daemonOptions()));
    const bash = dispatchModelTool("bash", { machines: testMachinePorts(host) });
    // Each bash call long-polls the daemon for terminal output; the loop
    // re-reads (empty command = just read) until the marker byte arrives.
    async function stdoutUntil(marker: string, command: string): Promise<string> {
      let seen = "";
      for (let call = 0; call < 10 && !seen.includes(marker); call += 1) {
        const result = await bash({ machine: "m-1", session: "qa", command: call === 0 ? command : "" } satisfies PlainObject);
        expect(result.isError).toBeUndefined();
        seen += (JSON.parse(String(result.content)) as { stdout: string }).stdout;
      }
      return seen;
    }
    try {
      await run({
        bash,
        stdoutUntil,
        restartDaemon: async () => {
          await runEffect(daemon.close());
          daemon = await acquireEffect(attachMachineDaemon(daemonOptions()));
        },
      });
    } finally {
      await runEffect(daemon.close());
      await runEffect(host.close());
      Bun.spawnSync(["tmux", "-L", TMUX_SOCKET, "kill-server"]);
    }
  }

  test("a named session keeps shell state across calls and across a daemon restart", async () => {
    await sessionFixture(async ({ bash, stdoutUntil, restartDaemon }) => {
      const exported = await bash({ machine: "m-1", session: "qa", command: "export BRIDGE_X=42" } satisfies PlainObject);
      expect(JSON.parse(String(exported.content))).toMatchObject({ exitCode: 0, pending: false });
      expect(await stdoutUntil("door-42", "echo door-$BRIDGE_X")).toContain("door-42");
      // Restart ONLY the daemon; the tmux server owns the terminal.
      await restartDaemon();
      expect(await stdoutUntil("again-42", "echo again-$BRIDGE_X")).toContain("again-42");
    });
  }, 60_000);

  test("session calls refuse exactly the inputs the terminal cannot honour", async () => {
    await sessionFixture(async ({ bash }) => {
      expect(await bash({ session: "qa", command: "true" })).toMatchObject({ isError: true });
      expect(await bash({ machine: "m-1", session: "qa", command: "true", timeout: 5 })).toMatchObject({ isError: true });
      expect(await bash({ machine: "m-1", command: "" })).toMatchObject({ isError: true });
      // The daemon's reserved control session is a typed refusal end to end.
      expect(await bash({ machine: "m-1", session: "omo-pty-control", command: "" })).toMatchObject({ isError: true });
      // An unknown name is not an error at this door: open-or-reattach creates it.
      const created = await bash({ machine: "m-1", session: "fresh", command: "" });
      expect(created.isError).toBeUndefined();
    });
  }, 60_000);
});
