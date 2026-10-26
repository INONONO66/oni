import { acquireEffect, runEffect } from "./helpers/effect";
import { testCellPorts } from "./helpers/native-tool-ports";
import { beforeAll, expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMachineHost, createMemoryGenerationStore } from "@oni/machines";
import { pinnedTcpHostOptions, qaOffer, spawnAttachCli, tlsFixturesDir } from "./helpers/machine-cli";
import { composeCodemode, type ComposedCodemode } from "../src/composition/codemode";
import { modelToolOutput } from "./helpers/tool-dispatch";
import { socketPath } from "./helpers/socket-path";
import { testIds } from "./helpers/test-entropy";
import { testBus } from "../../../packages/agent/test/helpers/isolated";
import { mclientBinary } from "./helpers/mclient";

beforeAll(mclientBinary, 180_000);

test("machine attach CLI composes real runners; eval pipelines two machine handles", async () => {
  const base = mkdtempSync("/tmp/om-cli-machine-");
  const events = testBus();
  const rootA = join(base, "a");
  const rootB = join(base, "b");
  mkdirSync(rootA);
  mkdirSync(rootB);
  const path = socketPath();
  const capabilities = ["fs.read", "fs.write", "shell.exec", "kernel.py"];
  let cells: ComposedCodemode;
  const host = await acquireEffect(createMachineHost({
    generations: createMemoryGenerationStore(),
    dispatcherBound: 8,
    listen: { unix: path },
    id: testIds("cli-host"),
    enrollment: (id) => ({
      machineId: id,
      name: id,
      tags: [id],
      allowedCapabilities: capabilities,
      allowedExports: ["data"],
      publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      enrolledAt: 1,
    }),
    events,
    now: Date.now,
    scheduler: { schedule(delayMs, task) {
      const timer = setTimeout(task, delayMs);
      return () => clearTimeout(timer);
    } },
    callTool: (call) => cells.callTool(call),
  }));
  cells = await acquireEffect(composeCodemode(host, { id: testIds("cli-compose"), selfMachineId: "A" }));
  const children: ReturnType<typeof spawn>[] = [];
  const exits: Promise<number>[] = [];
  async function attach(id: string, root: string) {
    const configPath = join(base, `${id}.json`);
    writeFileSync(configPath, JSON.stringify({ socketPath: path, offer: qaOffer(id, root, capabilities) }));
    const cli = spawnAttachCli(configPath, { host, events, machineId: id });
    children.push(cli.child);
    exits.push(cli.exited);
    expect(await cli.attachment()).toMatchObject({
      status: "attached",
      effectiveCapabilities: [...capabilities].sort(),
    });
  }
  try {
    await attach("A", rootA);
    await attach("B", rootB);
    const code = [
      "ids = [m['machineId'] for m in codemode.listMachines()]",
      "src = machine(tag='A')",
      "dst = machine('B')",
      `src.write(${JSON.stringify(join(rootA, "source"))}, bytes([0, 255, 128, 65]))`,
      `data = src.read(${JSON.stringify(join(rootA, "source"))})['data']`,
      `written = dst.write(${JSON.stringify(join(rootB, "copy"))}, data)`,
      `readback = dst.read(${JSON.stringify(join(rootB, "copy"))})['data']`,
      `shell = dst.bash('printf out; printf err >&2; exit 7', ${JSON.stringify(rootB)})`,
      "nested = dst.eval('6 * 7')",
      "state = 41",
      "(ids, list(readback), written['bytesWritten'], shell['stdout'], shell['stderr'], shell['exitCode'], nested['value'])",
    ].join("\n");
    const run = modelToolOutput("eval", { cells: testCellPorts(cells) }, { role: "resident", sessionId: "qa-one" });
    const result = await run({ operation: { op: "run", code, timeout: 10 } });
    expect(result).toBe("(['A', 'B'], [0, 255, 128, 65], 4, b'out', b'err', 7, '42')");
    expect(await run({ operation: { op: "run", code: "state + 1", timeout: 1 } })).toBe("42");
    const other = await modelToolOutput(
      "eval",
      { cells: testCellPorts(cells) },
      { role: "resident", sessionId: "qa-two" },
    )({ operation: { op: "run", code: "state", timeout: 15 } });
    expect(other).toContain("NameError");
    const write = await runEffect(host
      .get("B")
      .fs.write(join(rootB, "receipt"), Buffer.from([0, 255, 128, 65])));
    const execution = await runEffect(host.get("B").exec("printf out; printf err >&2; exit 7", rootB));
    if (execution.status !== "completed") throw new Error("QA exec did not complete");
    const codeResult = await runEffect(host
      .get("B")
      .runCode({ cellId: "qa-code", code: "6 * 7", tenant: "qa-raw", timeoutMs: 15_000 }));
    expect(codeResult).toMatchObject({ status: "completed", value: "42" });
    console.log(
      "machines-codemode QA",
      JSON.stringify({
        list: host.list(),
        write,
        readback: [...(await runEffect(host.get("B").fs.read(join(rootB, "copy")))).data],
        exec: {
          stdout: [...execution.stdout],
          stderr: [...execution.stderr],
          exitCode: execution.exitCode,
          signal: execution.signal,
        },
        runCode: codeResult,
        result,
        tenantIsolation: "NameError",
        daemonPids: children.map((child) => child.pid),
      }),
    );
  } finally {
    await runEffect(cells.close());
    for (const child of children) child.kill("SIGTERM");
    expect(await Promise.all(exits)).toEqual([143, 143]);
    await runEffect(host.close());
    events.close();
    rmSync(base, { recursive: true, force: true });
    console.log(
      "machines-codemode cleanup",
      JSON.stringify({
        daemonExits: exits.length,
        socketExists: existsSync(path),
        directoryExists: existsSync(base),
      }),
    );
  }
}, 30_000);

test("machine attach CLI reaches a network host over pinned TLS", async () => {
  const base = mkdtempSync("/tmp/om-cli-tcp-");
  const events = testBus();
  const root = join(base, "data");
  mkdirSync(root);
  writeFileSync(join(root, "note"), "over-the-wire");
  const host = await acquireEffect(createMachineHost(pinnedTcpHostOptions(testIds("cli-tcp-host"), ["fs.read"], events)));
  const configPath = join(base, "machine.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      tcp: { host: "127.0.0.1", port: host.endpoints.tcp?.port },
      hostCertificate: join(tlsFixturesDir, "host-cert.pem"),
      tlsCertificate: join(tlsFixturesDir, "daemon-cert.pem"),
      tlsPrivateKey: join(tlsFixturesDir, "daemon-key.pem"),
      offer: qaOffer("net-1", root, ["fs.read"]),
    }),
  );
  const cli = spawnAttachCli(configPath, { host, events, machineId: "net-1" });
  try {
    expect(await cli.attachment()).toMatchObject({
      status: "attached",
      effectiveCapabilities: ["fs.read"],
    });
    const read = await runEffect(host.get("net-1").fs.read(join(root, "note")));
    expect(Buffer.from(read.data).toString()).toBe("over-the-wire");
  } finally {
    cli.child.kill("SIGTERM");
    expect(await cli.exited).toBe(143);
    await runEffect(host.close());
    events.close();
    rmSync(base, { recursive: true, force: true });
  }
}, 30_000);
