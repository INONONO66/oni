import { beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Machine } from "@oni/protocol";
import { createMachineHost } from "../src/host";
import { createMemoryGenerationStore } from "../src/generation-store";
import { acquire, run } from "./ipc/helpers/effects";
import { connectIpcClient } from "./ipc/helpers/native";
import { socketPath } from "./helpers/socket-path";
import { refusingToolPort } from "./helpers/native";
import { attachMclient, mclientBinary, mclientEnrollment } from "./helpers/mclient";
import { eventCollector } from "./helpers/events";

beforeAll(mclientBinary, 300_000);

const release = Machine.Release.parse({
  version: "0.4.0",
  contractVersion: Machine.contractVersion,
  artifacts: { "linux-x86_64": { name: "mclient-linux-x86_64.tar.gz", bytes: 12, sha256: "a".repeat(64), url: "file:///r/mclient-linux-x86_64.tar.gz" } },
});

async function releaseAnswer(source: (() => Machine.Release | undefined) | undefined) {
  const path = socketPath();
  let enrollments = 0;
  const { value: host, close } = await acquire(createMachineHost({
    listen: { unix: path }, id: () => crypto.randomUUID(), dispatcherBound: 16,
    enrollment: () => { enrollments += 1; return undefined; },
    generations: createMemoryGenerationStore(), events: { publish: () => undefined },
    now: () => 3, callTool: refusingToolPort, ...(source === undefined ? {} : { release: source }),
  }));
  const client = await connectIpcClient(path);
  try {
    const answer = Machine.ReleaseResult.parse(await client.call(Machine.WireMethod.Release, {}));
    return { answer, enrollments, attached: host.list().length };
  } finally {
    await client.close();
    await run(host.close());
    await close();
  }
}

test("machine.release answers the pinned release before any attachment (#1696)", async () => {
  expect(await releaseAnswer(() => release)).toEqual({ answer: { status: "available", release }, enrollments: 0, attached: 0 });
});

test("machine.release refuses release_unavailable when the host has no release or no source", async () => {
  const refused = { answer: { status: "refused", reason: "release_unavailable" }, enrollments: 0, attached: 0 } as const;
  expect(await releaseAnswer(() => undefined)).toEqual(refused);
  expect(await releaseAnswer(undefined)).toEqual(refused);
});

test("checksum refusal leaves the attached client serving and never admits the probe", async () => {
  const root = mkdtempSync(join(tmpdir(), "oni-release-attached-"));
  const home = join(root, "home");
  const path = socketPath();
  const events = eventCollector();
  let releaseCalls = 0;
  let admissions = 0;
  const archive = join(root, "archive.tgz");
  writeFileSync(archive, "archive");
  const document = Machine.Release.parse({
    version: "0.1.1",
    contractVersion: Machine.contractVersion,
    artifacts: {
      [process.platform === "darwin" ? "darwin-universal" : process.arch === "arm64" ? "linux-arm64" : "linux-x86_64"]:
        { name: "archive.tgz", bytes: 7, sha256: "0".repeat(64), url: archive },
    },
  });
  const { value: host, close } = await acquire(createMachineHost({
    listen: { unix: path }, id: () => crypto.randomUUID(), dispatcherBound: 16,
    enrollment: (id) => { admissions++; return id === "desk" ? mclientEnrollment("desk") : undefined; },
    generations: createMemoryGenerationStore(), events: events.sink,
    now: () => 3, callTool: refusingToolPort,
    release: () => { releaseCalls++; return document; },
  }));
  let client: Awaited<ReturnType<typeof attachMclient>> | undefined;
  try {
    client = await attachMclient({ host, events, machineId: "desk", root });
    const target = join(root, "working");
    writeFileSync(target, "still serving");
    const before = await run(host.get("desk").fs.read(target));
    const admitted = admissions;
    mkdirSync(join(home, ".oni/machine-client"), { recursive: true });
    mkdirSync(join(home, ".oni/bin"));
    symlinkSync("/old/mclient", join(home, ".oni/bin/current"));
    writeFileSync(join(home, ".oni/machine-client/client.json"), JSON.stringify({
      machineId: "desk", name: "desk", host: "localhost", unix: path,
      exports: [{ name: "workspace", path: root }], tags: [], memoryBudgetMb: 96,
    }));
    const releasePath = join(root, "release.json");
    writeFileSync(releasePath, JSON.stringify(document));
    const update = Bun.spawn([await mclientBinary(), "update", "--file", releasePath], {
      env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([update.exited, new Response(update.stderr).text()]);
    expect(code).toBe(2);
    expect(JSON.parse(stderr)).toMatchObject({ reason: "update_failed", class: "checksum_mismatch" });
    expect({ releaseCalls, admissions }).toEqual({ releaseCalls: 1, admissions: admitted });
    expect(await run(host.get("desk").fs.read(target))).toEqual(before);
    expect(host.list()).toMatchObject([{ machineId: "desk", generation: client.info.generation }]);
    expect(readlinkSync(join(home, ".oni/bin/current"))).toBe("/old/mclient");
    expect(JSON.parse(readFileSync(join(home, ".oni/machine-client/metrics.jsonl"), "utf-8")))
      .toMatchObject({ event: "update", status: "refused", reason: "update_failed", class: "checksum_mismatch" });
  } finally {
    await client?.stop();
    await run(host.close());
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});
