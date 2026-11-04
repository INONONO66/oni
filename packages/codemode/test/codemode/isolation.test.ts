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
import { eventCollector } from "../../../machines/test/helpers/events";
import type { PeerLeasePort } from "../../src";
import { MachinesFailure } from "@oni/machines";
import { createCodemode } from "./helpers/native";

beforeAll(mclientBinary, 300_000);

// #1841: the host stamps the attachment that delivered a call; these tests
// inject that stamp directly and prove what codemode does with it. The cell
// runs on `C` (the session's own machine); `A` and `B` are the isolated pair.
const A: Machine.ToolCallSource = { kind: "machine", machineId: "A" };
const SESSION: Machine.ToolCallSource = { kind: "session" };

/** A peer-lease port over one in-memory lease list with an injectable clock. */
function leaseTable(now: () => number) {
  const leases: Machine.PeerLease[] = [];
  const used: Array<{ from: string; to: string; op: Machine.PeerLeaseOp }> = [];
  const live = (from: string) =>
    leases.filter((lease) => lease.from === from && lease.expiresAt > now());
  const port: PeerLeasePort = {
    peerLease(from, to, op) {
      const lease = live(from).find((entry) => entry.to === to && entry.ops.includes(op));
      if (lease !== undefined) used.push({ from, to, op });
      return lease;
    },
    peerTargets: (from) => live(from).map((lease) => lease.to),
  };
  return {
    port,
    used,
    issue(lease: Omit<Machine.PeerLease, "id" | "delegationId">) {
      leases.push({ id: `lease-${leases.length + 1}`, delegationId: "d-1", ...lease });
    },
  };
}

async function trio(
  run: (context: {
    mode: ReturnType<typeof createCodemode>;
    b: string;
    call: (call: Omit<Machine.ToolCall, "cellId">) => Promise<Machine.ToolCallResult>;
    refusal: (call: Omit<Machine.ToolCall, "cellId">) => Promise<string>;
    seen: Machine.ToolCall[];
    upward: Machine.ToolCall[];
  }) => Promise<void>,
  options: Pick<
    NonNullable<Parameters<typeof createCodemode>[0]>,
    "machineTools" | "completion" | "peers"
  > = {},
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
    now: () => 2,
    scheduler: { schedule: () => () => undefined },
    callTool: (call) => mode.callTool(call),
  });
  mode = createCodemode({
    ...options,
    machines: host,
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
    const call = (request: Omit<Machine.ToolCall, "cellId">) =>
      mode.callTool({ cellId: "cell-1", ...request });
    const refusal = async (request: Omit<Machine.ToolCall, "cellId">) => {
      const failure = await call(request).then(
        () => undefined,
        (error: Error) => error,
      );
      if (!(failure instanceof MachinesFailure))
        throw new Error(`expected a MachinesFailure, got ${String(failure)}`);
      expect(failure.operation).toBe("code.tool");
      return failure.cause;
    };
    await run({ mode, b: roots.B, call, refusal, seen, upward });
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

const exec = (b: string, source: Machine.ToolCallSource): Omit<Machine.ToolCall, "cellId"> => ({
  name: "codemode.bash",
  arguments: { machineId: "B", cmd: "printf reached", cwd: b },
  source,
});

test("A-origin machine('B').exec is refused machine_isolated without a peer lease", async () => {
  await trio(async ({ b, refusal, seen, upward }) => {
    expect(await refusal(exec(b, A))).toBe("machine_isolated: A holds no peer lease for exec on B");
    expect(seen.at(-1)).toMatchObject({ name: "codemode.bash", source: A });
    expect(upward.map((call) => call.name)).toEqual(["hold"]);
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

test("after a lease is issued the A call is allowed and its use is recorded; after TTL expiry it is refused", async () => {
  let now = 10;
  const table = leaseTable(() => now);
  await trio(
    async ({ b, call, refusal }) => {
      table.issue({ from: "A", to: "B", ops: ["exec"], ttlMs: 5, expiresAt: 15 });
      expect(await call(exec(b, A))).toMatchObject({
        status: "completed",
        value: { exitCode: 0, stdout: Buffer.from("reached").toString("base64") },
      });
      expect(table.used).toEqual([{ from: "A", to: "B", op: "exec" }]);
      expect(
        await refusal({
          name: "codemode.read",
          arguments: { machineId: "B", path: join(b, "none") },
          source: A,
        }),
      ).toBe("machine_isolated: A holds no peer lease for fs on B");
      now = 15;
      expect(await refusal(exec(b, A))).toBe(
        "machine_isolated: A holds no peer lease for exec on B",
      );
      expect(table.used).toHaveLength(1);
    },
    { peers: table.port },
  );
});

test("A's listMachines and findMachine hide B without a lease and show only lease targets with one", async () => {
  const table = leaseTable(() => 0);
  await trio(
    async ({ call, refusal }) => {
      const find = { name: "codemode.findMachine", arguments: { query: { tag: "B" } } };
      expect(await call({ name: "codemode.listMachines", arguments: {}, source: A })).toEqual({
        status: "completed",
        value: [],
      });
      expect(await refusal({ ...find, source: A })).toBe(
        "machine_isolated: A holds no peer lease for tag B",
      );
      table.issue({ from: "A", to: "B", ops: ["fs"], ttlMs: 1, expiresAt: 1 });
      expect(await call({ name: "codemode.listMachines", arguments: {}, source: A })).toMatchObject(
        { status: "completed", value: [{ machineId: "B" }] },
      );
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
    },
    { peers: table.port },
  );
});

test("A-origin forged provision call is refused machine_origin_refused before the session catalog", async () => {
  await trio(
    async ({ refusal, call, upward }) => {
      for (const name of ["provision", "send_message"]) {
        expect(await refusal({ name, arguments: { op: "machine_peer_lease" }, source: A })).toBe(
          `machine_origin_refused: A may not call ${name}`,
        );
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
