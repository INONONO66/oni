import { acquireEffect, runEffect } from "./helpers/effect";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMachineHost } from "@oni/machines";
import { Machine } from "@oni/protocol";
import { createCliDeps } from "../src/cli/main";
import { socketPath } from "./helpers/socket-path";
import { bounded } from "./helpers/protected-dispatch";
import { testIds } from "./helpers/test-entropy";
import { refusingToolPort } from "./helpers/tool-port";

test.each([false, true])("machine entry adapter handles enrollment %s", async (enrolled) => {
  const home = mkdtempSync(join(tmpdir(), "oni-machine-entry-"));
  const path = socketPath();
  const host = await acquireEffect(createMachineHost({
    dispatcherBound: 8,
    callTool: refusingToolPort,
    listen: { unix: path },
    id: testIds("entry-host"),
    enrollment: () =>
      enrolled
        ? {
            machineId: "entry-machine",
            name: "entry",
            allowedCapabilities: ["kernel.py"],
            publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            enrolledAt: 1,
          }
        : undefined,
    events: { publish: () => undefined },
    now: () => 2,
  }));
  const announced = Promise.withResolvers<Machine.AttachResult>();
  const log = spyOn(console, "log").mockImplementation((line: string) => {
    announced.resolve(Machine.AttachResult.parse(JSON.parse(line)));
  });
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
    const result = await bounded(
      Promise.race([
        announced.promise,
        attached.then(() => {
          throw new Error("machine exited before attachment");
        }),
      ]),
    );
    expect(result.status).toBe(enrolled ? "attached" : "refused");
    await runEffect(host.close());
    expect(await bounded(attached)).toBe(enrolled ? 0 : 1);
  } finally {
    log.mockRestore();
    for (const signal of signals)
      for (const listener of process.listeners(signal))
        if (!previous.has(listener)) process.removeListener(signal, listener);
    await runEffect(host.close());
    rmSync(home, { recursive: true, force: true });
  }
});
