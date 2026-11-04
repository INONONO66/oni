import { acquireEffect, runEffect } from "./helpers/effect";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMachineHost, createMemoryGenerationStore } from "@oni/machines";
import { Machine } from "@oni/protocol";
import { socketPath } from "./helpers/socket-path";
import { bounded } from "./helpers/protected-dispatch";
import { testIds } from "./helpers/test-entropy";
import { refusingToolPort } from "./helpers/tool-port";
import { Bus } from "./helpers/bus";
import { writeClientDirectory } from "./helpers/machine-cli";
import { mclientBinary } from "./helpers/mclient";

test.each([false, true])("a real client follows the app host's enrollment decision (enrolled: %p)", async (enrolled) => {
  const home = mkdtempSync(join(tmpdir(), "oni-mclient-enrollment-"));
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
  // Build and warm the client before any bounded wait starts.
  const binary = await mclientBinary();
  const configPath = writeClientDirectory(join(home, "client"), { machineId: "entry-machine", root: home, endpoint: { unix: path } });
  const env = { ...process.env, HOME: home };
  const client = Bun.spawn([binary, "run", "--allow-unpinned", "--config", configPath], {
    env, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  try {
    const hostFact = enrolled ? admitted.promise : refused.promise;
    await bounded(Promise.race([
      hostFact,
      client.exited.then((code) => { throw new Error(`client exited before admission: ${code}`); }),
    ]), enrolled ? "host attachment" : "host refusal");
    if (!enrolled) {
      expect(enrollmentChecks).toBe(1);
      const reconnect = Bun.spawn([binary, "reconnect", "--config", configPath], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      expect(await bounded(reconnect.exited)).toBe(0);
      await bounded(retried.promise, "explicit client reconnect");
      expect(enrollmentChecks).toBe(2);
    }
    expect(attachmentCount).toBe(enrolled ? 1 : 0);
    expect(host.list().some((entry) => entry.machineId === "entry-machine")).toBe(enrolled);
    await runEffect(host.close());
    // An attached client and a refused one both leave cleanly on TERM.
    client.kill("SIGTERM");
    expect(await bounded(client.exited)).toBe(0);
  } finally {
    unsubscribe();
    // A failed assertion must not leave the client running.
    client.kill("SIGKILL");
    await runEffect(host.close());
    rmSync(home, { recursive: true, force: true });
  }
});
