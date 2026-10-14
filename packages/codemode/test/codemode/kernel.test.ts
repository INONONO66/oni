import { describe, expect, test } from "bun:test";
import { type BusEvent, Machine } from "@openomni/protocol";
import { attachMachineDaemon } from "../../../machines/test/helpers/native";
import { type MachineHost, createMachineHost } from "../../../machines/test/helpers/native";
import { PythonKernel } from "./helpers/native";
import { createCodemode } from "./helpers/native";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
const socketPath = () => join(tmpdir(), `oc-${crypto.randomUUID()}.sock`);
type CellToolCaller = Parameters<PythonKernel["run"]>[1];

/** These cells call no tools, so a call is a test bug and must be visible. */
const noTools: CellToolCaller = (call) =>
  Promise.resolve({ status: "failed", error: `unexpected tool call: ${call.name}` });

let cellCounter = 0;

// These tests assert cell execution, not attach telemetry.
const silent: BusEvent.Sink = {
  publish() {
    return;
  },
};

const enrollment: Machine.Enrollment = {
  name: "studio",
  machineId: "mac-studio",
  allowedCapabilities: ["kernel.py", "fs.read"],
  publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  enrolledAt: 1000,
};

function offer(capabilities: readonly Machine.CapabilityId[]): Machine.Offer {
  return {
    machineId: "mac-studio",
    daemonVersion: "0.0.1",
    platform: "darwin-arm64",
    offeredCapabilities: [...capabilities],
    offeredAt: 2000,
  };
}

/**
 * Real host + real daemon over a real unix socket. The daemon runs a real
 * python3 interpreter — these are integration tests of the kernel substrate,
 * so nothing about the transport or the interpreter is mocked.
 */
async function withMachine(
  capabilities: readonly Machine.CapabilityId[],
  run: (context: { host: MachineHost }) => Promise<void>,
  callTool?: (call: Machine.ToolCall) => Promise<Machine.ToolCallResult>,
): Promise<void> {
  const path = socketPath();
  const host = await createMachineHost({
    listen: { unix: path },
    enrollment: () => enrollment,
    events: silent,
    now: () => 5000,
    callTool,
  });
  const daemon = await attachMachineDaemon({
    runner: createCodemode().runner,
    socketPath: path,
    offer: offer(capabilities),
  });
  try {
    await run({ host });
  } finally {
    await daemon.close();
    host.close();
  }
}

function cell(code: string, timeoutMs = 15_000): Machine.CellRequest {
  cellCounter += 1;
  return { cellId: `cell-${cellCounter}-${code.length}`, code, timeoutMs };
}

