import { describe, expect, test } from "bun:test";
import net from "node:net";
import type { Machine } from "@oni/protocol";
import { attachMachineDaemon, createMachineHost, type CodeRunner } from "./helpers/native";
import { captureError, within } from "./ipc/helpers/signal";
import { socketPath } from "./helpers/socket-path";
import { eventCollector } from "./helpers/events";
import { startProxy } from "./helpers/proxy";
import { daemonFingerprint, daemonIdentity, hostIdentity, wrongIdentity } from "./ipc/helpers/tls-fixtures";

/**
 * #1270 reconnect proof: time is driven ONLY through the injected scheduler
 * and jitter ONLY through the injected randomness — no sleeps, no polling.
 */
type Scheduled = { readonly delay: number; task: () => void; cancelled: boolean };
function fakeScheduler() {
  const entries: Scheduled[] = [];
  const waiters: Array<(entry: Scheduled) => void> = [];
  return {
    entries,
    schedule(delay: number, task: () => void): () => void {
      const entry: Scheduled = { delay, task, cancelled: false };
      entries.push(entry);
      for (const waiter of waiters.splice(0)) waiter(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    /** Resolves on the NEXT schedule() call (bounded by bun's test timeout). */
    nextScheduled(): Promise<Scheduled> {
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

const enrollment: Machine.Enrollment = {
  name: "roaming",
  machineId: "m-1",
  allowedCapabilities: ["kernel.py"],
  publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  enrolledAt: 1,
};
function offer(): Machine.Offer {
  return {
    machineId: "m-1",
    daemonVersion: "test",
    platform: "darwin-arm64",
    offeredCapabilities: ["kernel.py"],
    offeredAt: 2,
  };
}
function cell(cellId: string): Machine.CellRequest {
  return { cellId, code: "x", timeoutMs: 60_000 };
}

/** Records every runCode by cellId; "orphan" is held until released. */
function heldRunner() {
  const started = new Map<string, number>();
  const release = Promise.withResolvers<void>();
  let entered: (() => void) | undefined;
  let closes = 0;
  const runner: CodeRunner = {
    runCode: async (request) => {
      started.set(request.cellId, (started.get(request.cellId) ?? 0) + 1);
      entered?.();
      if (request.cellId === "orphan") await release.promise;
      return { status: "completed", cellId: request.cellId, value: request.cellId, output: { stdout: "", stderr: "" } };
    },
    peekCode: () => ({ stdout: "", stderr: "" }),
    close: async () => {
      closes += 1;
    },
  };
  return {
    runner,
    started,
    release: () => release.resolve(),
    closes: () => closes,
    entered(): Promise<void> {
      return new Promise((resolve) => {
        entered = resolve;
      });
    },
  };
}

/** One enrolled unix host and a reconnect-armed daemon driven by the fake clock. */
async function reconnectFixture(options: {
  readonly enroll?: () => Machine.Enrollment | undefined;
  readonly events?: ReturnType<typeof eventCollector>["sink"];
  readonly runner?: CodeRunner;
} = {}) {
  const hostPath = socketPath();
  const host = await createMachineHost({
    listen: { unix: hostPath },
    enrollment: options.enroll ?? (() => enrollment),
    events: options.events ?? { publish: () => undefined },
    now: () => 7,
  });
  const clock = fakeScheduler();
  const daemon = await attachMachineDaemon({
    socketPath: hostPath,
    offer: offer(),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    reconnect: { scheduler: clock, random: () => 1 },
  });
  return { host, clock, daemon };
}

describe("daemon reattach over a dropped transport", () => {
  test("drop fails pending once, jittered attempts reattach, old handle serves the replacement, refusal stops reconnect", async () => {
    const hostPath = socketPath();
    const proxyPath = socketPath();
    const collector = eventCollector();
    let enrolled: Machine.Enrollment | undefined = enrollment;
    const host = await createMachineHost({
      listen: { unix: hostPath },
      enrollment: () => enrolled,
      events: collector.sink,
      now: () => 7,
    });
    const proxy = await startProxy(proxyPath, () => net.connect(hostPath));
    const clock = fakeScheduler();
    const randoms = [0.5, 1, 0.25, 1];
    const code = heldRunner();
    const daemon = await attachMachineDaemon({
      socketPath: proxyPath,
      offer: offer(),
      runner: code.runner,
      reconnect: { scheduler: clock, random: () => randoms.shift() ?? 1 },
    });
    try {
      expect(daemon.attachment.status).toBe("attached");
      const handle = host.get("m-1");
      const entered = code.entered();
      const pendingCall = captureError(handle.runCode(cell("orphan")));
      await within(entered, "daemon runner entry");

      // Network loss: the one in-flight call settles once as `disconnected`.
      const detached = collector.next("machine.detached");
      const firstSchedule = clock.nextScheduled();
      proxy.sever();
      expect(await within(pendingCall, "pending call settles")).toMatchObject({
        _tag: "MachineRefusalError",
        reason: "disconnected",
      });
      await within(detached, "host detach");

      // Reconnect-window semantics: known machine reads disconnected,
      // a never-attached identity keeps machine_not_attached.
      expect(await captureError(handle.runCode(cell("window")))).toMatchObject({
        _tag: "MachineRefusalError",
        reason: "disconnected",
      });
      expect(await captureError(host.get("ghost").peekCode("nope"))).toMatchObject({
        _tag: "MachineRefusalError",
        reason: "machine_not_attached",
      });

      // Full jitter with injected randomness: delay = random * min(cap, 250·2^attempt).
      const first = await within(firstSchedule, "first reconnect schedule");
      expect(first.delay).toBe(Math.floor(0.5 * 250));
      await proxy.stop(); // the host endpoint is unreachable for two attempts
      const second = clock.nextScheduled();
      first.task();
      expect((await within(second, "second schedule")).delay).toBe(Math.floor(1 * 500));
      const third = clock.nextScheduled();
      (await second).task();
      expect((await within(third, "third schedule")).delay).toBe(Math.floor(0.25 * 1000));

      // The endpoint returns; the next attempt reattaches the SAME identity.
      const revived = await startProxy(proxyPath, () => net.connect(hostPath));
      try {
        const reattached = collector.next("machine.attached");
        (await third).task();
        await within(reattached, "same-identity reattach");
        expect(daemon.attachment.status).toBe("attached");

        // The OLD handle dispatches a NEW request through the replacement
        // connection; the failed call was never replayed.
        expect(await within(handle.runCode(cell("fresh")), "post-reattach call")).toMatchObject({
          status: "completed",
          value: "fresh",
        });
        expect(code.started.get("fresh")).toBe(1);
        expect(code.started.get("orphan")).toBe(1);

        // A successful attach reset the attempt counter: the next drop backs
        // off from the base ceiling again.
        const afterReset = clock.nextScheduled();
        revived.sever();
        expect((await within(afterReset, "post-reset schedule")).delay).toBe(Math.floor(1 * 250));

        // A refused reattach surfaces the refusal, schedules nothing
        // further, and closes the daemon until a restart or config change.
        enrolled = undefined;
        const scheduled = clock.entries.length;
        code.release();
        const settled = daemon.closed;
        (await afterReset).task();
        await within(settled, "daemon closes after refused reattach");
        expect(daemon.attachment).toEqual({ status: "refused", reason: "machine_not_enrolled" });
        expect(clock.entries.length).toBe(scheduled);
        expect(code.closes()).toBe(1);
      } finally {
        await revived.stop();
      }
    } finally {
      code.release();
      await daemon.close();
      await host.close();
    }
  });

  test("a rotated host key during reconnect is terminal: the pin refusal surfaces, the daemon closes, nothing is rescheduled", async () => {
    // Two REAL pinned-TLS hosts: the original and its "rotated" impostor —
    // same machine enrollment, different host identity. The proxy retargets
    // dials, standing in for the same address now presenting a new key.
    const original = await createMachineHost({
      listen: { tcp: { host: "127.0.0.1", port: 0 } },
      tls: hostIdentity,
      enrollment: () => ({ ...enrollment, publicKey: daemonFingerprint }),
      events: { publish: () => undefined },
      now: () => 7,
    });
    const rotated = await createMachineHost({
      listen: { tcp: { host: "127.0.0.1", port: 0 } },
      tls: wrongIdentity,
      enrollment: () => ({ ...enrollment, publicKey: daemonFingerprint }),
      events: { publish: () => undefined },
      now: () => 7,
    });
    const target = { port: original.endpoints.tcp?.port ?? 0 };
    const proxy = await startProxy({ port: 0 }, () => net.connect(target.port, "127.0.0.1"));
    const clock = fakeScheduler();
    const daemon = await attachMachineDaemon({
      tcp: { host: "127.0.0.1", port: proxy.port },
      hostCertificate: hostIdentity.certificate,
      tlsCertificate: daemonIdentity.certificate,
      tlsPrivateKey: daemonIdentity.privateKey,
      offer: offer(),
      reconnect: { scheduler: clock, random: () => 1 },
    });
    try {
      expect(daemon.attachment.status).toBe("attached");

      // The host certificate rotates while the transport is down: the redial
      // fails chain validation against the configured certificate — terminal.
      target.port = rotated.endpoints.tcp?.port ?? 0;
      const scheduled = clock.nextScheduled();
      proxy.sever();
      const attempt = await within(scheduled, "reconnect scheduled after drop");
      const settled = daemon.closed;
      attempt.task();
      await within(settled, "daemon closes on pin mismatch");
      expect(daemon.attachment).toEqual({ status: "refused", reason: "peer_key_mismatch" });
      // Terminal: the mismatch attempt scheduled nothing further.
      expect(clock.entries).toHaveLength(1);
    } finally {
      await daemon.close();
      await proxy.stop();
      await rotated.close();
      await original.close();
    }
  });

  test("a refused initial attachment never schedules reconnect on disconnect", async () => {
    const { host, clock, daemon } = await reconnectFixture({ enroll: () => undefined });
    expect(daemon.attachment).toEqual({ status: "refused", reason: "machine_not_enrolled" });
    const settled = daemon.closed;
    await host.close();
    await within(settled, "refused daemon closes on disconnect");
    expect(clock.entries).toHaveLength(0);
  });

  test("explicit close during backoff cancels the scheduled attempt and releases drivers exactly once", async () => {
    const code = heldRunner();
    const { host, clock, daemon } = await reconnectFixture({ runner: code.runner });
    expect(daemon.attachment.status).toBe("attached");
    const scheduled = clock.nextScheduled();
    await host.close();
    const entry = await within(scheduled, "backoff scheduled on host loss");
    await daemon.close();
    expect(entry.cancelled).toBe(true);
    expect(clock.entries).toHaveLength(1);
    expect(code.closes()).toBe(1);
    // Idempotent close: drivers are not released a second time.
    await daemon.close();
    expect(code.closes()).toBe(1);
  });

  test("backoff ceilings double from 250 ms and stay capped at 30 s", async () => {
    const { host, clock, daemon } = await reconnectFixture();
    try {
      expect(daemon.attachment.status).toBe("attached");
      let scheduled = clock.nextScheduled();
      await host.close(); // endpoint stays gone: every attempt fails
      const delays: number[] = [];
      for (let attempt = 0; attempt < 9; attempt += 1) {
        const entry = await within(scheduled, `schedule ${attempt}`);
        delays.push(entry.delay);
        scheduled = clock.nextScheduled();
        entry.task();
      }
      expect(delays).toEqual([250, 500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    } finally {
      await daemon.close();
    }
  });
});
