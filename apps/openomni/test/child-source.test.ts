import { expect, test } from "bun:test";
import { MachineRefusalError } from "@openomni/machines";
import { childSource, createWatchSources, type ChildSourcePorts } from "../src/composition/watch-sources";
import { type ChildRow, currentState, stateReceipts } from "../src/bundles/child-activity/reconcile";
import { fixture, fixtures, identity, spec } from "./helpers/child-activity";

function sourceFixture() {
  const files = new Map<string, Buffer>();
  const rows: ChildRow[] = [];
  const errors: Error[] = [];
  const reads: { readonly path: string; readonly offset: number }[] = [];
  const ports: ChildSourcePorts = {
    machines: {
      get: () => ({
        fs: {
          stat: async (path) => {
            const bytes = files.get(path);
            if (bytes === undefined) throw new MachineRefusalError({ reason: "not_found", message: "file absent" });
            return { op: "stat", kind: "file", size: bytes.length, mtimeMs: 1 };
          },
          read: async (path, window) => {
            const bytes = files.get(path);
            if (bytes === undefined) throw new MachineRefusalError({ reason: "not_found", message: "file absent" });
            const offset = window?.offset ?? 0;
            const data = bytes.subarray(offset, offset + (window?.limit ?? bytes.length));
            reads.push({ path, offset });
            return { op: "read", data, bytesRead: data.length, size: bytes.length, truncated: offset + data.length < bytes.length };
          },
        },
      }),
    },
    rows: () => rows,
    admit: async (_sessionId, admitted) => {
      rows.push(...admitted);
      return admitted;
    },
  };
  const options = { clock: () => 200, failure: (error: Error) => { errors.push(error); } };
  const write = (source: "spool" | "transcript", text: string) => {
    const location = spec[source];
    if (location === undefined) throw new Error("fixture source missing");
    files.set(location.path, Buffer.from(text));
  };
  return { ports, options, rows, errors, reads, write };
}

test("one remote source drains both files, resumes persisted ranges, and reads late appends", async () => {
  const fx = sourceFixture();
  const hook = `${fixture("live", "requested")}\n`;
  const transcript = `${fixture("transcript", "requested")}\n`;
  fx.write("spool", hook);
  fx.write("transcript", transcript);
  const source = childSource(spec, fx.ports, fx.options);
  await source.ready;
  expect(fx.rows.map((row) => row.kind)).toEqual(["child_fact", "child_receipt", "child_receipt"]);
  await source.observe();
  expect(fx.rows).toHaveLength(3);
  await source.close();
  const resumed = childSource(spec, fx.ports, fx.options);
  await resumed.ready;
  expect(fx.rows).toHaveLength(3);
  fx.write("transcript", `${transcript}${fixture("transcript", "terminal")}\n`);
  await resumed.observe();
  expect(fx.reads.some((read) => read.path === spec.transcript?.path && read.offset === Buffer.byteLength(transcript))).toBe(true);
  expect(fx.rows.filter((row) => row.kind === "child_fact").map((row) => row.content)).toContainEqual({ ...identity, phase: "terminal" });
  expect(fx.errors).toEqual([]);
  await resumed.close();
  await resumed.observe();
});

test("missing files remain observable and a generation replacement reads from zero", async () => {
  const fx = sourceFixture();
  const source = childSource(spec, fx.ports, fx.options);
  await source.ready;
  expect(fx.rows).toEqual([]);
  fx.write("spool", "");
  fx.write("transcript", `${fixture("transcript", "requested")}\npartial`);
  await source.observe();
  fx.write("spool", `${fixtures.live.map((entry) => entry.line).join("\n")}\n`);
  fx.write("transcript", `${fixture("transcript", "terminal")}\n`);
  await source.observe();
  expect(fx.rows.some((row) => row.kind === "child_diagnostic" && row.content.diagnostic.code === "generation_changed")).toBe(true);
  expect(currentState(stateReceipts(fx.rows, identity.child, identity.turn))?.fact.phase).toBe("terminal");
  await source.close();
});

test("failed admission retains the cursor so the next observation retries the bytes", async () => {
  const fx = sourceFixture();
  const source = childSource(spec, fx.ports, fx.options);
  await source.ready;
  fx.write("spool", `${fixture("live", "requested")}\n`);
  const error = new Error("receiver unavailable");
  const admit = fx.ports.admit;
  let refused = true;
  const flaky = {
    ...fx.ports,
    admit: (...input: Parameters<typeof admit>) => {
      if (refused) {
        refused = false;
        return Promise.reject(error);
      }
      return admit(...input);
    },
  };
  await source.close();
  const retrying = childSource(spec, flaky, fx.options);
  await expect(retrying.ready).rejects.toBe(error);
  await retrying.observe();
  await retrying.observe();
  expect(fx.rows).toHaveLength(2);
  expect(fx.errors).toContain(error);
  await retrying.close();
});

test("the existing watch owner installs, observes, and closes the child adapter", async () => {
  const fx = sourceFixture();
  fx.write("spool", `${fixture("live", "requested")}\n`);
  const retired: string[] = [];
  const sources = createWatchSources({ deliver: async () => undefined }, {
    ...fx.options, failure: (_id, error) => fx.options.failure(error),
    children: fx.ports, retirePath: async (_sessionId, id) => { retired.push(id); },
  });
  if (sources.installChild === undefined) throw new Error("child installer missing");
  await sources.installChild(spec);
  await sources.installChild(spec);
  await expect(sources.installChild({ ...spec, turn: "another-turn" })).rejects.toThrow("watch_conflict");
  await expect(sources.installChild({ ...spec, id: "second-watch" })).rejects.toThrow("watch_conflict");
  expect(sources.observe("different-parent", spec.id)).toBe(false);
  expect(sources.observe(spec.sessionId, spec.id)).toBe(true);
  await sources.close(spec.id);
  expect(retired).toEqual([spec.id]);
  await sources.closeAll();
  await expect(sources.installChild(spec)).rejects.toMatchObject({ reason: "shutdown" });
});

