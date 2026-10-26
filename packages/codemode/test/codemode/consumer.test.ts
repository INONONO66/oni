import { beforeAll, expect, spyOn, test } from "bun:test";
import type { LeaseHandle } from "@oni/machines";
import { Effect } from "effect";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMachineHost } from "../../../machines/test/helpers/native";
import { attachMclient, mclientBinary, mclientEnrollment } from "../../../machines/test/helpers/mclient";
import { eventCollector } from "../../../machines/test/helpers/events";
import { CodemodeError, createCodemode } from "./helpers/native";

beforeAll(mclientBinary, 300_000);
/**
 * A cell tool that parks its caller: `entered` settles once a cell is inside the
 * tool, `release` lets the tool answer. `onHold` observes each entry.
 */
function holdGate(onHold: () => void = () => undefined) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const tools: Parameters<typeof createCodemode>[0] = {
    tools: () => async () => {
      onHold();
      entered.resolve();
      await release.promise;
      return { status: "completed" };
    },
  };
  return { entered, release, tools };
}
async function pair(
  run: (context: {
    mode: ReturnType<typeof createCodemode>;
    host: Awaited<ReturnType<typeof createMachineHost>>;
    a: string;
    b: string;
    da: Awaited<ReturnType<typeof attachMclient>>;
  }) => Promise<void>,
  tools?: Parameters<typeof createCodemode>[0] & Partial<Pick<Parameters<typeof createMachineHost>[0], "scheduler" | "now" | "idleTtlMs" | "capacity">> & { pty?: boolean; onLease?: (lease: LeaseHandle) => void },
  sharedTag = false,
) {
  const base = mkdtempSync(join(tmpdir(), "oc-consumer-"));
  const a = join(base, "a");
  const b = join(base, "b");
  mkdirSync(a);
  mkdirSync(b);
  const socketPath = join(tmpdir(), `oc-${crypto.randomUUID()}.sock`);
  const events = eventCollector();
  let mode: ReturnType<typeof createCodemode>;
  const host = await createMachineHost({
    listen: { unix: socketPath },
    enrollment: (id) => mclientEnrollment(id, { tags: [id, ...(sharedTag ? ["worker"] : [])] }),
    events: events.sink,
    now: tools?.now ?? (() => 2),
    scheduler: tools?.scheduler ?? { schedule: () => () => undefined },
    idleTtlMs: tools?.idleTtlMs,
    capacity: tools?.capacity,
    callTool: (call) => mode.callTool(call),
  });
  mode = createCodemode({
    ...tools,
    machines: { ...host, place(request, workClass) {
      const result = host.place(request, workClass);
      if (result.kind === "placed") tools?.onLease?.(result.lease);
      return result;
    } },
    self: tools?.self ?? "A",
  });
  const da = await attachMclient({ host, events, machineId: "A", root: a, tags: ["A", ...(sharedTag ? ["worker"] : [])] });
  const db = await attachMclient({ host, events, machineId: "B", root: b, tags: ["B", ...(sharedTag ? ["worker"] : [])] });
  try {
    await run({ mode, host, a, b, da });
  } finally {
    await mode.close();
    await da.stop();
    await db.stop();
    await host.close();
    rmSync(base, { recursive: true, force: true });
  }
}

/** The CodemodeError an action throws or rejects with; another outcome fails the test. */
async function codemodeFailure(action: () => void): Promise<InstanceType<typeof CodemodeError>> {
  const failure = await Promise.resolve()
    .then(action)
    .then(
      () => undefined,
      (error: Error) => error,
    );
  if (!(failure instanceof CodemodeError))
    throw new Error(`expected a CodemodeError, got ${String(failure)}`);
  return failure;
}

