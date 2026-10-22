import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileGenerationStore, createMemoryGenerationStore } from "../src";
import { run } from "./ipc/helpers/effects";

function fixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), "machine-generations-"));
  const path = join(directory, "state", "generations.json");
  return {
    directory, path, store: createFileGenerationStore({ path }),
    close: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test.each(["memory", "file"] as const)("%s store compares current values and retains independent machine generations", async (kind) => {
  const f = fixture();
  const store = kind === "memory" ? createMemoryGenerationStore() : f.store;
  try {
    expect(await run(store.current("worker"))).toBeUndefined();
    expect(await run(store.compareAndSet("worker", 1, 2))).toBe(false);
    expect(await run(store.compareAndSet("worker", undefined, 1))).toBe(true);
    expect(await run(store.compareAndSet("worker", undefined, 9))).toBe(false);
    expect(await run(store.compareAndSet("worker", 1, 2))).toBe(true);
    expect(await run(store.compareAndSet("other", undefined, 7))).toBe(true);
    expect(await run(store.current("worker"))).toBe(2);
    expect(await run(store.current("other"))).toBe(7);
  } finally { f.close(); }
});

test("file generations survive new store instances with no temporary file after publication", async () => {
  const f = fixture();
  try {
    await run(f.store.compareAndSet("worker", undefined, 1));
    const reopened = createFileGenerationStore({ path: f.path });
    expect(await run(reopened.current("worker"))).toBe(1);
    expect(await run(reopened.compareAndSet("worker", 1, 2))).toBe(true);
    expect(await run(f.store.current("worker"))).toBe(2);
    expect(fs.readdirSync(join(f.directory, "state"))).toEqual(["generations.json"]);
    expect(fs.statSync(f.path).mode & 0o777).toBe(0o600);
  } finally { f.close(); }
});

test.each(["{", "[]", '{"worker":0}', '{"worker":"1"}'])("invalid generation file fails closed for reads and CAS: %s", async (text) => {
  const f = fixture();
  try {
    fs.mkdirSync(join(f.directory, "state"));
    fs.writeFileSync(f.path, text);
    await expect(run(f.store.current("worker"))).rejects.toMatchObject({ _tag: "MachinesFailure", operation: "generation.read" });
    await expect(run(f.store.compareAndSet("worker", undefined, 1))).rejects.toMatchObject({ _tag: "MachinesFailure", operation: "generation.compareAndSet" });
    expect(fs.readFileSync(f.path, "utf8")).toBe(text);
    expect(fs.readdirSync(join(f.directory, "state"))).toEqual(["generations.json"]);
  } finally { f.close(); }
});

test("a competing file writer loses CAS without altering the current generation", async () => {
  const f = fixture();
  try {
    const other = createFileGenerationStore({ path: f.path });
    expect(await Promise.all([
      run(f.store.compareAndSet("worker", undefined, 1)),
      run(other.compareAndSet("worker", undefined, 2)),
    ])).toEqual([true, false]);
    fs.mkdirSync(`${f.path}.lock`);
    fs.writeFileSync(`${f.path}.lock/pid`, String(process.pid));
    expect(await run(other.compareAndSet("worker", 1, 2))).toBe(false);
    expect(await run(f.store.current("worker"))).toBe(1);
    expect(fs.readFileSync(`${f.path}.lock/pid`, "utf8")).toBe(String(process.pid));
  } finally { f.close(); }
});

test("an unreadable generation path fails closed instead of treating it as missing", async () => {
  const f = fixture();
  try {
    fs.mkdirSync(f.path, { recursive: true });
    await expect(run(f.store.current("worker"))).rejects.toMatchObject({ _tag: "MachinesFailure", operation: "generation.read" });
    await expect(run(f.store.compareAndSet("worker", undefined, 1))).rejects.toMatchObject({ _tag: "MachinesFailure", operation: "generation.compareAndSet" });
  } finally { f.close(); }
});

test("a lock without a readable owner fails closed rather than overwriting its owner", async () => {
  const f = fixture();
  try {
    fs.mkdirSync(join(f.directory, "state"), { recursive: true });
    fs.mkdirSync(`${f.path}.lock`);
    await expect(run(f.store.compareAndSet("worker", undefined, 1))).rejects.toMatchObject({
      _tag: "MachinesFailure", operation: "generation.compareAndSet",
    });
  } finally { f.close(); }
});

test.each(["writeFileSync", "renameSync"] as const)("a failed %s preserves the prior generation and removes the temporary file", async (method) => {
  const f = fixture();
  try {
    await run(f.store.compareAndSet("worker", undefined, 1));
    const fault = spyOn(fs, method).mockImplementationOnce(() => { throw new Error("publication failed"); });
    try {
      await expect(run(f.store.compareAndSet("worker", 1, 2))).rejects.toMatchObject({
        _tag: "MachinesFailure", operation: "generation.compareAndSet", cause: "Error: publication failed",
      });
    } finally { fault.mockRestore(); }
    expect(await run(f.store.current("worker"))).toBe(1);
    expect(fs.readdirSync(join(f.directory, "state"))).toEqual(["generations.json"]);
  } finally { f.close(); }
});

test("post-rename lock cleanup EIO preserves committed CAS and releases the next writer", async () => {
  const f = fixture();
  try {
    expect(await run(f.store.compareAndSet("worker", undefined, 1))).toBe(true);
    const fault = spyOn(fs, "rmdirSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("cleanup failed"), { code: "EIO" });
    });
    try {
      expect(await run(f.store.compareAndSet("worker", 1, 2))).toBe(true);
    } finally { fault.mockRestore(); }
    expect(await run(f.store.current("worker"))).toBe(2);
    expect(await run(createFileGenerationStore({ path: f.path }).compareAndSet("worker", 2, 3))).toBe(true);
    expect(await run(f.store.current("worker"))).toBe(3);
  } finally { f.close(); }
});

