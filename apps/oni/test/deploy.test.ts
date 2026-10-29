import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core } from "@oni/agent";
import { Machine } from "@oni/protocol";
import { type DeployClient, type DeployPorts, deployCommand, EXIT_SLACK_MS, runDeploy } from "../src/cli/deploy";
import { requestSupervisor, serveSupervisor } from "../src/cli/supervise";
import type { DrainAnswer, HostStatus, SuperviseAnswer, SuperviseRequest } from "../src/cli/supervise-wire";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "oni-deploy-"));
  dirs.push(dir);
  return dir;
}

const live: HostStatus = { version: "0.1.0", instanceId: "01PREVIOUS0000000000000000", contractVersion: Machine.contractVersion, capabilities: { drainRestart: true }, state: "open" };
const fresh: HostStatus = { ...live, version: "0.2.0", instanceId: "01CANDIDATE000000000000000" };
const target = { artifact: "/releases/oni-0.2.0", targetVersion: "0.2.0", graceMs: 5_000 };

interface Scenario {
  readonly version?: string;
  readonly drain?: DrainAnswer;
  readonly exited?: boolean;
  readonly candidate?: HostStatus;
  readonly snapshotDir?: string;
  readonly foreignWriter?: boolean;
}

function harness(scenario: Scenario = {}) {
  const root = scratch();
  const storage = { catalogPath: join(root, "catalog.sqlite"), sessionsDir: join(root, "sessions"), snapshotDir: scenario.snapshotDir ?? join(root, "snapshot") };
  writeFileSync(storage.catalogPath, "before");
  mkdirSync(storage.sessionsDir);
  writeFileSync(join(storage.sessionsDir, "s1.sqlite"), "session-before");
  const calls: string[] = [];
  let current: string | undefined = "/releases/oni-0.1.0";
  let starts = 0;
  const ports: DeployPorts = {
    storage,
    installedVersion: async (artifact) => {
      calls.push(`version ${artifact}`);
      return scenario.version ?? "0.2.0";
    },
    status: async () => live,
    drain: async (request) => {
      calls.push(`drain ${request.expectedInstanceId} ${request.targetVersion} ${request.graceMs}`);
      return scenario.drain ?? { drained: true, inFlight: 0, projectionsIdle: true };
    },
    childExited: async (withinMs) => {
      calls.push(`exit ${withinMs}`);
      return scenario.exited ?? true;
    },
    current: () => current,
    point: (release) => {
      calls.push(`point ${release}`);
      current = release;
    },
    startChild: () => {
      starts += 1;
      calls.push(`start ${current}`);
      if (current !== target.artifact) return "oni:previous";
      Core.acquireOwnerLock(storage.catalogPath, "oni:candidate").release();
      if (scenario.foreignWriter) Core.acquireOwnerLock(storage.catalogPath, "oni:stranger").release();
      writeFileSync(storage.catalogPath, "candidate");
      writeFileSync(join(storage.sessionsDir, "s1.sqlite"), "session-candidate");
      return "oni:candidate";
    },
    stopChild: async () => {
      calls.push("stop");
    },
    candidateStatus: async (previous) => {
      calls.push(`candidate-status ${previous}`);
      return scenario.candidate;
    },
  };
  return { ports, storage, calls, starts: () => starts };
}

const catalog = (storage: { readonly catalogPath: string }) => readFileSync(storage.catalogPath, "utf8");
const session = (storage: { readonly sessionsDir: string }) => readFileSync(join(storage.sessionsDir, "s1.sqlite"), "utf8");

