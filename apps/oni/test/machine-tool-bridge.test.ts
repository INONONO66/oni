import { runEffect, acquireEffect } from "./helpers/scoped-effect";
import { Effect } from "effect";
import { beforeAll, describe, expect, test } from "bun:test";
import { connectIpcClient, createMachineHost, createMemoryGenerationStore, typedCall } from "@oni/machines";
import { Machine } from "@oni/protocol";
import type { MachineHost } from "@oni/machines";
import type { PlainObject } from "@oni/protocol";
import { MachineCellError } from "@oni/machines";
import { socketPath } from "./helpers/socket-path";

import { bridgeClient, bridgeHost, bridgeOffer, bridgeProbe } from "./helpers/machine-bridge";
import { dispatchModelTool } from "./helpers/tool-dispatch";
import { testMachinePorts } from "./helpers/native-tool-ports";
import { testIds } from "./helpers/test-entropy";
import { refusingToolPort } from "./helpers/tool-port";
import { attachAppMclient, mclientBinary } from "./helpers/mclient";
import { Bus } from "./helpers/bus";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
beforeAll(mclientBinary, 300_000);

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
  const client = await bridgeClient(path);
  try {
    await run({ host, calls });
  } finally {
    await client.stop();
    await runEffect(host.close());
  }
}