test("unsupported occupants and absent source ports fail explicitly", async () => {
  const fx = sourceFixture();
  expect(() => childSource({ ...spec, occupant: { command: "unregistered-process" } }, fx.ports, fx.options)).toThrow("pack_missing");
  const { spool: _spool, transcript: _transcript, ...empty } = spec;
  expect(() => childSource(empty, fx.ports, fx.options)).toThrow("source_missing");
  const sources = createWatchSources({ deliver: async () => undefined }, {
    ...fx.options, failure: (_id, error) => fx.options.failure(error),
  });
  await expect(sources.installChild?.(spec)).rejects.toThrow("source_missing");
  await sources.closeAll();
});

test("remote source refuses non-files, failed transport, and reads that make no progress", async () => {
  const fx = sourceFixture();
  const fs = fx.ports.machines.get("self").fs;
  for (const code of ["not_file", "read_stalled", "disconnected"] as const) {
    const ports: ChildSourcePorts = {
      ...fx.ports,
      machines: {
        get: () => ({
          fs: {
            ...fs,
            stat: async () => {
              if (code === "disconnected") throw new MachineRefusalError({ reason: code, message: code });
              return { op: "stat", kind: code === "not_file" ? "dir" : "file", size: 10, mtimeMs: 1 };
            },
            read: async () => ({ op: "read", data: new Uint8Array(), bytesRead: 0, size: 10, truncated: true }),
          },
        }),
      },
    };
    const source = childSource(spec, ports, fx.options);
    await expect(source.ready).rejects.toThrow(code);
    await expect(source.close()).rejects.toThrow(code);
  }
});

test("a long append drains bounded reads and a changed prefix after growth restarts generation", async () => {
  const fx = sourceFixture();
  const line = `${fixture("transcript", "requested")}\n`;
  fx.write("transcript", line);
  const { spool: _spool, ...backfill } = spec;
  const source = childSource(backfill, fx.ports, fx.options);
  await source.ready;
  fx.write("transcript", line.repeat(1100));
  await source.observe();
  expect(fx.rows.filter((row) => row.kind === "child_receipt")).toHaveLength(1100);
  fx.write("transcript", `${fixture("transcript", "terminal")}\n${line.repeat(1100)}`);
  await source.observe();
  expect(fx.rows.some((row) => row.kind === "child_diagnostic" && row.content.diagnostic.code === "generation_changed")).toBe(true);
  await source.close();
});

test("restoration does not wait on entity admission and shutdown joins an in-flight child close", async () => {
  const fx = sourceFixture();
  fx.write("spool", `${fixture("live", "requested")}\n`);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const ports: ChildSourcePorts = {
    ...fx.ports,
    admit: async (...input) => {
      entered.resolve();
      await release.promise;
      return fx.ports.admit(...input);
    },
  };
  const sources = createWatchSources({ deliver: async () => undefined }, {
    clock: fx.options.clock, children: ports,
    failure: (_id, error) => fx.options.failure(error),
  });
  sources.restoreChild?.(spec);
  await entered.promise;
  let closed = false;
  const closing = sources.close(spec.id).then(() => { closed = true; });
  const shutdown = sources.closeAll();
  expect(closed).toBe(false);
  release.resolve();
  await shutdown;
  expect(closed).toBe(true);
  await closing;
});

test("failed source restoration reports the original error and removes its handle", async () => {
  const fx = sourceFixture();
  const error = new Error("attachment unavailable");
  const reported = Promise.withResolvers<Error>();
  const fs = fx.ports.machines.get("self").fs;
  const sources = createWatchSources({ deliver: async () => undefined }, {
    clock: fx.options.clock,
    children: { ...fx.ports, machines: { get: () => ({ fs: { ...fs, stat: () => Promise.reject(error) } }) } },
    failure: (_id, failure) => reported.resolve(failure),
  });
  sources.restoreChild?.(spec);
  expect(await reported.promise).toBe(error);
  expect(sources.observe(spec.sessionId, spec.id)).toBe(false);
  await sources.closeAll();
});

test("native and child sources cannot take the same watch identity", async () => {
  const fx = sourceFixture();
  let nativeClosed = false;
  const sources = createWatchSources({ deliver: async () => undefined }, {
    clock: fx.options.clock, children: fx.ports,
    failure: (_id, error) => fx.options.failure(error),
    pathWatch: () => ({ on: () => undefined, close: () => { nativeClosed = true; } }),
  });
  await sources.install({
    sessionId: spec.sessionId, id: spec.id,
    occurrence: { alarmId: spec.id, occurrenceId: "native-occurrence", armSeq: 1 },
    base: {
      notifications: 0,
      spec: {
        watch: { path: "/absent-child-source-fixture", event: "create", description: "native path", persistent: true },
        policyGeneration: 1, notificationLimit: 8,
      },
    },
  });
  await expect(sources.installChild?.(spec)).rejects.toThrow("watch_conflict");
  await sources.closeAll();
  expect(nativeClosed).toBe(true);
});
