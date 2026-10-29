import { acquireEffect, runEffect } from "./helpers/effect";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMachineHost, createMemoryGenerationStore } from "@oni/machines";
import { Machine } from "@oni/protocol";
import { createCliDeps } from "../src/cli/main";
import { socketPath } from "./helpers/socket-path";
import { bounded } from "./helpers/protected-dispatch";
import { testIds } from "./helpers/test-entropy";
import { refusingToolPort } from "./helpers/tool-port";
import { Bus } from "./helpers/bus";
import { mclientBinary } from "./helpers/mclient";

test.each([false, true])("machine entry adapter handles enrollment %s", async (enrolled) => {
  const home = mkdtempSync(join(tmpdir(), "oni-machine-entry-"));
  const path = socketPath();
  const admitted = Promise.withResolvers<void>();
  const refused = Promise.withResolvers<void>();
  const retried = Promise.withResolvers<void>();
  let enrollmentChecks = 0;
  let attachmentCount = 0;
  const unsubscribe = Bus.subscribe(Machine.Events.Attached, (event) => {
    if (event.machineId !== "entry-machine") return;
    attachmentCount += 1;
    admitted.resolve();
  });
  const host = await acquireEffect(createMachineHost({
    generations: createMemoryGenerationStore(),
    dispatcherBound: 8,
    callTool: refusingToolPort,
    listen: { unix: path },
    id: testIds("entry-host"),
    enrollment: () => {
      enrollmentChecks += 1;
      if (enrollmentChecks === 1) refused.resolve();
      if (enrollmentChecks === 2) retried.resolve();
      return enrolled
        ? {
            machineId: "entry-machine",
            name: "entry",
            allowedCapabilities: ["kernel.py"],
            publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            enrolledAt: 1,
          }
        : undefined;
    },
    events: Bus,
    now: () => 2,
  }));
  const signals = ["SIGINT", "SIGTERM"] as const;
  const previous = new Set(signals.flatMap((signal) => process.listeners(signal)));
  // Build and warm the client before any bounded wait starts.
  const binary = await mclientBinary();
  let attached: Promise<number> | undefined;
  try {
    const configPath = join(home, "machine.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        socketPath: path,
        offer: {
          machineId: "entry-machine",
          offeredCapabilities: ["kernel.py"],
          exports: [{ name: "root", path: home }],
          daemonVersion: "fixture",
          platform: process.platform,
          offeredAt: 2,
        },
      }),
    );
    attached = createCliDeps(home).attachMachine(configPath);
    const hostFact = enrolled ? admitted.promise : refused.promise;
    await bounded(Promise.race([
      hostFact,
      attached.then((code) => { throw new Error(`machine exited before admission: ${code}`); }),
    ]), enrolled ? "host attachment" : "host refusal");
    if (!enrolled) {
      expect(enrollmentChecks).toBe(1);
      const clientConfig = join(home, `.mclient-entry-machine`, "client.json");
      const retry = Bun.spawn([binary, "retry", "--config", clientConfig], {
        env: { ...process.env, HOME: home },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      expect(await bounded(retry.exited)).toBe(0);
      await bounded(retried.promise, "explicit client retry");
      expect(enrollmentChecks).toBe(2);
    }
    expect(attachmentCount).toBe(enrolled ? 1 : 0);
    expect(host.list().some((entry) => entry.machineId === "entry-machine")).toBe(enrolled);
    await runEffect(host.close());
    process.emit("SIGTERM");
    // An attached client exits cleanly when the host closes; a refused one
    // exits cleanly when CLI shutdown stops it.
    expect(await bounded(attached)).toBe(0);
  } finally {
    unsubscribe();
    // A failed assertion must not leave the client running under launchd.
    process.emit("SIGTERM");
    if (attached !== undefined) await bounded(attached, "client shutdown").catch(() => undefined);
    for (const signal of signals)
      for (const listener of process.listeners(signal))
        if (!previous.has(listener)) process.removeListener(signal, listener);
    await runEffect(host.close());
    rmSync(home, { recursive: true, force: true });
  }
});
