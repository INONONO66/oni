import { beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine } from "@oni/protocol";
import { createMachineHost } from "../../../machines/test/helpers/native";
import {
  attachMclient,
  mclientBinary,
  mclientEnrollment,
} from "../../../machines/test/helpers/mclient";
import { eventCollector, type RecordedEvent } from "../../../machines/test/helpers/events";
import type { CodemodeError } from "../../src";
import { MachinesFailure } from "@oni/machines";
import { createCodemode } from "./helpers/native";

beforeAll(mclientBinary, 300_000);

// #1841: the host stamps the attachment that delivered a call; these tests
// inject that stamp directly and prove what codemode does with it. The cell
// runs on `C` (the session's own machine); `A` and `B` are the isolated pair.
// Leases come from the real host store, so the receipts asserted here are the
// ones the host journals.
const A: Machine.ToolCallSource = { kind: "machine", machineId: "A" };
const SESSION: Machine.ToolCallSource = { kind: "session" };
type Reason = CodemodeError["reason"];
type Call = Omit<Machine.ToolCall, "cellId">;

async function trio(
  run: (context: {
    mode: ReturnType<typeof createCodemode>;
    b: string;
    call: (call: Call) => Promise<Machine.ToolCallResult>;
    refusal: (call: Call, reason: Reason) => Promise<string>;
    peers: Awaited<ReturnType<typeof createMachineHost>>["peers"];
    receipts: () => Array<{ name: string } & RecordedEvent["payload"]>;
    seen: Machine.ToolCall[];
    upward: Machine.ToolCall[];
  }) => Promise<void>,
  options: Pick<
    NonNullable<Parameters<typeof createCodemode>[0]>,
    "machineTools" | "completion"
  > & { clock?: () => number } = {},
) {
  const base = mkdtempSync(join(tmpdir(), "oc-isolation-"));
  const roots = { A: join(base, "a"), B: join(base, "b"), C: join(base, "c") };
  for (const root of Object.values(roots)) mkdirSync(root);
  const events = eventCollector();
  const seen: Machine.ToolCall[] = [];
  const upward: Machine.ToolCall[] = [];
  const hold = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let mode: ReturnType<typeof createCodemode>;
  const host = await createMachineHost({
    listen: { unix: join(tmpdir(), `oc-${crypto.randomUUID()}.sock`) },
    enrollment: (id) => mclientEnrollment(id, { tags: [id] }),
    events: events.sink,
    now: options.clock ?? (() => 2),
    scheduler: { schedule: () => () => undefined },
    callTool: (call) => mode.callTool(call),
  });
  mode = createCodemode({
    ...options,
    machines: host,
    peers: host.peers,
    self: "C",
    boundary: () => (call, body) => {
      seen.push(call);
      return body();
    },
    tools: () => async (call) => {
      upward.push(call);
      if (call.name === "hold") {
        hold.resolve();
        await release.promise;
      }
      return { status: "completed", value: call.name };
    },
  });
  const attached = await Promise.all(
    (["A", "B", "C"] as const).map((machineId) =>
      attachMclient({ host, events, machineId, root: roots[machineId], tags: [machineId] }),
    ),
  );
  try {
    const running = mode.cell.run("tool.hold()", "isolation");
    await hold.promise;
    const call = (request: Call) => mode.callTool({ cellId: "cell-1", ...request });
    const refusal = async (request: Call, reason: Reason) => {
      const failure = await call(request).then(
        () => undefined,
        (error: Error) => error,
      );
      if (!(failure instanceof MachinesFailure))
        throw new Error(`expected a MachinesFailure, got ${String(failure)}`);
      expect(failure.operation).toBe(`code.tool.${reason}`);
      return failure.cause;
    };
    const receipts = () =>
      events.events
        .filter((event) => event.name.startsWith("machine.peer_lease_"))
        .map((event) => ({ name: event.name, ...event.payload }));
    await run({ mode, b: roots.B, call, refusal, peers: host.peers, receipts, seen, upward });
    release.resolve();
    expect((await running).status).toBe("completed");
  } finally {
    release.resolve();
    await mode.close();
    for (const client of attached) await client.stop();
    await host.close();
    rmSync(base, { recursive: true, force: true });
  }
}

const exec = (b: string, source: Machine.ToolCallSource): Call => ({
  name: "codemode.bash",
  arguments: { machineId: "B", cmd: "printf reached", cwd: b },
  source,
});

test("A-origin machine('B').exec is refused machine_isolated without a peer lease", async () => {
  await trio(async ({ b, refusal, seen, upward, receipts }) => {
    expect(await refusal(exec(b, A), "machine_isolated")).toBe(
      "machine_isolated: A holds no peer lease for exec on B",
    );
    expect(seen.at(-1)).toMatchObject({ name: "codemode.bash", source: A });
    expect(upward.map((call) => call.name)).toEqual(["hold"]);
    expect(receipts()).toEqual([]);
  });
});

test("the same call with session origin is allowed, as is the session's own machine", async () => {
  await trio(async ({ b, call, seen }) => {
    expect(await call(exec(b, SESSION))).toMatchObject({
      status: "completed",
      value: { exitCode: 0, stdout: Buffer.from("reached").toString("base64") },
    });
    expect(await call({ ...exec(b, SESSION), source: undefined })).toMatchObject({
      status: "completed",
    });
    expect(await call(exec(b, { kind: "machine", machineId: "C" }))).toMatchObject({
      status: "completed",
    });
    expect(seen.slice(-3).map((entry) => entry.source)).toEqual([SESSION, SESSION, SESSION]);
  });
});