test("running nested cells retain generation ownership until terminal completion", async () => {
  const gate = holdGate();
  const settled = Promise.withResolvers<void>();
  let owners = 0;
  let acquired = 0;
  const ownership = { retain() {
    owners += 1;
    acquired += 1;
    let released = false;
    return () => {
      if (released) throw new Error("duplicate generation release");
      released = true;
      owners -= 1;
      if (owners === 0) settled.resolve();
    };
  } };
  await pair(async ({ mode }) => {
    const running = mode.cell.run(`machine("B").eval('tool.hold()')`, "owned", { waitMs: 0, ownership });
    await gate.entered.promise;
    const result = await running;
    expect(result.status).toBe("running");
    expect(acquired).toBe(2);
    expect(owners).toBe(2);
    gate.release.resolve();
    await settled.promise;
    expect(owners).toBe(0);
    if (result.status === "running") expect((await mode.cell.peek(result.cellId, "owned")).status).toBe("completed");
  }, gate.tools);
}, 15000);

test("SDK handles and Python globals share raw endpoints across two machines", async () => {
  await pair(async ({ mode, a, b }) => {
    expect(mode.listMachines().map((entry) => entry.machineId)).toEqual(["A", "B"]);
    expect(mode.findMachine({ tag: "A" }).id).toBe(mode.getMachine("A").id);
    expect((await codemodeFailure(() => mode.findMachine({ tag: "missing" }))).reason).toBe(
      "machine_not_found",
    );
    const bytes = Buffer.from([0, 255, 128, 65]);
    expect(await mode.getMachine("A").write(join(a, "source"), bytes)).toEqual({
      op: "write",
      bytesWritten: 4,
    });
    const result = await mode.cell.run(
      [
        "ids = [m['machineId'] for m in codemode.listMachines()]",
        "src = machine(tag='A')",
        "dst = machine('B')",
        `raw = src.read(${JSON.stringify(join(a, "source"))})`,
        `written = dst.write(${JSON.stringify(join(b, "copy"))}, raw['data'])`,
        `listed = dst.ls(${JSON.stringify(b)})`,
        `shell = dst.bash('printf out; printf err >&2; exit 3', ${JSON.stringify(b)})`,
        "nested = dst.eval('6 * 7')",
        "(ids, list(raw['data']), written['bytesWritten'], any(entry['name'] == 'copy' for entry in listed['entries']), shell['stdout'], shell['stderr'], shell['exitCode'], nested['value'])",
      ].join("\n"),
      "consumer",
    );
    expect(result).toMatchObject({
      status: "completed",
      value: "(['A', 'B'], [0, 255, 128, 65], 4, True, b'out', b'err', 3, '42')",
    });
    expect((await mode.getMachine("B").read(join(b, "copy"))).data).toEqual(bytes);
    expect((await mode.getMachine("B").ls(b)).entries).toContainEqual(expect.objectContaining({ name: "copy", kind: "file" }));
    expect(await mode.getMachine("B").bash("printf direct", b)).toMatchObject({
      stdout: Buffer.from("direct"),
    });
    expect(
      await mode
        .getMachine("B")
        .eval({ cellId: "direct", code: "40 + 2", tenant: "direct", timeoutMs: 15_000 }),
    ).toMatchObject({ status: "completed", value: "42" });
    // Handle methods are the tool names; the raw endpoint names are gone (KERNEL 3.5).
    expect(Object.keys(mode.getMachine("B")).sort()).toEqual([
      "bash",
      "eval",
      "id",
      "input",
      "ls",
      "read",
      "screen",
      "write",
    ]);
  });
});

test("concurrent tag placement reserves at pick time and spreads evenly", async () => {
  const scheduled: Array<{ task: () => void; cancelled: boolean }> = [];
  const scheduler = {
    schedule(_delayMs: number, task: () => void) {
      const entry = { task, cancelled: false };
      scheduled.push(entry);
      return () => { entry.cancelled = true; };
    },
  };
  await pair(async ({ mode }) => {
    const handles = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve(mode.findMachine({ tag: "worker" }))));
    expect(handles.map((handle) => handle.id).sort()).toEqual(["A", "A", "A", "A", "B", "B", "B", "B"]);
    expect(scheduled).toHaveLength(8);
  }, { scheduler, idleTtlMs: 10, capacity: [{ machineId: "A", slots: 4 }, { machineId: "B", slots: 4 }] }, true);
});