describe("cell settlement ownership", () => {
  test("twelve completed tenants retire their real interpreters on process close", async () => {
    const children = new Map<string, { process: ChildProcessWithoutNullStreams; closed: Promise<void> }>();
    const mode = createCodemode({ onInterpreterSpawn: (tenant, process) => {
      const closed = new Promise<void>((resolve) => process.once("close", () => resolve()));
      children.set(tenant, { process, closed });
    } });
    try {
      for (let index = 0; index < 12; index += 1) {
        const tenant = `tenant-${index}`;
        const result = await mode.runner.runCode({ ...cell(`value = ${index}`), tenant }, noTools, new AbortController().signal);
        expect(result.status).toBe("completed");
      }
      expect(children.size).toBe(12);
      const before = [...children.values()].filter(({ process }) => process.exitCode === null && process.signalCode === null).length;
      await Promise.all([...children.keys()].map((tenant) => mode.retire(tenant)));
      await Promise.all([...children.values()].map(({ closed }) => closed));
      const after = [...children.values()].filter(({ process }) => process.exitCode === null && process.signalCode === null).length;
      console.log(`C1 interpreters: ${before} -> ${after} (12 distinct tenants)`);
      expect(before).toBeGreaterThan(0);
      expect(before).toBeLessThanOrEqual(8);
      expect(after).toBe(0);
      const fresh = await mode.runner.runCode({ ...cell("value"), tenant: "tenant-11" }, noTools, new AbortController().signal);
      expect(fresh.status).toBe("raised");
    } finally {
      await mode.close();
    }
  });

  test("retirement waits for a background cell's exact completion before closing its process", async () => {
    let process: ChildProcessWithoutNullStreams | undefined;
    const mode = createCodemode({ onInterpreterSpawn: (_tenant, child) => { process = child; } });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Machine.ToolCallResult>();
    try {
      const running = mode.runner.runCode({ ...cell("tool.hold()\n42"), tenant: "held" }, () => {
        entered.resolve();
        return release.promise;
      }, new AbortController().signal);
      await entered.promise;
      const retiring = mode.retire("held");
      expect(process?.exitCode).toBeNull();
      expect(process?.signalCode).toBeNull();
      release.resolve({ status: "completed" });
      expect(await running).toMatchObject({ status: "completed", value: "42" });
      await retiring;
      expect(process?.exitCode !== null || process?.signalCode !== null).toBe(true);
    } finally {
      release.resolve({ status: "completed" });
      await mode.close();
    }
  });

  test("a queued cell times out from its enqueue deadline without replacing the interpreter", async () => {
    const kernel = new PythonKernel();
    try {
      const first = kernel.run(
        {
          cellId: "blocking",
          code: "value = 42\nimport time\ntime.sleep(0.08)",
          timeoutMs: 15_000,
        },
        noTools,
      );
      const queued = kernel.run({ cellId: "queued", code: "value = 99", timeoutMs: 5 }, noTools);

      expect(await first).toMatchObject({ status: "completed", cellId: "blocking" });
      expect(await queued).toMatchObject({ status: "timed_out", cellId: "queued" });
      // The queued timeout never ran, so it must not discard the persistent interpreter.
      await expect(
        kernel.run({ cellId: "after-queue", code: "value", timeoutMs: 1_000 }, noTools),
      ).resolves.toMatchObject({
        status: "completed",
        cellId: "after-queue",
        value: "42",
      });
    } finally {
      await kernel.close();
    }
  });

  test("a replaced interpreter's exit never settles its successor's cell", async () => {
    // Queued in the same microtask as the timing-out cell, so the successor is
    // already pending when the killed interpreter's exit event lands. That is
    // the interleaving where a process that settles "whatever is pending"
    // instead of "its own cell" rejects work it never ran.
    const kernel = new PythonKernel();
    try {
      const [timedOut, successor] = await Promise.all([
        kernel.run(
          {
            cellId: "wedged",
            code: "import time\nwhile True: time.sleep(0.05)",
            timeoutMs: 700,
          },
          noTools,
        ),
        kernel.run({ cellId: "successor", code: "6 * 7", timeoutMs: 15_000 }, noTools),
      ]);

      expect(timedOut).toMatchObject({ status: "timed_out", cellId: "wedged" });
      expect(successor).toMatchObject({ status: "completed", cellId: "successor", value: "42" });
    } finally {
      await kernel.close();
    }
  });
});