test("an abandoned lock from a dead owner is recovered after interrupted publication", async () => {
  const f = fixture();
  try {
    expect(await run(f.store.compareAndSet("worker", undefined, 1))).toBe(true);
    const exited = Bun.spawn(["/bin/sh", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore" });
    expect(await exited.exited).toBe(0);
    fs.mkdirSync(`${f.path}.lock`);
    fs.writeFileSync(`${f.path}.lock/pid`, String(exited.pid));
    fs.writeFileSync(`${f.path}.tmp`, "{");
    expect(await run(createFileGenerationStore({ path: f.path }).current("worker"))).toBe(1);
    expect(await run(createFileGenerationStore({ path: f.path }).compareAndSet("worker", 1, 2))).toBe(true);
    expect(await run(f.store.current("worker"))).toBe(2);
    expect(fs.readdirSync(join(f.directory, "state"))).toEqual(["generations.json"]);
  } finally { f.close(); }
});

test("a partial temporary write fails before publication without changing complete JSON", async () => {
  const f = fixture();
  try {
    expect(await run(f.store.compareAndSet("worker", undefined, 1))).toBe(true);
    const write = fs.writeFileSync;
    const fault = spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
      if (target === `${f.path}.tmp`) {
        fs.appendFileSync(target, "{");
        throw new Error("partial write");
      }
      write(target, data, options);
    });
    try {
      await expect(run(f.store.compareAndSet("worker", 1, 2))).rejects.toMatchObject({
        _tag: "MachinesFailure", operation: "generation.compareAndSet", cause: "Error: partial write",
      });
    } finally { fault.mockRestore(); }
    expect(await run(f.store.current("worker"))).toBe(1);
    expect(fs.readFileSync(f.path, "utf8")).toBe('{"worker":1}');
    expect(fs.readdirSync(join(f.directory, "state"))).toEqual(["generations.json"]);
  } finally { f.close(); }
});

test("a cleanup error before publication is typed without changing the complete generation", async () => {
  const f = fixture();
  try {
    expect(await run(f.store.compareAndSet("worker", undefined, 1))).toBe(true);
    const fault = spyOn(fs, "rmdirSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("release failed"), { code: "EIO" });
    });
    try {
      await expect(run(f.store.compareAndSet("worker", undefined, 2))).rejects.toMatchObject({
        _tag: "MachinesFailure", operation: "generation.compareAndSet", cause: "Error: release failed",
      });
    } finally { fault.mockRestore(); }
    expect(await run(f.store.current("worker"))).toBe(1);
    expect(await run(f.store.compareAndSet("worker", 1, 2))).toBe(true);
  } finally { f.close(); }
});

test("temporary cleanup failure before publication preserves the incumbent generation", async () => {
  const f = fixture();
  try {
    expect(await run(f.store.compareAndSet("worker", undefined, 1))).toBe(true);
    const fault = spyOn(fs, "rmSync").mockImplementationOnce(() => { throw new Error("temporary cleanup failed"); });
    try {
      await expect(run(f.store.compareAndSet("worker", undefined, 2))).rejects.toMatchObject({
        _tag: "MachinesFailure", operation: "generation.compareAndSet", cause: "Error: temporary cleanup failed",
      });
    } finally { fault.mockRestore(); }
    expect(await run(f.store.current("worker"))).toBe(1);
  } finally { f.close(); }
});

test("temporary cleanup failure after rename leaves the published generation advanced", async () => {
  const f = fixture();
  try {
    expect(await run(f.store.compareAndSet("worker", undefined, 1))).toBe(true);
    const fault = spyOn(fs, "rmSync").mockImplementationOnce(() => { throw new Error("temporary cleanup failed"); });
    try {
      expect(await run(f.store.compareAndSet("worker", 1, 2))).toBe(true);
    } finally { fault.mockRestore(); }
    expect(await run(f.store.current("worker"))).toBe(2);
    expect(await run(f.store.compareAndSet("worker", 2, 3))).toBe(true);
  } finally { f.close(); }
});

test("two interrupted writers in one CAS each require proof before a further retry", async () => {
  const f = fixture();
  try {
    fs.mkdirSync(join(f.directory, "state"), { recursive: true });
    const ended = Bun.spawn(["/bin/sh", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore" });
    expect(await ended.exited).toBe(0);
    fs.mkdirSync(`${f.path}.lock`);
    fs.writeFileSync(`${f.path}.lock/pid`, String(ended.pid));
    const mkdir = fs.mkdirSync;
    let attempts = 0;
    const race = spyOn(fs, "mkdirSync").mockImplementation((target, options) => {
      if (target === `${f.path}.lock` && ++attempts === 2) {
        mkdir(target);
        fs.writeFileSync(`${f.path}.lock/pid`, String(ended.pid));
        throw Object.assign(new Error("another abandoned holder"), { code: "EEXIST" });
      }
      return mkdir(target, options);
    });
    try {
      expect(await run(f.store.compareAndSet("worker", undefined, 1))).toBe(false);
    } finally { race.mockRestore(); }
    expect(attempts).toBe(2);
    expect(await run(f.store.current("worker"))).toBeUndefined();
    expect(await run(f.store.compareAndSet("worker", undefined, 1))).toBe(true);
  } finally { f.close(); }
});