test("a picked lease releases on the injected idle scheduler", async () => {
  let now = 0;
  const pending: Array<() => void> = [];
  const scheduler = { schedule(_delayMs: number, task: () => void) { pending.push(task); return () => undefined; } };
  await pair(async ({ mode, a }) => {
    const handle = mode.findMachine({ tag: "A" });
    expect(handle.id).toBe("A");
    now = 11;
    pending.shift()?.();
    await expect(handle.read(join(a, "expired"))).rejects.toMatchObject({ reason: "lease_expired" });
    const next = mode.findMachine({ tag: "A" });
    expect(next.id).toBe("A");
  }, { scheduler, now: () => now, idleTtlMs: 10 }, true);
});

test("an exclusive pick on a member without reported resources takes the whole member", async () => {
  await pair(async ({ mode }) => {
    const first = mode.findMachine({ tag: "worker", prefer: "exclusive" });
    const second = mode.findMachine({ tag: "worker", prefer: "exclusive" });
    expect([first.id, second.id].sort()).toEqual(["A", "B"]);
    expect(() => mode.findMachine({ tag: "worker", prefer: "exclusive" })).toThrow(
      expect.objectContaining({ reason: "machine_saturated" }),
    );
  }, { idleTtlMs: 10 }, true);
});

test("the Python prelude exposes one machine function with exact-one selection", async () => {
  await pair(async ({ mode }) => {
    const result = await mode.cell.run([
      "by_id = machine('A').id",
      "by_tag = machine(tag='A').id",
      "try:",
      "    machine('A', tag='A')",
      "except Exception as error:",
      "    both = str(error)",
      "try:",
      "    machine()",
      "except Exception as error:",
      "    neither = str(error)",
      "(by_id, by_tag, both, neither)",
    ].join("\n"), "prelude");
    expect(result).toMatchObject({
      status: "completed",
      value: "('A', 'A', 'machine() requires exactly one of id or tag', 'machine() requires exactly one of id or tag')",
    });
  });
});

test("cancellation crosses the real host/daemon boundary and the next cell recovers", async () => {
  const gate = holdGate();
  const { entered, release } = gate;
  await pair(
    async ({ mode }) => {
      const controller = new AbortController();
      const running = mode.cell.run("tool.hold()", "cancel", {
        signal: controller.signal,
        timeoutMs: 5000,
      });
      await entered.promise;
      controller.abort();
      expect(await running).toMatchObject({ status: "cancelled" });
      release.resolve();
      expect(await mode.cell.run("6 * 7", "cancel")).toMatchObject({
        status: "completed",
        value: "42",
      });
      await mode.close();
      expect(() => mode.listMachines()).toThrow(CodemodeError);
    },
    {
      tools: () => async () => {
        entered.resolve();
        await release.promise;
        return { status: "completed", value: "late" };
      },
    },
  );
});

test("host disconnect fails a pending facade cell with a typed refusal", async () => {
  const gate = holdGate();
  const { entered, release } = gate;
  await pair(async ({ mode, host, da }) => {
    // With a wait window the loss surfaces through the background path too.
    const running = mode.cell.run("tool.hold()", "disconnect", {
      timeoutMs: 5000,
      waitMs: 5000,
    });
    const outcome = running.then(
      (result) => {
        throw new Error(`expected connection loss, received ${result.status}`);
      },
      (error: Error) => error,
    );
    await entered.promise;
    host.close();
    // #1270: a dropped transport surfaces as the typed disconnected refusal,
    // the same contract the host side exposes for its dropped in-flight calls.
    expect(await outcome).toMatchObject({ _tag: "MachineRefusalError", reason: "disconnected" });
    await da.stop();
    release.resolve();
  }, gate.tools);
});

test("close cancels live facade work on the attached client", async () => {
  const gate = holdGate();
  const { entered, release } = gate;
  await pair(async ({ mode }) => {
    const running = mode.cell.run("tool.hold()", "closing", { timeoutMs: 5000 });
    await entered.promise;
    await mode.close();
    expect(await running).toMatchObject({ status: "cancelled" });
    release.resolve();
  }, gate.tools);
});