/** The canonical client handshake: attach a live connection as machine m-1. */
function attachAsBridgeMachine(client: Effect.Success<ReturnType<typeof connectIpcClient>>) {
  return runEffect(typedCall(client, Machine.WireMethod.Attach, {
    ...bridgeOffer(), peer: { kind: "client", contractVersion: Machine.contractVersion },
  }, 5000));
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
    const client = await acquireEffect(connectIpcClient(path, {
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
      await attachAsBridgeMachine(client);
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
      await runEffect(client.close());
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

  test("an attached client cannot invoke tools outside a cell the host dispatched", async () => {
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
    // A stand-in client: it answers RunCell itself, so the replay below comes
    // from the very connection the cell ran on — the only way to prove the
    // cell is retired rather than merely unknown to some other connection.
    const client = await acquireEffect(connectIpcClient(path, {
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
      await attachAsBridgeMachine(client);
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
          client,
          Machine.WireMethod.CallTool,
          { cellId: "spent", name: "add", arguments: {} },
          5000,
        )),
      ).rejects.toThrow("no cell in flight: spent");
      expect(reached()).toBe(false);
    } finally {
      await runEffect(client.close());
      await runEffect(host.close());
    }
  });

  test("a superseded client loses tool access mid-cell without wedging it", async () => {
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
    const first = await attachAppMclient({ socketPath: path, machineId: "m-1", root: "/tmp", exports: [] });
    let second: Awaited<ReturnType<typeof attachAppMclient>> | undefined;
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
      const outcome = cell.then(
        (value) => ({ value }),
        (error: Error) => ({ error }),
      );

      // Take the machine over while the cell sits inside its first tool call.
      await firstCallEntered;
      second = await attachAppMclient({ socketPath: path, machineId: "m-1", root: "/tmp", exports: [] });
      release();

      // Supersession closes the old transport, so its in-flight cell fails
      // once rather than waiting on a tool answer from the revoked client.
      expect(await outcome).toMatchObject({
        error: { _tag: "MachineRefusalError", reason: "disconnected" },
      });
      expect(calls).toBe(1);
    } finally {
      release();
      await first.stop();
      if (second !== undefined) await second.stop();
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
      // A forged cell id is rejected at the driver boundary before any host call.
      await expect(runEffect(host.get("m-1").runCode({
        cellId: "honest",
        code: [
          "import json, sys",
          "sys.__stdout__.write(json.dumps({",
          "    'kind': 'tool_call', 'callId': 'forged', 'cellId': 'someone-else',",
          "    'name': 'add', 'arguments': {'a': 1, 'b': 2},",
          "}) + '\\n')",
          "sys.__stdout__.flush()",
        ].join("\n"),
        timeoutMs: 15_000,
      }))).rejects.toThrow("invalid python driver frame: tool call for another cell");
      expect(calls).toEqual([]);
      const result = await runEffect(host.get("m-1").runCode({
        cellId: "after-forgery", code: "tool.add(a=2, b=3)", timeoutMs: 15_000,
      }));
      expect(result).toMatchObject({ status: "completed", value: "5" });
      expect(calls.map((call) => call.name)).toEqual(["add"]);
      expect(calls[0]).toMatchObject({ cellId: "after-forgery", arguments: { a: 2, b: 3 } });
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
    const client = await bridgeClient(path);
    try {
      const result = await runEffect(host.get("m-1").runCode({
        cellId: "no-tools",
        code: "tool.add(a=1, b=2)",
        timeoutMs: 15_000,
      }));

      expect(result).toMatchObject({ status: "raised" });
      expect(result.status === "raised" && result.error).toContain("host_tool_missing");
    } finally {
      await client.stop();
      await runEffect(host.close());
    }
  });
});

/**
 * bash{session} door (#1273): the existing bash tool drives a named
 * persistent tmux terminal on the client. Real tmux on a private socket.
 */
describe("bash session door", () => {
  const TMUX_SOCKET = `oo-1273-bridge-${process.pid}`;
  async function sessionFixture(
    run: (api: {
      bash: ReturnType<typeof dispatchModelTool>;
      stdoutUntil: (marker: string, command: string) => Promise<string>;
      restartClient: () => Promise<void>;
    }) => Promise<void>,
  ) {
    const path = socketPath();
    const host = await acquireEffect(createMachineHost({
      generations: createMemoryGenerationStore(),
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
      events: Bus,
      now: () => 5000,
    }));
    // A restarted client mints a new cursor generation while tmux retains
    // the pane, so a cursor from the old process cannot skip new output.
    const attach = () => attachAppMclient({
      socketPath: path, machineId: "m-1", root: "/",
      exports: [{ name: "shell", path: "/" }], tmuxSocket: TMUX_SOCKET,
    });
    let client = await attach();
    const bash = dispatchModelTool("bash", { machines: testMachinePorts(host) });
    // Each bash call long-polls the client for terminal output; the loop
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
        restartClient: async () => {
          await client.stop();
          client = await attach();
        },
      });
    } finally {
      await client.stop();
      await runEffect(host.close());
      Bun.spawnSync(["tmux", "-L", TMUX_SOCKET, "kill-server"]);
    }
  }

  test("a named session keeps shell state across calls and across a client restart", async () => {
    await sessionFixture(async ({ bash, stdoutUntil, restartClient }) => {
      const exported = await bash({ machine: "m-1", session: "qa", command: "export BRIDGE_X=42" } satisfies PlainObject);
      expect(JSON.parse(String(exported.content))).toMatchObject({ exitCode: 0, pending: false });
      expect(await stdoutUntil("door-42", "echo door-$BRIDGE_X")).toContain("door-42");
      // Restart ONLY the client; the tmux server owns the terminal.
      await restartClient();
      expect(await stdoutUntil("again-42", "echo again-$BRIDGE_X")).toContain("again-42");
    });
  }, 60_000);

  test("session calls refuse exactly the inputs the terminal cannot honour", async () => {
    await sessionFixture(async ({ bash }) => {
      expect(await bash({ session: "qa", command: "true" })).toMatchObject({ isError: true });
      expect(await bash({ machine: "m-1", session: "qa", command: "true", timeout: 5 })).toMatchObject({ isError: true });
      expect(await bash({ machine: "m-1", command: "" })).toMatchObject({ isError: true });
      // The client's reserved control session is a typed refusal end to end.
      expect(await bash({ machine: "m-1", session: "oni-pty-control", command: "" })).toMatchObject({ isError: true });
      // An unknown name is not an error at this door: open-or-reattach creates it.
      const created = await bash({ machine: "m-1", session: "fresh", command: "" });
      expect(created.isError).toBeUndefined();
    });
  }, 60_000);
});