describe("code-mode kernel substrate", () => {
  test("oversized streams retain a UTF-8 prefix and original byte counts", async () => {
    const kernel = new PythonKernel();
    try {
      const limit = Machine.CELL_OUTPUT_MAX_BYTES;
      const original = limit + 73;
      const result = await kernel.run(cell(`import sys\nprint("x" * ${limit - 2} + "€" * 25)\nprint("e" * ${original}, file=sys.stderr)`), noTools);
      if (result.status !== "completed") throw new Error(`expected completed, got ${result.status}`);
      expect(result.output.truncated).toEqual({
        stdout: { originalBytes: limit - 2 + 75 + 1 },
        stderr: { originalBytes: original + 1 },
      });
      const stdoutPrefix = result.output.stdout.slice(0, result.output.stdout.indexOf("\n[truncated:"));
      const stderrPrefix = result.output.stderr.slice(0, result.output.stderr.indexOf("\n[truncated:"));
      expect(Buffer.byteLength(stdoutPrefix)).toBe(limit - 2);
      expect(Buffer.byteLength(stderrPrefix)).toBe(limit);
      expect(result.output.stdout).toContain(`[truncated: ${limit + 74} bytes]`);
      expect(result.output.stderr).toContain(`[truncated: ${original + 1} bytes]`);
      expect(stdoutPrefix).not.toContain("\uFFFD");
      console.log(`C1 output: ${original + 1} -> ${Buffer.byteLength(stderrPrefix)} prefix bytes; originalBytes=${result.output.truncated?.stderr?.originalBytes}`);
      const small = await kernel.run(cell("print('small')"), noTools);
      if (small.status !== "completed") throw new Error("expected completed");
      expect(small.output).toEqual({ stdout: "small\n", stderr: "" });
    } finally {
      await kernel.close();
    }
  });

  test("browser transcript retains a UTF-8-safe tail under the ring limit", async () => {
    const kernel = new PythonKernel();
    try {
      const result = await kernel.run(cell([
        "import __main__",
        "client = __main__.BrowserClient('machine', '/tmp/profile', True)",
        "client._append_transcript(__main__._BROWSER_MARK + ' chromium-pid 12345')",
        "client._append_transcript('x' * 70000 + '€')",
        "snapshot = (len(client._transcript.encode('utf-8')), client._transcript.endswith('€'), client._chromium_pid())",
        "client._drain = lambda wait_ms=None: (client._append_transcript('READY' + 'x' * 70000) or 'READY' + 'x' * 70000)",
        "(snapshot, client._await_output(('READY',), max_reads=1))",
      ].join("\n")), noTools);
      expect(result).toMatchObject({ status: "completed", value: "((65536, True, 12345), 'READY')" });
      console.log("C1 browser transcript: 70000+ bytes -> 65536 bytes");
    } finally {
      await kernel.close();
    }
  });
  test("close() fails typed when the driver's browser cleanup is never acknowledged (#1293 grace expiry)", async () => {
    const kernel = new PythonKernel();
    // Wedge the driver's EOF cleanup hook: close() must not report success on
    // grace expiry, because an unacknowledged cleanup can leak Chromium. The
    // block is the adversarial condition under test, not a timing wait - the
    // assertion rides close()'s own bounded outcome.
    await expect(
      kernel.run(
        cell("import __main__, threading\n__main__._browser_close_all = lambda: threading.Event().wait()"),
        noTools,
      ),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(kernel.close()).rejects.toMatchObject({ _tag: "DriverFailure", operation: "driver.cleanup" });
    // The expired close SIGKILLed the driver; a second close is a clean no-op.
    await expect(kernel.close()).resolves.toBeUndefined();
  });

  test("close() decodes a failed cleanup step into a typed browser_cleanup_failed outcome (#1312)", async () => {
    const kernel = new PythonKernel();
    // A registered browser client whose chromium pid is already gone: the
    // cleanup's os.kill fails, the ack frame carries the failed step, and
    // close() surfaces it typed instead of resolving as a silent success.
    await expect(
      kernel.run(
        cell(
          [
            "import __main__",
            "c = __main__.BrowserClient('m-1', '/tmp/openomni-cleanup-test', True)",
            "c._transcript = __main__._BROWSER_MARK + ' chromium-pid 4194304'",
            "__main__._browser_clients[('m-1', '/tmp/openomni-cleanup-test')] = c",
          ].join("\n"),
        ),
        noTools,
      ),
    ).resolves.toMatchObject({ status: "completed" });
    const closed = await kernel.close().then(
      () => undefined,
      (error: Error) => error,
    );
    expect(closed).toMatchObject({ _tag: "CodemodeError", reason: "browser_cleanup_failed" });
    expect(String(closed)).toContain("kill_chromium");
    // The failed-cleanup close still tore the driver down; a second close is a no-op.
    await expect(kernel.close()).resolves.toBeUndefined();
  });

  test("close() during a wedged active cell fails typed instead of resolving without the cleanup ack (#1293 r2)", async () => {
    const kernel = new PythonKernel();
    // Mirrors the r2 review reproduction: the cell wedges the driver's EOF
    // cleanup hook and then blocks forever, so the cleanup ack can never
    // arrive. Event synchronization: the cell's real tool_call frame reaching
    // the host proves the cell is inside its blocking section before close()
    // is invoked; the host never answers, and close()'s own stdin EOF is what
    // fails the pending call (ToolError: driver stdin closed), after which the
    // cell wedges on the bare Event. No sleeps, no timing guesses.
    let armed!: () => void;
    const ready = new Promise<void>((resolve) => {
      armed = resolve;
    });
    const running = kernel.run(
      {
        cellId: "active-close-wedged",
        code: [
          "import __main__, threading",
          "__main__._browser_close_all = lambda: threading.Event().wait()",
          "try:",
          "    tool.block()",
          "except BaseException:",
          "    pass",
          "threading.Event().wait()",
        ].join("\n"),
        timeoutMs: 15_000,
      },
      () => {
        armed();
        return new Promise(() => {
          // Deliberately unanswered: the cell stays blocked until close()'s EOF.
        });
      },
    );
    await ready;
    // The wedged cell never returns to the driver loop, so _browser_close_all
    // never runs: close() must surface the unconfirmed teardown, not resolve.
    await expect(kernel.close()).rejects.toMatchObject({ _tag: "DriverFailure", operation: "driver.cleanup" });
    await expect(running).resolves.toMatchObject({ status: "cancelled", cellId: "active-close-wedged" });
  });

  test("close() during an active cell that can finish resolves only through the cleanup ack (#1293 r2)", async () => {
    const kernel = new PythonKernel();
    // Happy active-cell path: close()'s stdin EOF fails the cell's pending
    // tool call, the cell catches it and completes, the driver loop drains,
    // runs _browser_close_all() and emits the ack. Under the fixed contract an
    // unacknowledged teardown fails typed, so close() resolving undefined IS
    // the observed-ack witness.
    let armed!: () => void;
    const ready = new Promise<void>((resolve) => {
      armed = resolve;
    });
    const running = kernel.run(
      {
        cellId: "active-close-completes",
        code: ["try:", "    tool.block()", "except BaseException:", "    pass", "'survived eof'"].join("\n"),
        timeoutMs: 15_000,
      },
      () => {
        armed();
        return new Promise(() => {
          // Deliberately unanswered: the cell stays blocked until close()'s EOF.
        });
      },
    );
    await ready;
    await expect(kernel.close()).resolves.toBeUndefined();
    await expect(running).resolves.toMatchObject({
      status: "completed",
      cellId: "active-close-completes",
      value: "'survived eof'",
    });
  });

  test("a normally resolving tool callback racing close() settles through the ack with the cell completed (#1293 r3)", async () => {
    const kernel = new PythonKernel();
    // r3 HIGH regression: while close() awaits the cleanup ack the cell is
    // still pending, so a host tool callback that resolves NORMALLY after
    // close()'s stdin EOF previously reached stdin.write() on the ended
    // stream - the asynchronous ERR_STREAM_WRITE_AFTER_END escaped every
    // Effect boundary as an unhandled error (process exit 1) even though
    // close() and the cell both settled fine. Event synchronization, no
    // sleeps: the ready tool_call frame proves the cell is blocked on the
    // host before close() is invoked; the answer is released only after
    // close() is in flight, so its delivery races the EOF. Under the fixed
    // contract the late delivery is a typed refusal, never a stream write:
    // Bun's unhandled-error detection stays intact, so a write-after-end
    // fails this run. Both orderings converge on the same observables - the
    // driver-side call fails via EOF (or is answered just before it), the
    // cell catches ToolError and completes, the drained driver runs its
    // cleanup and acks - so close() resolving undefined is the ack witness.
    let armed!: () => void;
    const toolCalled = new Promise<void>((resolve) => {
      armed = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = kernel.run(
      {
        cellId: "active-close-normal-answer",
        code: ["try:", "    tool.ready()", "except ToolError:", "    pass", "'answered'"].join("\n"),
        timeoutMs: 15_000,
      },
      () => {
        armed();
        return released.then(() => ({ status: "completed", value: null }) as const);
      },
    );
    await toolCalled;
    const closing = kernel.close();
    release();
    await expect(closing).resolves.toBeUndefined();
    await expect(running).resolves.toMatchObject({
      status: "completed",
      cellId: "active-close-normal-answer",
      value: "'answered'",
    });
  });

  test("the close race with a normally resolving tool callback never crashes the process with write-after-end (#1293 r3)", () => {
    // The pre-fix failure mode is an UNHANDLED asynchronous stream error:
    // inside the test harness Bun's scheduling lets the ended stdin finish and
    // destroy before the late answer lands, where Bun drops the write
    // silently - the crash window (ended, not yet finished) is only hit under
    // plain process scheduling. So the race runs in a real child bun process
    // whose exit code carries the runtime's intact unhandled-error detection:
    // before the fix this deterministically exited 1 with
    // ERR_STREAM_WRITE_AFTER_END; under the fixed contract the late delivery
    // is a typed refusal that never touches the stream, so the child prints
    // both contract markers and exits 0. Bounded by the child's own cell
    // timeout; no sleeps.
    const child = Bun.spawnSync({
      cmd: [process.execPath, join(import.meta.dir, "helpers", "close-race-normal-answer.ts")],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = child.stdout.toString();
    expect(child.stderr.toString()).not.toContain("write after end");
    expect(stdout).toContain("CLOSE_OK");
    expect(stdout).toContain("CELL completed");
    expect(child.exitCode).toBe(0);
  });

  test("invalid driver output replaces the interpreter", async () => {
    const kernel = new PythonKernel();
    try {
      await expect(
        kernel.run(
          { cellId: "before-invalid-driver-output", code: "persisted = 42", timeoutMs: 15_000 },
          noTools,
        ),
      ).resolves.toMatchObject({ status: "completed" });
      await expect(
        kernel.run(
          {
            cellId: "invalid-driver-output",
            code: "import sys\nsys.__stdout__.write('not-json\\n')\nsys.__stdout__.flush()",
            timeoutMs: 1_000,
          },
          noTools,
        ),
      ).rejects.toMatchObject({ message: "invalid driver frame" });
      await expect(
        kernel.run(
          { cellId: "after-invalid-driver-output", code: "persisted", timeoutMs: 15_000 },
          noTools,
        ),
      ).resolves.toMatchObject({ status: "raised" });
    } finally {
      await kernel.close();
    }
  });

  test("a rejected host tool preserves its message in the cell error", async () => {
    const kernel = new PythonKernel();
    try {
      const result = await kernel.run(
        { cellId: "tool-error-message", code: "tool.test()", timeoutMs: 15_000 },
        async () => {
          throw new Error("disk on fire");
        },
      );
      expect(result).toMatchObject({ status: "raised" });
      if (result.status !== "raised") throw new Error("expected raised cell");
      expect(result.error).toContain("disk on fire");
    } finally {
      await kernel.close();
    }
  });

  test("an unserializable tool answer rejects the owning cell", async () => {
    const kernel = new PythonKernel();
    try {
      await expect(
        kernel.run({ cellId: "unserializable-answer", code: "tool.test()", timeoutMs: 15_000 }, () =>
          (() => {
            const answer = Machine.ToolCallResult.parse({ status: "completed", value: "ok" });
            Reflect.set(answer, "value", 1n);
            return Promise.resolve(answer);
          })(),
        ),
      ).rejects.toMatchObject({ message: "driver write failed" });
    } finally {
      await kernel.close();
    }
  });

  test("output streams while the cell runs: peek sees it and a forged frame is inert", async () => {
    const kernel = new PythonKernel();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      let seenAtEntry: Machine.CellOutput | undefined;
      const running = kernel.run(
        {
          cellId: "streaming",
          code: "print('one')\nprint('two', file=__import__('sys').stderr)\ntool.hold()\nprint('three')",
          timeoutMs: 15_000,
        },
        async () => {
          // The output frames precede the tool_call frame on one ordered pipe.
          seenAtEntry = kernel.peek("streaming");
          await held;
          return { status: "completed" };
        },
      );
      // The forger bypasses the redirect and emits a frame naming another cell, then
      // pauses on a tool so the kernel-side output it tried to pollute can be observed.
      let seenAfterForgery: Machine.CellOutput | undefined;
      const forged = kernel.run(
        {
          cellId: "queued-behind",
          code: 'import sys\nprint(\'mine\')\nsys.__stdout__.write(\'{"kind":"output","cellId":"other","stream":"stdout","text":"forged","originalBytes":6}\\n\')\ntool.hold()',
          timeoutMs: 15_000,
        },
        () => {
          seenAfterForgery = kernel.peek("queued-behind");
          return Promise.resolve({ status: "completed" });
        },
      );
      // Queued behind the held cell: in flight, but nothing executed yet.
      expect(kernel.peek("queued-behind")).toBeUndefined();
      release();
      expect(await running).toMatchObject({
        status: "completed",
        output: { stdout: "one\nthree\n", stderr: "two\n" },
      });
      expect(seenAtEntry).toEqual({ stdout: "one\n", stderr: "two\n" });
      expect(kernel.peek("streaming")).toBeUndefined();
      // A frame naming another cell never lands on the running cell's kernel-side output:
      // the peek channel, taken after the forged write, shows only the redirected print.
      expect(await forged).toMatchObject({ status: "completed", output: { stdout: "mine\n" } });
      expect(seenAfterForgery).toEqual({ stdout: "mine\n", stderr: "" });
    } finally {
      release();
      await kernel.close();
    }
  });

  test("a wedged cell's timeout reports the output it produced first", async () => {
    const kernel = new PythonKernel();
    try {
      // Warm the interpreter first: the 300 ms deadline measures the wedge, not
      // a cold start, which exceeds it under coverage instrumentation.
      await expect(
        kernel.run({ cellId: "warm", code: "1 + 1", timeoutMs: 15_000 }, noTools),
      ).resolves.toMatchObject({ status: "completed", value: "2" });
      let seen: Machine.CellOutput | undefined;
      const result = await kernel.run(
        { cellId: "wedged-output", code: "print('progress')\ntool.hold()", timeoutMs: 300 },
        () =>
          new Promise(() => {
            seen = kernel.peek("wedged-output");
          }),
      );
      expect(seen).toEqual({ stdout: "progress\n", stderr: "" });
      expect(result).toEqual({
        status: "timed_out",
        cellId: "wedged-output",
        output: { stdout: "progress\n", stderr: "" },
      });
    } finally {
      await kernel.close();
    }
  });

  test("interpreter state persists across cells in one attachment", async () => {
    await withMachine(["kernel.py"], async ({ host }) => {
      const first = await host.get("mac-studio").runCode(cell("value = 6 * 7"));
      expect(first.status).toBe("completed");

      const second = await host.get("mac-studio").runCode(cell("value"));
      expect(second).toMatchObject({ status: "completed", value: "42" });
    });
  });

  test("parallel honours its max_concurrency kwarg and preserves input order (#1315)", async () => {
    await withMachine(["kernel.py"], async ({ host }) => {
      // A barrier that only releases when exactly `width` thunks are inside
      // at once: with max_concurrency=2 and four thunks the barrier trips
      // twice; with max_concurrency=1 it would deadlock, so the cell would
      // time out instead of completing.
      const result = await host.get("mac-studio").runCode(
        cell(
          [
            "import threading",
            "_barrier = threading.Barrier(2, timeout=5)",
            "def _thunk(n):",
            "    def _run():",
            "        _barrier.wait()",
            "        return n * 10",
            "    return _run",
            "parallel([_thunk(1), _thunk(2), _thunk(3), _thunk(4)], max_concurrency=2)",
          ].join("\n"),
        ),
      );
      expect(result).toMatchObject({ status: "completed", value: "[10, 20, 30, 40]" });
    });
  });

  test("a raise reports raised with the output produced before it", async () => {
    await withMachine(["kernel.py"], async ({ host }) => {
      const result = await host
        .get("mac-studio")
        .runCode(cell("print('before the raise')\nraise ValueError('boom')"));

      expect(result.status).toBe("raised");
      if (result.status !== "raised") throw new Error("expected raised");
      expect(result.output.stdout).toContain("before the raise");
      expect(result.error).toContain("ValueError: boom");
      // The traceback belongs to the caller's cell; the driver frame that ran it
      // is an implementation detail and must not surface in the reported error.
      expect(result.error).toContain("<cell ");
      expect(result.error).not.toContain("exec(compile(");
    });
  });

  test("a cell over its deadline is timed_out and the next cell still runs", async () => {
    await withMachine(["kernel.py"], async ({ host }) => {
      const timedOut = await host
        .get("mac-studio")
        .runCode(cell("import time\nwhile True: time.sleep(0.05)", 750));
      expect(timedOut).toMatchObject({ status: "timed_out" });

      // Forward progress is the guarantee: the replacement interpreter serves
      // the next cell. Prior state is gone, which is the documented tradeoff.
      const next = await host.get("mac-studio").runCode(cell("1 + 1"));
      expect(next).toMatchObject({ status: "completed", value: "2" });
      // The replacement interpreter starts clean — the documented tradeoff.
      const lost = await host.get("mac-studio").runCode(cell("'time' in dir()"));
      expect(lost).toMatchObject({ status: "completed", value: "False" });
    });
  });

  test("stdout and stderr are both captured on a completed cell", async () => {
    await withMachine(["kernel.py"], async ({ host }) => {
      const result = await host
        .get("mac-studio")
        .runCode(cell("import sys\nprint('out')\nprint('err', file=sys.stderr)"));

      expect(result.status).toBe("completed");
      if (result.status !== "completed") throw new Error("expected completed");
      expect(result.output).toEqual({ stdout: "out\n", stderr: "err\n" });
    });
  });

  test("a statement-only cell completes with no value", async () => {
    await withMachine(["kernel.py"], async ({ host }) => {
      const result = await host.get("mac-studio").runCode(cell("x = 1"));

      expect(result).toMatchObject({
        status: "completed",
        output: { stdout: "", stderr: "" },
      });
      if (result.status !== "completed") throw new Error("expected completed");
      expect(result.value).toBeUndefined();
    });
  });

  test("a machine attached without kernel.py is refused, not executed", async () => {
    await withMachine(["fs.read"], async ({ host }) => {
      const result = await host.get("mac-studio").runCode(cell("print('should not run')"));

      expect(result).toEqual({ status: "refused", reason: "kernel_not_available" });
    });
  });

  test("an unattached machine is refused", async () => {
    const path = socketPath();
    const host = await createMachineHost({
      listen: { unix: path },
      enrollment: () => enrollment,
      events: silent,
      now: () => 5000,
    });
    try {
      await expect(host.get("mac-mini").runCode(cell("1"))).rejects.toMatchObject({
        _tag: "MachineRefusalError",
        reason: "machine_not_attached",
      });
    } finally {
      host.close();
    }
  });
});