test("exact tag placement and an unbound machine port are typed", async () => {
  await pair(async ({ mode }) => {
    expect(mode.findMachine({ tag: "A" }).id).toBe("A");
  });
  const unbound = createCodemode();
  expect((await codemodeFailure(() => unbound.listMachines())).reason).toBe(
    "machines_not_bound",
  );
  await expect(
    unbound.callTool({ cellId: "ghost", name: "x", arguments: {} }),
  ).resolves.toMatchObject({ status: "failed" });
  await unbound.close();
});

test("cells refuse a machine without kernel capability and unattached handles fail typed", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-no-kernel-"));
  const events = eventCollector();
  const host = await createMachineHost({
    listen: { unix: join(root, "host.sock") },
    enrollment: (id) => mclientEnrollment(id, { allowedCapabilities: ["fs.read"] }),
    events: events.sink,
    now: () => Date.now(),
  });
  const mode = createCodemode({ machines: host, self: "restricted" });
  const client = await attachMclient({ host, events, machineId: "restricted", root });
  try {
    expect(await mode.cell.run("print('not executed')", "tenant"))
      .toEqual({ status: "refused", reason: "kernel_not_available" });
    await expect(mode.getMachine("missing").eval({
      cellId: "missing-cell", code: "1", tenant: "tenant", timeoutMs: 5000,
    })).rejects.toMatchObject({ _tag: "MachineRefusalError", reason: "machine_not_attached" });
  } finally {
    await mode.close();
    await client.stop();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("host saturation is a typed SDK refusal and a catchable Python ToolError", async () => {
  await pair(async ({ mode, host }) => {
    mode.findMachine({ tag: "A" });
    expect((await codemodeFailure(() => mode.findMachine({ tag: "A" }))).credit).toMatchObject({
      machineId: "A", reason: "slots", slots: 1, inFlight: 1,
    });
    const result = await mode.cell.run([
      "try:",
      "    machine(tag='A')",
      "except ToolError as error:",
      "    refusal = ('machine_saturated' in str(error), type(error).__name__)",
      "refusal",
    ].join("\n"), "capacity");
    expect(result).toMatchObject({ status: "completed", value: "(True, 'ToolError')" });
    await mode.close();
    expect(host.place({ tag: "A", prefer: "spread" }).kind).toBe("placed");
  }, { capacity: [{ machineId: "A", slots: 1 }] });
});

test("a nested Python call retains its host lease until physical completion", async () => {
  const gate = holdGate();
  let now = 0;
  const pending: Array<() => void> = [];
  const scheduler = { schedule(_delay: number, task: () => void) { pending.push(task); return () => undefined; } };
  await pair(async ({ mode, host }) => {
    const running = mode.cell.run("machine(tag='B').eval('tool.hold()')", "nested-lease");
    await gate.entered.promise;
    now = 100;
    for (const task of pending.splice(0)) task();
    expect(host.place({ tag: "B", prefer: "spread" }).kind).toBe("machine_saturated");
    gate.release.resolve();
    expect((await running).status).toBe("completed");
    now = 111;
    for (const task of pending.splice(0)) task();
    expect(host.place({ tag: "B", prefer: "spread" }).kind).toBe("placed");
  }, { ...gate.tools, capacity: [{ machineId: "B", slots: 1 }], scheduler, now: () => now, idleTtlMs: 10 });
});

test("an expired nested lease releases generation ownership without quarantining an unstarted cell", async () => {
  let now = 0;
  let owners = 0;
  const pending: Array<() => void> = [];
  const scheduler = { schedule(_delay: number, task: () => void) { pending.push(task); return () => undefined; } };
  await pair(async ({ mode }) => {
    expect((await mode.cell.run("retained = machine(tag='B')", "expired-nested")).status).toBe("completed");
    now = 11;
    for (const task of pending.splice(0)) task();
    const result = await mode.cell.run("retained.eval('1')", "expired-nested", {
      ownership: { retain() { owners += 1; return () => { owners -= 1; }; } },
    });
    expect(result).toMatchObject({ status: "raised", error: expect.stringContaining("lease_expired") });
    expect(owners).toBe(0);
    await mode.close();
  }, { scheduler, now: () => now, idleTtlMs: 10 });
});

test.each(["release", "expiry"] as const)("codemode prunes a host-invalidated lease on %s", async (invalidation) => {
  let granted: LeaseHandle | undefined;
  let now = 0;
  const pending: Array<() => void> = [];
  await pair(async ({ mode, a }) => {
    const handle = mode.findMachine({ tag: "A" });
    if (granted === undefined) throw new Error("expected host grant");
    const renewal = spyOn(granted, "renewWhile");
    try {
      if (invalidation === "release") granted.release();
      else { now = 11; for (const task of pending.splice(0)) task(); }
      await expect(handle.read(join(a, "never-routed"))).rejects.toMatchObject({ reason: "lease_expired" });
      expect(renewal).not.toHaveBeenCalled();
    } finally { renewal.mockRestore(); }
  }, {
    onLease: (lease) => { granted = lease; }, now: () => now, idleTtlMs: 10,
    scheduler: { schedule(_delay, task) { pending.push(task); return () => undefined; } },
  });
});

test("a background cell charges the configured job cost until its execution settles", async () => {
  const gate = holdGate();
  const settled = Promise.withResolvers<void>();
  await pair(async ({ mode, host }) => {
    const running = mode.cell.run("tool.hold()", "job-credit", {
      waitMs: 0, ownership: { retain: () => () => settled.resolve() },
    });
    await gate.entered.promise;
    const cell = await running;
    expect(cell.status).toBe("running");
    expect(host.place({ machineId: "A" }, "exec")).toMatchObject({ kind: "machine_saturated", inFlight: 2 });
    gate.release.resolve();
    await settled.promise;
    expect(host.place({ machineId: "A" }, "exec").kind).toBe("placed");
  }, { ...gate.tools, capacity: [{ machineId: "A", slots: 2, classCosts: { exec: 1, eval: 1, pty: 1, job: 2 } }] });
});

test("an open terminal keeps its slot through idle time and releases it after close", async () => {
  let now = 0;
  const pending: Array<() => void> = [];
  const scheduler = { schedule(_delay: number, task: () => void) { pending.push(task); return () => undefined; } };
  await pair(async ({ mode, host, b }) => {
    expect(await mode.cell.run([
      "member = machine(tag='B')",
      `terminal = member.pty('held')`,
      `terminal.open(${JSON.stringify(b)})['status']`,
    ].join("\n"), "terminal-credit")).toMatchObject({ status: "completed", value: "'ok'" });
    now = 100;
    for (const task of pending.splice(0)) task();
    expect(host.place({ tag: "B", prefer: "spread" }).kind).toBe("machine_saturated");
    expect(await mode.cell.run("terminal.resize(80, 24)['status']", "terminal-credit")).toMatchObject({ status: "completed", value: "'ok'" });
    expect(await mode.cell.run("terminal.close()['status']", "terminal-credit")).toMatchObject({ status: "completed", value: "'ok'" });
    now = 111;
    for (const task of pending.splice(0)) task();
    expect(host.place({ tag: "B", prefer: "spread" }).kind).toBe("placed");
  }, { pty: true, capacity: [{ machineId: "B", slots: 1 }], scheduler, now: () => now, idleTtlMs: 10 });
});

test.each(["machine('B')", "machine(tag='B')"])("terminal jobs charge their class through %s", async (select) => {
  let now = 0;
  const pending: Array<() => void> = [];
  await pair(async ({ mode, host, b }) => {
    expect(await mode.cell.run([
      `member = ${select}`,
      `job_info = member.job('printf job', ${JSON.stringify(b)})`,
      "member.job_wait(job_info['name'], 5)['status']",
    ].join("\n"), "job-terminal")).toMatchObject({ status: "completed", value: "'completed'" });
    now = 100;
    for (const task of pending.splice(0)) task();
    expect(host.place({ machineId: "B" }, "job")).toMatchObject({ kind: "machine_saturated", inFlight: 2 });
    expect(await mode.cell.run("member.pty(job_info['name']).close()['status']", "job-terminal"))
      .toMatchObject({ status: "completed", value: "'ok'" });
    now = 111;
    for (const task of pending.splice(0)) task();
    expect(host.place({ machineId: "B" }, "job").kind).toBe("placed");
  }, {
    pty: true, now: () => now, idleTtlMs: 10,
    scheduler: { schedule(_delay, task) { pending.push(task); return () => undefined; } },
    capacity: [{ machineId: "B", slots: 2, classCosts: { exec: 1, eval: 1, pty: 1, job: 2 } }],
  });
});

test("injected completion batches through parallel and tenant state never crosses interpreters", async () => {
  await pair(
    async ({ mode }) => {
      expect(
        await mode.cell.run(
          "x = 41\nparallel([lambda: completion('first'), lambda: completion('second')])",
          "one",
        ),
      ).toMatchObject({
        status: "completed",
        value: "['answer:first', 'answer:second']",
      });
      expect(await mode.cell.run("x + 1", "one")).toMatchObject({
        status: "completed",
        value: "42",
      });
      expect(await mode.cell.run("x", "two")).toMatchObject({ status: "raised" });
    },
    { completion: async (request) => `answer:${request.prompt}` },
  );
});

test("the prelude's tool_output reads a stored 1 MiB output back whole through the host op (#1305)", async () => {
  const outputId = `sha256:${"ab".repeat(32)}`;
  const text = "m".repeat(1_048_576);
  const reads: Array<{ tenant: string; outputId: string }> = [];
  await pair(
    async ({ mode }) => {
      const result = await mode.cell.run(`len(tool_output("${outputId}"))`, "reader");
      expect(result).toMatchObject({ status: "completed", value: "1048576" });
      // The read-back crosses the host op whole; only the committed row was bounded.
      expect(reads).toEqual([{ tenant: "reader", outputId }]);
      // An unknown identifier is the typed unknown_output error, raised in the cell.
      const unknown = await mode.cell.run(`tool_output("sha256:${"00".repeat(32)}")`, "reader");
      expect(unknown.status).toBe("raised");
    },
    {
      toolOutput: async (tenant, id) => {
        reads.push({ tenant, outputId: id });
        return id === outputId ? { text, bytes: text.length, mediaType: "text/plain" } : undefined;
      },
    },
  );
});

test("run leaves a held cell in the background: peek shows its output so far, stop interrupts it once", async () => {
  let holds = 0;
  const gate = holdGate(() => {
    holds += 1;
  });
  const { entered, release } = gate;
  await pair(async ({ mode }) => {
    // The hold cannot settle until released, so a zero wait answers `running` by construction.
    const started = await mode.cell.run(
      "print('started')\nprint('warn', file=__import__('sys').stderr)\ntool.hold()\nprint('never')",
      "background",
      { timeoutMs: 5000, waitMs: 0 },
    );
    if (started.status !== "running") throw new Error(`expected running, got ${started.status}`);
    await entered.promise;
    // A cell queued behind the held one is in flight with no output yet; stopping it
    // before it executes cancels it without ever touching the interpreter.
    const queued = await mode.cell.run("print('second')", "background", {
      timeoutMs: 5000,
      waitMs: 0,
    });
    if (queued.status !== "running") throw new Error(`expected running, got ${queued.status}`);
    const nothing = { stdout: "", stderr: "" };
    expect(await mode.cell.peek(queued.cellId, "background")).toEqual({
      status: "running",
      cellId: queued.cellId,
      output: nothing,
    });
    expect(await mode.cell.stop(queued.cellId, "background")).toEqual({
      status: "cancelled",
      cellId: queued.cellId,
      output: nothing,
    });
    const partial = { stdout: "started\n", stderr: "warn\n" };
    expect(await mode.cell.peek(started.cellId, "background")).toEqual({
      status: "running",
      cellId: started.cellId,
      output: partial,
    });
    // Another tenant cannot see, let alone stop, this cell.
    for (const op of [mode.cell.peek, mode.cell.stop]) {
      const refusal = await codemodeFailure(() => op(started.cellId, "intruder"));
      expect(refusal.reason).toBe("unknown_cell_id");
    }
    expect(await mode.cell.stop(started.cellId, "background")).toEqual({
      status: "cancelled",
      cellId: started.cellId,
      output: partial,
    });
    // Settled state is handed over once; the code never runs again.
    await expect(mode.cell.peek(started.cellId, "background")).rejects.toMatchObject({
      reason: "unknown_cell_id",
    });
    release.resolve();
    expect(await mode.cell.run("6 * 7", "background")).toMatchObject({
      status: "completed",
      value: "42",
    });
    expect(holds).toBe(1);
  }, gate.tools);
});

test("a peek and a stop racing on one cell hand its settled state to exactly one of them", async () => {
  const gate = holdGate();
  const { entered, release } = gate;
  await pair(async ({ mode }) => {
    const started = await mode.cell.run("tool.hold()", "race", { timeoutMs: 5000, waitMs: 0 });
    if (started.status !== "running") throw new Error(`expected running, got ${started.status}`);
    await entered.promise;
    // peek is mid round-trip to the daemon when stop claims the entry synchronously.
    const outcomes = await Promise.allSettled([
      mode.cell.peek(started.cellId, "race"),
      mode.cell.stop(started.cellId, "race"),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "fulfilled"]);
    expect(outcomes[0]).toMatchObject({
      reason: { _tag: "CodemodeError", reason: "unknown_cell_id" },
    });
    expect(outcomes[1]).toMatchObject({
      value: { status: "cancelled", cellId: started.cellId },
    });
    release.resolve();
  }, gate.tools);
});

test("unread settled cells are retained up to the bound; the oldest is evicted and its id is spent", async () => {
  await pair(async ({ mode }) => {
    const ids: string[] = [];
    const cellId = (index: number): string => {
      const id = ids[index];
      if (id === undefined) throw new Error(`no cell was started at ${index}`);
      return id;
    };
    const startRunning = async (code: string): Promise<string> => {
      const done = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const started = await mode.cell.run(`tool.hold()\n${code}`, "bound", {
        timeoutMs: 5000,
        waitMs: 0,
        ownership: { retain: () => () => done.resolve() },
        bindings: { tools: () => () => Effect.promise(async () => {
          entered.resolve();
          await release.promise;
          return { status: "completed" } as const;
        }) },
      });
      if (started.status !== "running") throw new Error(`expected running, got ${started.status}`);
      await entered.promise;
      release.resolve();
      await done.promise;
      return started.cellId;
    };
    // Each ownership release witnesses settlement without consuming the retained result.
    for (let index = 0; index < 65; index += 1)
      ids.push(await startRunning(`${index}`));
    await expect(mode.cell.peek(cellId(0), "bound")).rejects.toMatchObject({
      reason: "unknown_cell_id",
    });
    expect(await mode.cell.peek(cellId(1), "bound")).toMatchObject({
      status: "completed",
      value: "1",
    });
    expect(await mode.cell.peek(cellId(64), "bound")).toMatchObject({
      status: "completed",
      value: "64",
    });
  });
}, 60_000);

test("a run that settles within its wait answers the result and leaves nothing behind", async () => {
  await pair(async ({ mode }) => {
    const settled = await mode.cell.run("print('quick')\n1 + 1", "prompt", {
      timeoutMs: 5000,
      waitMs: 5000,
    });
    expect(settled).toMatchObject({
      status: "completed",
      value: "2",
      output: { stdout: "quick\n", stderr: "" },
    });
    if (settled.status !== "completed") throw new Error("unreachable");
    await expect(mode.cell.peek(settled.cellId, "prompt")).rejects.toMatchObject({
      reason: "unknown_cell_id",
    });
  });
});