describe("runDeploy boundaries", () => {
  test("before drain: a staged version that does not match refuses and the live host is untouched", async () => {
    const { ports, calls } = harness({ version: "0.1.9" });
    expect(await runDeploy(target, ports)).toEqual({ ok: false, class: "version_mismatch", step: "version" });
    expect(calls).toEqual([`version ${target.artifact}`]);
  });

  test("a refused drain and an unconfirmed drain stop before exit", async () => {
    const mismatch = harness({ drain: { ok: false, class: "instance_mismatch" } });
    expect(await runDeploy(target, mismatch.ports)).toEqual({ ok: false, class: "drain_refused", step: "drain" });
    expect(mismatch.calls.at(-1)).toBe(`drain ${live.instanceId} 0.2.0 5000`);
    const timeout = harness({ drain: { drained: false, inFlight: 1, projectionsIdle: true } });
    expect(await runDeploy(target, timeout.ports)).toEqual({ ok: false, class: "drain_timeout", step: "drain" });
    expect(timeout.starts()).toBe(0);
  });

  test("a host that does not exit within grace + 30 s is stopped and the previous release restarted", async () => {
    const { ports, calls, storage } = harness({ exited: false });
    expect(await runDeploy(target, ports)).toEqual({ ok: false, class: "exit_timeout", step: "exit" });
    expect(calls.slice(-3)).toEqual([`exit ${5_000 + EXIT_SLACK_MS}`, "stop", "start /releases/oni-0.1.0"]);
    expect(existsSync(storage.snapshotDir)).toBe(false);
  });

  test("after exit: a held owner lock refuses the snapshot and the previous release restarts on unchanged files", async () => {
    const { ports, calls, storage } = harness();
    const held = Core.acquireOwnerLock(storage.catalogPath, "oni:straggler");
    try {
      expect(await runDeploy(target, ports)).toEqual({ ok: false, class: "lock_held", step: "snapshot" });
    } finally {
      held.release();
    }
    expect(calls.at(-1)).toBe("start /releases/oni-0.1.0");
    expect(catalog(storage)).toBe("before");
  });

  test("an unwritable snapshot directory refuses snapshot_failed and restarts the previous release", async () => {
    const root = scratch();
    writeFileSync(join(root, "file"), "");
    const { ports, calls } = harness({ snapshotDir: join(root, "file", "snapshot") });
    expect(await runDeploy(target, ports)).toEqual({ ok: false, class: "snapshot_failed", step: "snapshot" });
    expect(calls.at(-1)).toBe("start /releases/oni-0.1.0");
  });

  test("a verified candidate keeps the new release and its writes; the snapshot holds the pre-swap files", async () => {
    const { ports, calls, storage } = harness({ candidate: fresh });
    expect(await runDeploy(target, ports)).toEqual({ ok: true, instanceId: fresh.instanceId });
    expect(calls.slice(-3)).toEqual([`point ${target.artifact}`, `start ${target.artifact}`, `candidate-status ${live.instanceId}`]);
    expect(catalog(storage)).toBe("candidate");
    expect(readFileSync(join(storage.snapshotDir, "catalog.sqlite"), "utf8")).toBe("before");
    expect(readFileSync(join(storage.snapshotDir, "sessions", "s1.sqlite"), "utf8")).toBe("session-before");
    Core.acquireOwnerLock(storage.catalogPath, "oni:after").release();
  });

  test("after candidate start: a candidate with no status is stopped, the snapshot restored and the previous release restarted", async () => {
    const { ports, calls, storage } = harness();
    Core.acquireOwnerLock(storage.catalogPath, "oni:previous").release();
    expect(await runDeploy(target, ports)).toEqual({ ok: false, class: "candidate_failed", step: "start" });
    expect(calls.slice(-4)).toEqual([`candidate-status ${live.instanceId}`, "stop", "point /releases/oni-0.1.0", "start /releases/oni-0.1.0"]);
    expect(catalog(storage)).toBe("before");
    expect(session(storage)).toBe("session-before");
  });

  test("a candidate reporting the wrong version, the old instance or a draining state fails verification and restores", async () => {
    for (const candidate of [{ ...fresh, version: "0.1.0" }, { ...fresh, instanceId: live.instanceId }, { ...fresh, state: "draining" as const }, { ...fresh, contractVersion: Machine.contractVersion + 1 }]) {
      const { ports, storage } = harness({ candidate });
      expect(await runDeploy(target, ports)).toEqual({ ok: false, class: "verify_failed", step: "verify" });
      expect(catalog(storage)).toBe("before");
    }
  });

  test("a foreign writer since the snapshot refuses the restore and leaves the files as they are", async () => {
    const { ports, storage, calls } = harness({ foreignWriter: true });
    expect(await runDeploy(target, ports)).toEqual({ ok: false, class: "restore_refused", step: "restore" });
    expect(catalog(storage)).toBe("candidate");
    expect(calls.at(-1)).toBe("start /releases/oni-0.1.0");
  });

  test("a restore whose lock is held refuses restore_refused", async () => {
    const { ports, storage } = harness();
    const stopChild = ports.stopChild;
    let held: Core.OwnerLock | undefined;
    const answer = await runDeploy(target, {
      ...ports,
      stopChild: async () => {
        await stopChild();
        held = Core.acquireOwnerLock(storage.catalogPath, "oni:candidate");
      },
    });
    held?.release();
    expect(answer).toEqual({ ok: false, class: "restore_refused", step: "restore" });
    expect(catalog(storage)).toBe("candidate");
  });
});

