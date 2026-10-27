import { acquireEffect, closeAcquiredEffects, runEffect } from "./helpers/effect";
import { expect, test } from "bun:test";
import net from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Scope, Exit, Result } from "effect";
import { createMachineHost, MachinesFailure } from "@oni/machines";
import { type BusEvent, Machine } from "@oni/protocol";
import { attachConfiguredMachine } from "../src/cli/machine";
import { testIds } from "./helpers/test-entropy";
import { startProxy } from "../../../packages/machines/test/helpers/proxy";
import { pinnedTcpHostOptions, qaOffer, tlsFixturesDir } from "./helpers/machine-cli";

/** Event-driven attach and report signals: no sleeps, no polling. */
function attachSignal() {
  const waiters = new Map<string, Array<() => void>>();
  const sink: BusEvent.Sink = {
    publish(descriptor) {
      for (const waiter of waiters.get(descriptor.name)?.splice(0) ?? []) waiter();
    },
  };
  const next = (name: string, label: string): Promise<void> =>
    new Promise((resolve, reject) => {
      waiters.set(name, [...(waiters.get(name) ?? []), resolve]);
      AbortSignal.timeout(15_000).addEventListener("abort", () => reject(new Error(`timed out waiting for ${name}: ${label}`)));
    });
  return {
    sink,
    nextAttach: (label: string) => next(Machine.Events.Attached.name, label),
    nextReport: (label: string) => next(Machine.Events.Reported.name, label),
  };
}

test("attachConfiguredMachine launches a Rust client over pinned TLS and redials after a transport drop", async () => {
  const base = mkdtempSync("/tmp/om-cfg-tcp-");
  const root = join(base, "data");
  mkdirSync(root);
  writeFileSync(join(root, "note"), "configured-over-tls");
  const events = attachSignal();
  const host = await acquireEffect(createMachineHost(pinnedTcpHostOptions(testIds("cfg-host"), ["fs.read"], events.sink)));
  const targetPort = host.endpoints.tcp?.port ?? 0;
  const proxy = await startProxy({ port: 0 }, () => net.connect(targetPort, "127.0.0.1"));
  const configPath = join(base, "machine.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      tcp: { host: "127.0.0.1", port: proxy.port },
      hostCertificate: join(tlsFixturesDir, "host-cert.pem"),
      tlsCertificate: join(tlsFixturesDir, "daemon-cert.pem"),
      tlsPrivateKey: join(tlsFixturesDir, "daemon-key.pem"),
      offer: qaOffer("cfg-1", root, ["fs.read"]),
    }),
  );
  try {
    const firstAttach = events.nextAttach("initial");
    const firstReport = events.nextReport("initial");
    await acquireEffect(attachConfiguredMachine(configPath));
    await firstAttach;
    expect(host.list()[0]).toMatchObject({ peer: { kind: "client" }, capabilities: ["fs.read"] });
    // The production daemon probes its box into the offer and beats right after attach (#1555).
    await firstReport;
    expect(host.list()[0]).toMatchObject({ machineId: "cfg-1", resources: { cpus: expect.any(Number), memoryBytes: expect.any(Number) }, live: { stale: false } });
    const read = await runEffect(host.get("cfg-1").fs.read(join(root, "note")));
    expect(Buffer.from(read.data).toString()).toBe("configured-over-tls");
    // The production reconnect (real timers, jittered <=250ms first delay)
    // redials through the surviving listener; the host's attach event is the signal.
    const reattach = events.nextAttach("after transport drop");
    const reported = events.nextReport("after transport drop");
    proxy.sever();
    await reattach;
    await reported;
    expect(host.list()[0]?.generation).toBe(1);
    const again = await runEffect(host.get("cfg-1").fs.read(join(root, "note")));
    expect(Buffer.from(again.data).toString()).toBe("configured-over-tls");
  } finally {
    await closeAcquiredEffects();
    await proxy.stop();
    rmSync(base, { recursive: true, force: true });
  }
}, 30_000);

test("attachConfiguredMachine rejects an incomplete TLS configuration with a typed decode failure", async () => {
  const base = mkdtempSync(join(tmpdir(), "om-cfg-bad-"));
  const configPath = join(base, "machine.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      tcp: { host: "127.0.0.1", port: 4433 },
      hostCertificate: join(tlsFixturesDir, "host-cert.pem"),
      tlsCertificate: join(tlsFixturesDir, "daemon-cert.pem"),
      // tlsPrivateKey is missing: the config union must refuse, never dial.
      offer: qaOffer("cfg-bad", "/tmp", ["fs.read"]),
    }),
  );
  try {
    const scope = await runEffect(Scope.make());
    const result = await runEffect(
      Effect.result(Scope.provide(attachConfiguredMachine(configPath), scope)),
    );
    await runEffect(Scope.close(scope, Exit.void));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      const failure = result.failure;
      expect(failure).toBeInstanceOf(MachinesFailure);
      expect((failure as MachinesFailure).operation).toBe("configuration.decode");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 15_000);