test("a machine naming another machine through an op with no lease class is refused before any lease lookup", async () => {
  await trio(
    async ({ refusal, call, upward, receipts, peers }) => {
      peers.issue({ from: "A", to: "B", ops: ["exec", "fs", "pty", "computer", "code"], ttlMs: 50, delegationId: "d-1" });
      const table: Array<[string, Machine.ToolCall["arguments"]]> = [
        ["codemode.listMachines", { machineId: "B" }],
        ["web_search", { machineId: "B", query: "x" }],
        ["completion", { machineId: "B", prompt: "hi" }],
        ["codemode.bash", { machineId: 7, cmd: "true" }],
      ];
      for (const [name, args] of table)
        expect(await refusal({ name, arguments: args, source: A }, "machine_isolated")).toBe(
          `machine_isolated: A may not name another machine through ${name}`,
        );
      expect(await call({ name: "web_search", arguments: { machineId: "A" }, source: A })).toEqual({
        status: "completed",
        value: "web_search",
      });
      expect(upward.map((entry) => entry.name)).toEqual(["hold", "web_search"]);
      expect(receipts().map((receipt) => receipt.name)).toEqual(["machine.peer_lease_issued"]);
    },
    { machineTools: ["web_search"], completion: async () => "answer" },
  );
});

test("after a lease is issued the A call is allowed and its use is journaled; after TTL expiry it is refused and the end is journaled", async () => {
  let now = 10;
  await trio(
    async ({ b, call, refusal, peers, receipts }) => {
      const lease = peers.issue({ from: "A", to: "B", ops: ["exec"], ttlMs: 5, delegationId: "d-1" });
      expect(lease).toMatchObject({ from: "A", to: "B", expiresAt: 15 });
      expect(await call(exec(b, A))).toMatchObject({
        status: "completed",
        value: { exitCode: 0, stdout: Buffer.from("reached").toString("base64") },
      });
      expect(
        await refusal(
          { name: "codemode.read", arguments: { machineId: "B", path: join(b, "none") }, source: A },
          "machine_isolated",
        ),
      ).toBe("machine_isolated: A holds no peer lease for fs on B");
      now = 15;
      expect(await refusal(exec(b, A), "machine_isolated")).toBe(
        "machine_isolated: A holds no peer lease for exec on B",
      );
      expect(receipts()).toEqual([
        { name: "machine.peer_lease_issued", machineId: "A", time: 10, lease },
        { name: "machine.peer_lease_used", machineId: "A", time: 10, leaseId: lease.id, to: "B", op: "exec" },
        { name: "machine.peer_lease_ended", machineId: "A", time: 15, leaseId: lease.id, to: "B", reason: "expired" },
      ]);
    },
    { clock: () => now },
  );
});

test("A's listMachines and findMachine hide B without a lease and show only lease targets with one", async () => {
  await trio(async ({ call, refusal, peers }) => {
    const find = { name: "codemode.findMachine", arguments: { query: { tag: "B" } } };
    expect(await call({ name: "codemode.listMachines", arguments: {}, source: A })).toEqual({
      status: "completed",
      value: [],
    });
    expect(await refusal({ ...find, source: A }, "machine_isolated")).toBe(
      "machine_isolated: A holds no peer lease for tag B",
    );
    peers.issue({ from: "A", to: "B", ops: ["fs"], ttlMs: 1, delegationId: "d-1" });
    expect(await call({ name: "codemode.listMachines", arguments: {}, source: A })).toMatchObject({
      status: "completed",
      value: [{ machineId: "B" }],
    });
    expect(await call({ ...find, source: A })).toMatchObject({
      status: "completed",
      value: { machineId: "B" },
    });
    expect(
      await call({ name: "codemode.listMachines", arguments: {}, source: SESSION }),
    ).toMatchObject({ value: [{ machineId: "A" }, { machineId: "B" }, { machineId: "C" }] });
    expect(await call({ ...find, source: SESSION })).toMatchObject({
      status: "completed",
      value: { machineId: "B" },
    });
  });
});

test("A-origin forged provision call is refused machine_origin_refused before the session catalog", async () => {
  await trio(
    async ({ refusal, call, upward }) => {
      for (const name of ["provision", "send_message"]) {
        expect(
          await refusal({ name, arguments: { op: "machine_peer_lease" }, source: A }, "machine_origin_refused"),
        ).toBe(`machine_origin_refused: A may not call ${name}`);
      }
      expect(
        await call({
          name: "codemode.listMachines",
          arguments: {},
          source: { kind: "machine", machineId: "B" },
        }),
      ).toEqual({ status: "completed", value: [] });
      expect(
        await call({ name: "completion", arguments: { prompt: "hi" }, source: A }),
      ).toMatchObject({ status: "completed", value: "answer" });
      expect(await call({ name: "web_search", arguments: { query: "x" }, source: A })).toEqual({
        status: "completed",
        value: "web_search",
      });
      expect(upward.map((entry) => entry.name)).toEqual(["hold", "web_search"]);
    },
    { machineTools: ["web_search"], completion: async () => "answer" },
  );
});

test("session-origin provision call follows the existing guard path upward", async () => {
  await trio(async ({ call, seen, upward }) => {
    expect(
      await call({ name: "provision", arguments: { op: "machine_list" }, source: SESSION }),
    ).toEqual({ status: "completed", value: "provision" });
    expect(seen.at(-1)).toMatchObject({ name: "provision", source: SESSION });
    expect(upward.map((entry) => entry.name)).toEqual(["hold", "provision"]);
  });
});