describe("runDeploy fencing, faults and cancellation", () => {
  test("an owner that enters after the snapshot lock is released refuses the restore", async () => {
    const { ports, storage } = harness();
    const answer = await runDeploy(target, {
      ...ports,
      current: () => {
        Core.acquireOwnerLock(storage.catalogPath, "oni:after-snapshot").release();
        return ports.current();
      },
    });
    expect(answer).toEqual({ ok: false, class: "restore_refused", step: "restore" });
    expect(catalog(storage)).toBe("candidate");
  });

  test("a link write that throws before the candidate spawns restores and restarts the previous release", async () => {
    const { ports, calls, storage } = harness();
    let points = 0;
    const answer = await runDeploy(target, {
      ...ports,
      point: (release) => {
        points += 1;
        if (points === 1) throw new Error("POINT_IO");
        ports.point(release);
      },
    });
    expect(answer).toEqual({ ok: false, class: "io_failed", step: "start" });
    expect(calls.slice(-3)).toEqual(["stop", "point /releases/oni-0.1.0", "start /releases/oni-0.1.0"]);
    expect(catalog(storage)).toBe("before");
  });

  test("a candidate spawn that throws leaves the previous link, files and host restored", async () => {
    const { ports, calls, storage } = harness();
    const answer = await runDeploy(target, {
      ...ports,
      startChild: () => {
        if (ports.current() === target.artifact) {
          writeFileSync(storage.catalogPath, "half-written");
          throw new Error("SPAWN_IO");
        }
        return ports.startChild();
      },
    });
    expect(answer).toEqual({ ok: false, class: "io_failed", step: "start" });
    expect(calls.at(-1)).toBe("start /releases/oni-0.1.0");
    expect(catalog(storage)).toBe("before");
  });

  test("a previous link read that throws restarts the unchanged host", async () => {
    const { ports, calls } = harness();
    const answer = await runDeploy(target, { ...ports, current: () => { throw new Error("READ_IO"); } });
    expect(answer).toEqual({ ok: false, class: "io_failed", step: "snapshot" });
    expect(calls.at(-1)).toBe("start /releases/oni-0.1.0");
  });

  test("recovery that throws answers recovery_failed instead of rejecting", async () => {
    const stopFails = harness();
    expect(await runDeploy(target, { ...stopFails.ports, stopChild: () => Promise.reject(new Error("STOP_IO")) })).toEqual({ ok: false, class: "recovery_failed", step: "restore" });
    const restartFails = harness({ exited: false });
    expect(await runDeploy(target, { ...restartFails.ports, startChild: () => { throw new Error("SPAWN_IO"); } })).toEqual({ ok: false, class: "recovery_failed", step: "exit" });
    const blocked = scratch();
    writeFileSync(join(blocked, "file"), "");
    const snapshotRestart = harness({ snapshotDir: join(blocked, "file", "snapshot") });
    expect(await runDeploy(target, { ...snapshotRestart.ports, startChild: () => { throw new Error("SPAWN_IO"); } })).toEqual({ ok: false, class: "recovery_failed", step: "snapshot" });
    const verifyRestart = harness();
    const answer = await runDeploy(target, {
      ...verifyRestart.ports,
      startChild: () => {
        if (verifyRestart.ports.current() !== target.artifact) throw new Error("SPAWN_IO");
        return verifyRestart.ports.startChild();
      },
    });
    expect(answer).toEqual({ ok: false, class: "recovery_failed", step: "restore" });
    expect(catalog(verifyRestart.storage)).toBe("before");
  });

  test("probes that reject are typed refusals", async () => {
    const version = harness();
    expect(await runDeploy(target, { ...version.ports, installedVersion: () => Promise.reject(new Error("x")) })).toEqual({ ok: false, class: "version_mismatch", step: "version" });
    const status = harness();
    expect(await runDeploy(target, { ...status.ports, status: () => Promise.reject(new Error("x")) })).toEqual({ ok: false, class: "drain_refused", step: "drain" });
  });

  test("cancellation at each boundary stops further mutation and spawns", async () => {
    const before = new AbortController();
    before.abort();
    const early = harness();
    expect(await runDeploy(target, early.ports, before.signal)).toEqual({ ok: false, class: "cancelled", step: "version" });
    expect(early.calls).toEqual([`version ${target.artifact}`]);
    for (const step of ["status", "drain"] as const) {
      const stop = new AbortController();
      const { ports, starts } = harness();
      const answer = await runDeploy(target, {
        ...ports,
        [step]: async () => {
          stop.abort();
          return step === "status" ? live : { drained: true, inFlight: 0, projectionsIdle: true };
        },
      }, stop.signal);
      expect(answer).toEqual({ ok: false, class: "cancelled", step: "drain" });
      expect(starts()).toBe(0);
    }
    const atExit = new AbortController();
    const exit = harness({ exited: false });
    expect(await runDeploy(target, { ...exit.ports, stopChild: async () => { atExit.abort(); } }, atExit.signal)).toEqual({ ok: false, class: "cancelled", step: "exit" });
    expect(exit.starts()).toBe(0);
    const atSnapshot = new AbortController();
    const snap = harness();
    expect(await runDeploy(target, { ...snap.ports, childExited: async () => { atSnapshot.abort(); return true; } }, atSnapshot.signal)).toEqual({ ok: false, class: "cancelled", step: "snapshot" });
    expect(snap.starts()).toBe(0);
    const afterSnapshot = new AbortController();
    const copied = harness();
    const copiedAnswer = await runDeploy(target, {
      ...copied.ports,
      current: () => {
        afterSnapshot.abort();
        return copied.ports.current();
      },
    }, afterSnapshot.signal);
    expect(copiedAnswer).toEqual({ ok: false, class: "cancelled", step: "snapshot" });
    expect(copied.starts()).toBe(0);
    expect(copied.ports.current()).toBe("/releases/oni-0.1.0");
  });

  test("cancellation while the candidate is verified stops it, restores the files and starts nothing", async () => {
    const stop = new AbortController();
    const { ports, calls, storage } = harness();
    const answer = await runDeploy(target, {
      ...ports,
      candidateStatus: async () => {
        stop.abort();
        return fresh;
      },
    }, stop.signal);
    expect(answer).toEqual({ ok: false, class: "cancelled", step: "verify" });
    expect(calls.slice(-2)).toEqual(["stop", "point /releases/oni-0.1.0"]);
    expect(catalog(storage)).toBe("before");
  });
});

