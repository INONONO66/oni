import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Machine } from "@oni/protocol";
import { createFsDriver } from "./helpers/native";
import { expectEscape, expectInsideRead } from "./helpers";

function withFixture(
  run: (fixture: { base: string; root: string; outside: string }) => Promise<void>,
) {
  const base = mkdtempSync(join(tmpdir(), "oni-machine-fs-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  return run({ base, root, outside }).finally(() => rmSync(base, { recursive: true, force: true }));
}

type DescriptorLedger = {
  readonly hooks: {
    onRootDescriptorAcquired: (fd: number) => void;
    closeRootDescriptor: (fd: number) => void;
  };
  /** Acquisitions in order, each recording how often that acquisition was closed. */
  readonly closesPerAcquisition: () => number[];
  readonly liveCount: () => number;
};

/**
 * Accounts for every descriptor the root walk acquires, per ACQUISITION rather
 * than per fd number: the kernel reuses a released fd number immediately, so
 * counting by number alone cannot distinguish a second close of a released
 * descriptor from the first close of its replacement. A close is attributed to
 * the newest live acquisition of that number and counted again if it arrives
 * when no acquisition of that number is live.
 */
type Acquisition = { fd: number; closes: number; live: boolean };

function descriptorLedger(): DescriptorLedger {
  const acquisitions: Acquisition[] = [];
  const newest = (fd: number, liveOnly: boolean): Acquisition | undefined => {
    for (let index = acquisitions.length - 1; index >= 0; index -= 1) {
      const entry = acquisitions[index] as Acquisition;
      if (entry.fd === fd && (entry.live || !liveOnly)) return entry;
    }
    return undefined;
  };
  return {
    hooks: {
      onRootDescriptorAcquired: (fd) => acquisitions.push({ fd, closes: 0, live: true }),
      closeRootDescriptor: (fd) => {
        const target = newest(fd, true) ?? newest(fd, false);
        if (target !== undefined) {
          target.closes += 1;
          target.live = false;
        }
        closeSync(fd);
      },
    },
    closesPerAcquisition: () => acquisitions.map((entry) => entry.closes),
    liveCount: () => acquisitions.filter((entry) => entry.live).length,
  };
}

function runFifoRequests(root: string, requests: Machine.FsRequest[]): string {
  const helper = join(import.meta.dir, "helpers", "fifo-request.ts");
  const child = spawnSync(process.execPath, [helper, root, JSON.stringify(requests)], {
    encoding: "utf8",
    // A blocking FIFO open never returns; the bound must still absorb one
    // instrumented cold start when the suite runs under the exact collector.
    timeout: 15_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status).toBe(0);
  expect(child.stderr).toBe("");
  return child.stdout;
}

describe("machine fs request boundary", () => {
  test.each([
    "/etc/passwd",
    "../secret",
    "dir/../secret",
    "nul\0byte",
  ])("rejects non-relative or escaping path %p", (path) => {
    const parsed = Machine.FsRequest.safeParse({ op: "stat", export: "docs", path });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected the fs path schema to refuse the request");
    expect(parsed.error.issues[0]?.message).toBe(
      "path must be relative to the export root, with no .. segment or NUL",
    );
  });
});

describe("daemon filesystem driver", () => {
  test.each([
    "removed",
    "replaced",
  ])("refuses a final symlink %s after readlink", async (change) => {
    await withFixture(async ({ root }) => {
      const link = join(root, "link");
      symlinkSync("target", link);
      writeFileSync(join(root, "target"), "inside");
      const driver = createFsDriver(new Map([["docs", root]]), {
        afterSymlinkRead: () => {
          rmSync(link);
          if (change === "replaced") writeFileSync(link, "replacement");
        },
      });
      try {
        expect(await driver({ op: "stat", export: "docs", path: "link" })).toMatchObject({
          status: "refused",
          reason: "io_error",
        });
      } finally {
        driver.close();
      }
    });
  });

  test("releases the duplicated descriptor when native directory stream acquisition fails", async () => {
    await withFixture(async ({ root }) => {
      let duplicate = -1;
      const driver = createFsDriver(new Map([["docs", root]]), {
        openDirectoryStream: (fd) => {
          duplicate = fd;
          expect(fstatSync(fd).isDirectory()).toBe(true);
          // fdopendir returns NULL on allocation failure without taking ownership.
          return null;
        },
      });
      try {
        await expect(driver({ op: "list", export: "docs", path: "" })).rejects.toMatchObject({
          _tag: "FilesystemFailure", operation: "fs.operation", cause: expect.stringContaining("fdopendir failed"),
        });
        expect(() => fstatSync(duplicate)).toThrow(expect.objectContaining({ code: "EBADF" }));
      } finally {
        driver.close();
      }
    });
  });

  test("walks nested links, normalizes targets, and preserves links to the root", async () => {
    await withFixture(async ({ root }) => {
      mkdirSync(join(root, "nested"));
      writeFileSync(join(root, "note"), "x");
      symlinkSync(realpathSync(root), join(root, "absolute"));
      symlinkSync("./../note", join(root, "nested", "relative"));
      symlinkSync("../../outside", join(root, "escape"));
      const driver = createFsDriver(new Map([["docs", root]]));
      try {
        for (const path of ["absolute/note", "nested/relative"])
          expect(await driver({ op: "read", export: "docs", path })).toMatchObject({
            status: "completed",
            value: { data: "eA==" },
          });
        expect(await driver({ op: "stat", export: "docs", path: "absolute" })).toMatchObject({
          status: "completed",
          value: { kind: "symlink" },
        });
        expect(await driver({ op: "stat", export: "docs", path: "escape" })).toMatchObject({
          status: "refused",
          reason: "path_escapes_export",
        });
      } finally {
        driver.close();
      }
    });
  });

  test("bounds both root and request symlink expansion and unwinds preserved descriptors", async () => {
    await withFixture(async ({ root }) => {
      symlinkSync("cycle", join(root, "cycle"));
      expect(() => createFsDriver(new Map([["docs", join(root, "cycle")]]))).toThrow();
      const driver = createFsDriver(new Map([["docs", root]]));
      try {
        expect(await driver({ op: "stat", export: "docs", path: "cycle" })).toMatchObject({
          status: "refused",
          reason: "io_error",
        });
        expect(spawnSync("mkfifo", [join(root, "pipe")]).status).toBe(0);
        expect(await driver({ op: "stat", export: "docs", path: "pipe" })).toMatchObject({
          status: "completed",
          value: { kind: "other" },
        });
      } finally {
        driver.close();
      }
    });
  });

  test("rejects a schema-bypassing lexical escape at the driver boundary", async () => {
    await withFixture(async ({ root }) => {
      const fsOp = createFsDriver(new Map([["docs", root]]));
      const request: Machine.FsRequest = { op: "stat", export: "docs", path: "../secret" };

      await expect(fsOp(request)).resolves.toEqual({
        status: "refused",
        reason: "path_escapes_export",
        message: "path escapes export: ../secret",
      });
    });
  });

  // Regression guard, not an exploit repro: ".." inside a link target is walked
  // component-wise through openat, so the kernel resolves it after following the
  // link and canonicalPath stays in agreement with the pinned descriptor. This
  // pins that agreement so a future switch to lexical-only resolution is caught.
  test("resolves an export root reached through an absolute link containing ..", async () => {
    await withFixture(async ({ base, root }) => {
      writeFileSync(join(root, "note.txt"), "inside");
      // link -> /<base>/outside/../root, which normalizes back to root.
      const link = join(base, "link");
      symlinkSync(join(base, "outside", "..", "root"), link);

      const fsOp = createFsDriver(new Map([["docs", link]]));
      try {
        await expect(fsOp({ op: "read", export: "docs", path: "note.txt" })).resolves.toMatchObject(
          {
            status: "completed",
            value: { op: "read", data: Buffer.from("inside").toString("base64") },
          },
        );
      } finally {
        fsOp.close();
      }
    });
  });

  test("pins the resolved export root before its pathname can be replaced", async () => {
    await withFixture(async ({ base, root, outside }) => {
      writeFileSync(join(root, "note.txt"), "inside");
      writeFileSync(join(outside, "note.txt"), "outside");
      let swapped = false;
      const fsOp = createFsDriver(new Map([["docs", root]]), {
        afterRootPathResolution: () => {
          renameSync(root, join(base, "original-root"));
          symlinkSync(outside, root);
          swapped = true;
        },
      });

      expect(swapped).toBe(true);
      await expectInsideRead(fsOp, "note.txt");
      fsOp.close();
    });
  });

  test("keeps using the opened export inode after its pathname is replaced", async () => {
    await withFixture(async ({ base, root, outside }) => {
      writeFileSync(join(root, "note.txt"), "inside");
      writeFileSync(join(outside, "note.txt"), "outside");
      const fsOp = createFsDriver(new Map([["docs", root]]));
      renameSync(root, join(base, "original-root"));
      symlinkSync(outside, root);

      await expectInsideRead(fsOp, "note.txt");
    });
  });

  test("refuses dangling outside symlinks without revealing target existence", async () => {
    await withFixture(async ({ root, outside }) => {
      symlinkSync(join(outside, "missing.txt"), join(root, "escape"));
      const fsOp = createFsDriver(new Map([["docs", root]]));

      await expectEscape(fsOp);
    });
  });

  test("does not confuse an export path with a sibling sharing its prefix", async () => {
    const base = mkdtempSync(join(tmpdir(), "oni-machine-fs-prefix-"));
    const root = join(base, "export");
    const evil = join(base, "export-evil");
    mkdirSync(root);
    mkdirSync(evil);
    writeFileSync(join(evil, "secret.txt"), "secret");
    symlinkSync(join(evil, "secret.txt"), join(root, "escape"));
    try {
      const fsOp = createFsDriver(new Map([["docs", root]]));
      await expectEscape(fsOp);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("canonicalizes an export root symlink before opening its directory", async () => {
    await withFixture(async ({ base, root }) => {
      writeFileSync(join(root, "note.txt"), "inside");
      const rootAlias = join(base, "root-alias");
      symlinkSync(root, rootAlias);
      const ledger = descriptorLedger();
      const fsOp = createFsDriver(new Map([["docs", rootAlias]]), ledger.hooks);

      await expect(fsOp({ op: "read", export: "docs", path: "note.txt" })).resolves.toMatchObject({
        status: "completed",
        value: { op: "read", data: Buffer.from("inside").toString("base64") },
      });

      // Invariant 3: the symlink restart leaves exactly one live descriptor —
      // the pinned root — and driver disposal closes it, each exactly once.
      expect(ledger.liveCount()).toBe(1);
      fsOp.close();
      expect(ledger.liveCount()).toBe(0);
      const closes = ledger.closesPerAcquisition();
      expect(closes.length).toBeGreaterThan(1);
      expect(closes).toEqual(closes.map(() => 1));
    });
  });

  // D1 regression. The restart branch releases the walk descriptor and then
  // reopens "/"; when that reopen throws, the failure path must not close the
  // released descriptor a second time (a reused fd number would belong to an
  // unrelated open) and must propagate the reopen failure itself.
  test("closes each root descriptor exactly once when a restart reopen throws", async () => {
    await withFixture(async ({ base, root }) => {
      const rootAlias = join(base, "root-alias");
      symlinkSync(root, rootAlias);
      const reopenFailure = new Error("injected restart reopen failure");
      const ledger = descriptorLedger();
      const bystanderPath = join(base, "bystander.txt");
      writeFileSync(bystanderPath, "bystander");
      let rootDirectoryOpens = 0;
      let bystander: number | undefined;

      let thrown: Error | undefined;
      try {
        createFsDriver(new Map([["docs", rootAlias]]), {
          ...ledger.hooks,
          openRootDirectory: () => {
            rootDirectoryOpens += 1;
            // The first open starts the walk; the second is the restart reopen
            // that follows the export-root symlink expansion.
            if (rootDirectoryOpens < 2) {
              return openSync(sep, constants.O_RDONLY | constants.O_DIRECTORY);
            }
            // The restart already released its descriptor, so this unrelated
            // open takes the freed fd NUMBER. A stale close in the failure
            // path would land on this descriptor instead of raising EBADF.
            bystander = openSync(bystanderPath, constants.O_RDONLY);
            throw reopenFailure;
          },
        });
      } catch (error) {
        thrown = error instanceof Error ? error : new Error("non-Error failure");
      }

      // The foreign diagnostic survives serialization without retaining an Error object.
      expect(thrown).toMatchObject({ _tag: "MachinesFailure", operation: "fs.open", cause: String(reopenFailure) });
      expect(rootDirectoryOpens).toBe(2);
      // Invariant 1: every acquisition is closed exactly once and none leaks.
      const closes = ledger.closesPerAcquisition();
      expect(closes.length).toBeGreaterThan(0);
      expect(closes).toEqual(closes.map(() => 1));
      expect(ledger.liveCount()).toBe(0);
      // The bystander that inherited the released fd number is untouched: it is
      // still open on its own inode, which a stale close would have closed.
      if (bystander === undefined) throw new Error("expected the injected reopen to run");
      expect(fstatSync(bystander).ino).toBe(lstatSync(bystanderPath).ino);
      closeSync(bystander);
    });
  });

  // D1 regression, walk-failure half. A non-reopen walk failure (here: an
  // export-root component that is a regular file) unwinds while the walk still
  // owns a live descriptor, so the failure path must close it — a leak would
  // pin the descriptor for the process lifetime.
  test("closes the live walk descriptor when the export root is not a directory", async () => {
    await withFixture(async ({ root }) => {
      const file = join(root, "note.txt");
      writeFileSync(file, "inside");
      const ledger = descriptorLedger();

      let threw = false;
      try {
        // "note.txt" is a regular file, so its openat(O_DIRECTORY) fails and it
        // is not a symlink either: the walk throws while holding the descriptor
        // for the parent directory it already opened. No hook throws here, so
        // the unwind can only originate in the walk body — not in the injected
        // reopen the sibling regression covers.
        createFsDriver(new Map([["docs", join(file, "child")]]), ledger.hooks);
      } catch (error) {
        threw = error instanceof Error;
      }

      expect(threw).toBe(true);
      // Invariant 1: the descriptor held when the walk threw is closed exactly
      // once by the failure path, and nothing stays live.
      const closes = ledger.closesPerAcquisition();
      expect(closes.length).toBeGreaterThan(1);
      expect(closes).toEqual(closes.map(() => 1));
      expect(ledger.liveCount()).toBe(0);
    });
  });

  test("re-evaluates a component replaced by an outside symlink between calls", async () => {
    await withFixture(async ({ root, outside }) => {
      const victim = join(root, "victim.txt");
      writeFileSync(victim, "inside");
      writeFileSync(join(outside, "secret.txt"), "outside");
      const fsOp = createFsDriver(new Map([["docs", root]]));

      const first = await fsOp({ op: "read", export: "docs", path: "victim.txt" });
      expect(first).toMatchObject({
        status: "completed",
        value: { op: "read", data: Buffer.from("inside").toString("base64") },
      });
      rmSync(victim);
      symlinkSync(join(outside, "secret.txt"), victim);
      await expect(fsOp({ op: "read", export: "docs", path: "victim.txt" })).resolves.toEqual({
        status: "refused",
        reason: "path_escapes_export",
        message: "path escapes export: victim.txt",
      });
    });
  });

  test("refuses an unknown export", async () => {
    await withFixture(async ({ root }) => {
      const fsOp = createFsDriver(new Map([["docs", root]]));
      await expect(fsOp({ op: "stat", export: "private", path: "" })).resolves.toEqual({
        status: "refused",
        reason: "export_not_available",
        message: "export is not available: private",
      });
    });
  });

  test("refuses a symlink that resolves outside the export without leaking host paths", async () => {
    await withFixture(async ({ root, outside }) => {
      writeFileSync(join(outside, "secret.txt"), "secret");
      symlinkSync(join(outside, "secret.txt"), join(root, "escape"));
      const fsOp = createFsDriver(new Map([["docs", root]]));

      const result = await fsOp({ op: "read", export: "docs", path: "escape" });
      expect(result).toEqual({
        status: "refused",
        reason: "path_escapes_export",
        message: "path escapes export: escape",
      });
      expect(JSON.stringify(result)).not.toContain(outside);
    });
  });

  test("allows a symlink whose target remains inside the export", async () => {
    await withFixture(async ({ root }) => {
      writeFileSync(join(root, "target.txt"), "inside");
      symlinkSync("target.txt", join(root, "link.txt"));
      const fsOp = createFsDriver(new Map([["docs", root]]));

      await expectInsideRead(fsOp, "link.txt");
      const stat = await fsOp({ op: "stat", export: "docs", path: "link.txt" });
      expect(stat.status === "completed" && stat.value).toMatchObject({
        op: "stat",
        kind: "symlink",
      });
    });
  });

  test("maps missing paths and wrong kinds to typed refusals", async () => {
    await withFixture(async ({ root }) => {
      mkdirSync(join(root, "folder"));
      writeFileSync(join(root, "file.txt"), "text");
      const fsOp = createFsDriver(new Map([["docs", root]]));

      await expect(fsOp({ op: "stat", export: "docs", path: "missing" })).resolves.toEqual({
        status: "refused",
        reason: "not_found",
        message: "path not found: missing",
      });
      await expect(fsOp({ op: "read", export: "docs", path: "folder" })).resolves.toEqual({
        status: "refused",
        reason: "wrong_kind",
        message: "path is not a file: folder",
      });
      await expect(fsOp({ op: "list", export: "docs", path: "file.txt" })).resolves.toEqual({
        status: "refused",
        reason: "wrong_kind",
        message: "path is not a directory: file.txt",
      });
    });
  });

  test("clamps reads to the protocol byte cap and reports an honest range", async () => {
    await withFixture(async ({ root }) => {
      const bytes = Buffer.alloc(Machine.FS_READ_MAX_BYTES + 7, 97);
      writeFileSync(join(root, "large.txt"), bytes);
      const fsOp = createFsDriver(new Map([["docs", root]]));

      const result = await fsOp({
        op: "read",
        export: "docs",
        path: "large.txt",
        limit: Machine.FS_READ_MAX_BYTES + 100,
      });
      expect(result.status).toBe("completed");
      if (result.status !== "completed" || result.value.op !== "read") {
        throw new Error("expected a completed read");
      }
      expect(Buffer.from(result.value.data, "base64").length).toBe(Machine.FS_READ_MAX_BYTES);
      expect(result.value).toMatchObject({
        bytesRead: Machine.FS_READ_MAX_BYTES,
        size: Machine.FS_READ_MAX_BYTES + 7,
        truncated: true,
      });
    });
  });

  test("caps directory listings, reports truncation, and sizes only files", async () => {
    await withFixture(async ({ root }) => {
      for (let index = 0; index < Machine.FS_LIST_MAX_ENTRIES + 1; index += 1) {
        writeFileSync(join(root, `entry-${String(index).padStart(4, "0")}`), "x");
      }
      mkdirSync(join(root, "000-directory"));
      const fsOp = createFsDriver(new Map([["docs", root]]));

      const result = await fsOp({ op: "list", export: "docs", path: "" });
      expect(result.status).toBe("completed");
      if (result.status !== "completed" || result.value.op !== "list") {
        throw new Error("expected a completed listing");
      }
      expect(result.value.entries).toHaveLength(Machine.FS_LIST_MAX_ENTRIES);
      expect(result.value.truncated).toBe(true);
      expect(result.value.entries.every((entry) => entry.kind !== "file" || entry.size === 1)).toBe(
        true,
      );
      expect(
        result.value.entries.every((entry) => entry.kind === "file" || entry.size === undefined),
      ).toBe(true);
    });
  });

  test("handles FIFOs without blocking read, stat, or list", async () => {
    await withFixture(async ({ root }) => {
      const fifo = join(root, "pipe");
      const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
      expect(created.error).toBeUndefined();
      expect(created.signal).toBeNull();
      expect(created.status).toBe(0);
      expect(created.stdout).toBe("");
      expect(created.stderr).toBe("");

      expect(
        runFifoRequests(root, [
          { op: "read", export: "docs", path: "pipe" },
          { op: "stat", export: "docs", path: "pipe" },
          { op: "list", export: "docs", path: "" },
        ]),
      ).toBe(
        JSON.stringify([
          { status: "refused", reason: "wrong_kind", message: "path is not a file: pipe" },
          {
            status: "completed",
            value: { op: "stat", kind: "other", size: 0, mtimeMs: lstatSync(fifo).mtimeMs },
          },
          {
            status: "completed",
            value: { op: "list", entries: [{ name: "pipe", kind: "other" }], truncated: false },
          },
        ]),
      );
    });
  });

  // A unix socket cannot be opened at all (ENXIO/EOPNOTSUPP), unlike a FIFO
  // which opens under O_NONBLOCK. An export holding one must still list.
  test("lists a directory containing a unix socket", async () => {
    await withFixture(async ({ root }) => {
      const fsOp = createFsDriver(new Map([["docs", root]]));
      const server = createServer();
      await new Promise<void>((ready) => server.listen(join(root, "sock"), ready));
      try {
        await expect(fsOp({ op: "list", export: "docs", path: "" })).resolves.toEqual({
          status: "completed",
          value: {
            op: "list",
            entries: [{ name: "sock", kind: "other" }],
            truncated: false,
          },
        });
        // A socket cannot be opened at all, so the refusal surfaces as io_error
        // rather than wrong_kind: the driver never gets a descriptor to classify.
        await expect(fsOp({ op: "read", export: "docs", path: "sock" })).resolves.toEqual({
          status: "refused",
          reason: "io_error",
          message: "filesystem operation failed for: sock",
        });
      } finally {
        await new Promise<void>((closed) => server.close(() => closed()));
      }
    });
  });

  test("writes never follow escaping or dangling symlinks and keep the pinned root", async () => {
    await withFixture(async ({ root, outside, base }) => {
      writeFileSync(join(outside, "secret"), "untouched");
      symlinkSync(join(outside, "secret"), join(root, "escape"));
      symlinkSync(join(outside, "absent"), join(root, "dangling"));
      symlinkSync(outside, join(root, "directory"));
      const driver = createFsDriver(new Map([["docs", root]]));
      const write = (path: string) =>
        driver({
          op: "write",
          export: "docs",
          path,
          data: Buffer.from("changed").toString("base64"),
        });
      try {
        for (const path of ["escape", "dangling", "directory/secret", "../outside/secret"]) {
          expect(await write(path)).toMatchObject({
            status: "refused",
            reason: "path_escapes_export",
          });
        }
        expect(readFileSync(join(outside, "secret"), "utf8")).toBe("untouched");
        const pinned = join(base, "pinned");
        renameSync(root, pinned);
        symlinkSync(outside, root);
        expect(await write("created")).toEqual({
          status: "completed",
          value: { op: "write", bytesWritten: 7 },
        });
        expect(readFileSync(join(pinned, "created"), "utf8")).toBe("changed");
        expect(lstatSync(join(pinned, "created")).mode & 0o777).toBe(0o600);
      } finally {
        driver.close();
      }
    });
  });

  test("stats files with lstat metadata", async () => {
    await withFixture(async ({ root }) => {
      const path = join(root, "note.txt");
      writeFileSync(path, "hello");
      const expected = lstatSync(path);
      const fsOp = createFsDriver(new Map([["docs", root]]));

      await expect(fsOp({ op: "stat", export: "docs", path: "note.txt" })).resolves.toEqual({
        status: "completed",
        value: { op: "stat", kind: "file", size: 5, mtimeMs: expected.mtimeMs },
      });
    });
  });
});
