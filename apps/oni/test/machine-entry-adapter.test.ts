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

test.each([false, true])("machine entry adapter handles enrollment %s", async (enrolled) => {
  const home = mkdtempSync(join(tmpdir(), "oni-machine-entry-"));
  const path = socketPath();
  const admitted = Promise.withResolvers<void>();
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
    const attached = createCliDeps(home).attachMachine(configPath);
    const hostFact = enrolled ? admitted.promise : retried.promise;
    await bounded(Promise.race([
      hostFact,
      attached.then((code) => { throw new Error(`machine exited before admission: ${code}`); }),
    ]), enrolled ? "host attachment" : "host refusal and client retry");
    expect(attachmentCount).toBe(enrolled ? 1 : 0);
    expect(host.list().some((entry) => entry.machineId === "entry-machine")).toBe(enrolled);
    await runEffect(host.close());
    process.emit("SIGTERM");
    // An attached client exits cleanly when the host closes; a refused one keeps
    // retrying and exits cleanly when CLI shutdown stops it.
    expect(await bounded(attached)).toBe(0);
  } finally {
    unsubscribe();
    for (const signal of signals)
      for (const listener of process.listeners(signal))
        if (!previous.has(listener)) process.removeListener(signal, listener);
    await runEffect(host.close());
    rmSync(home, { recursive: true, force: true });
  }
});