function client(overrides: Partial<DeployClient> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: SuperviseRequest[] = [];
  const staged: string[] = [];
  const deploy: DeployClient = {
    supervisorReachable: () => true,
    stage: async (tgz) => {
      staged.push(tgz);
      return { artifact: "/releases/oni-0.2.0", version: "0.2.0" };
    },
    token: () => "secret",
    send: async (request) => {
      sent.push(request);
      return { ok: true, instanceId: fresh.instanceId };
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    ...overrides,
  };
  return { deploy, out, err, sent, staged };
}

describe("oni deploy client", () => {
  test("a tgz stages and sends the deploy line with its version, grace and token", async () => {
    const { deploy, out, sent, staged } = client();
    expect(await deployCommand(["oni.tgz", "--grace-ms", "1000"], deploy)).toBe(0);
    expect(staged).toEqual(["oni.tgz"]);
    expect(sent).toEqual([{ op: "deploy", artifact: "/releases/oni-0.2.0", targetVersion: "0.2.0", graceMs: 1000, token: "secret" }]);
    expect(out).toEqual([JSON.stringify({ ok: true, instanceId: fresh.instanceId })]);
  });

  test("--reload sends the reload line and nothing is staged", async () => {
    const { deploy, sent, staged } = client();
    expect(await deployCommand(["--reload"], deploy)).toBe(0);
    expect(sent).toEqual([{ op: "reload" }]);
    expect(staged).toEqual([]);
  });

  test("bad arguments print usage", async () => {
    for (const args of [[], ["--grace-ms", "5"], ["oni.tgz", "--grace-ms", "300001"], ["oni.tgz", "--grace", "5"], ["oni.tgz", "--grace-ms"]]) {
      const { deploy, err, sent } = client();
      expect(await deployCommand(args, deploy)).toBe(1);
      expect(err[0]).toStartWith("usage: oni deploy");
      expect(sent).toEqual([]);
    }
  });

  test("typed refusals: no token, an unreadable staged version, a refused deploy", async () => {
    const noToken = client({ token: () => undefined });
    expect(await deployCommand(["oni.tgz"], noToken.deploy)).toBe(1);
    expect(noToken.err).toEqual([JSON.stringify({ ok: false, class: "unauthenticated", step: "request" })]);
    expect(noToken.staged).toEqual([]);
    const unreadable = client({ stage: async () => ({ artifact: "/releases/broken", version: undefined }) });
    expect(await deployCommand(["oni.tgz"], unreadable.deploy)).toBe(1);
    expect(unreadable.err).toEqual([JSON.stringify({ ok: false, class: "no_staged_artifact", step: "version" })]);
    const refusedAnswer: SuperviseAnswer = { ok: false, class: "drain_timeout", step: "drain" };
    const refused = client({ send: async () => refusedAnswer });
    expect(await deployCommand(["oni.tgz"], refused.deploy)).toBe(1);
    expect(refused.err).toEqual([JSON.stringify(refusedAnswer)]);
  });
});

describe("supervisor socket", () => {
  async function rawLine(sockPath: string, line: string): Promise<string> {
    const { promise, resolve } = Promise.withResolvers<string>();
    let received = "";
    await Bun.connect({
      unix: sockPath,
      socket: {
        open: (socket) => {
          socket.write(line);
        },
        data: (_socket, data) => {
          received += data.toString("utf8");
        },
        close: () => resolve(received),
      },
    });
    return promise;
  }

  test("one answer per line: authentication, invalid lines, deploy_in_progress and a 0600 socket", async () => {
    const sockPath = join(scratch(), "s.sock");
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const handled: SuperviseRequest[] = [];
    const server = serveSupervisor({
      sockPath,
      token: "secret",
      handle: async (request) => {
        handled.push(request);
        entered.resolve();
        await release.promise;
        return { ok: true, instanceId: fresh.instanceId };
      },
    });
    try {
      expect(statSync(sockPath).mode & 0o777).toBe(0o600);
      const deploy = { op: "deploy" as const, artifact: "/r", targetVersion: "0.2.0", graceMs: 0 };
      expect(await requestSupervisor(sockPath, { ...deploy, token: "wrong" })).toEqual({ ok: false, class: "unauthenticated", step: "request" });
      expect(await rawLine(sockPath, "{not json\n")).toBe(`${JSON.stringify({ ok: false, class: "invalid_request", step: "request" })}\n`);
      expect(await rawLine(sockPath, `${JSON.stringify({ op: "reload", extra: 1 })}\n`)).toBe(`${JSON.stringify({ ok: false, class: "invalid_request", step: "request" })}\n`);
      const first = requestSupervisor(sockPath, { ...deploy, token: "secret" });
      await entered.promise;
      expect(await requestSupervisor(sockPath, { op: "reload" })).toEqual({ ok: false, class: "deploy_in_progress", step: "request" });
      release.resolve();
      expect(await first).toEqual({ ok: true, instanceId: fresh.instanceId });
      expect(handled).toEqual([{ ...deploy, token: "secret" }]);
    } finally {
      server.stop();
    }
  });

  test("a missing socket answers supervisor_unavailable", async () => {
    expect(await requestSupervisor(join(scratch(), "absent.sock"), { op: "reload" })).toEqual({ ok: false, class: "supervisor_unavailable", step: "request" });
  });
});
