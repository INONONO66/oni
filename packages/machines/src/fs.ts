import { Effect } from "effect";
import { FilesystemFailure, type MachineError } from "./errors";
import { decodeMachineFailure } from "./failure";
import { CString, FFIType, dlopen, toArrayBuffer, type Pointer } from "bun:ffi";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Machine } from "@oni/protocol";
import { createHash, type Hash } from "node:crypto";

type EntryKind = "file" | "dir" | "symlink" | "other";
type Refusal = Extract<Machine.FsResult, { status: "refused" }>;
type OpenedTarget = { readonly fd: number; readonly symlinkStat?: ReturnType<typeof fstatSync> };
type WalkResult = OpenedTarget | Refusal;

type FsDriver = ((request: Machine.FsRequest) => Effect.Effect<Machine.FsResult, MachineError>) & {
  stream(request: Machine.FsStreamRequest): Effect.Effect<Machine.FsStreamResult, MachineError>;
  modeOf(transferId: string): "read" | "write" | undefined;
  abortAll(): Effect.Effect<void, MachineError>;
  close(): Effect.Effect<void, MachineError>;
};

type FsDriverTestHooks = {
  readonly afterRootPathResolution?: (canonicalPath: string) => void;
  /** Schedule a pathname replacement after readlink, before the no-follow open. */
  readonly afterSymlinkRead?: () => void;
  /** Substitute only the native stream acquisition; descriptor ownership stays in the driver. */
  readonly openDirectoryStream?: (fd: number) => Pointer | null;
  /**
   * Seams over the root descriptor lifecycle. A test substitutes the open of
   * the filesystem root to force the restart reopen to fail, and observes
   * acquisition and release of every descriptor the root walk owns, so the
   * close-exactly-once invariant is asserted without depending on permissions,
   * fd exhaustion, or timing.
   */
  readonly openRootDirectory?: () => number;
  readonly onRootDescriptorAcquired?: (fd: number) => void;
  readonly closeRootDescriptor?: (fd: number) => void;
};

type Root = { readonly canonicalPath: string; readonly fd: number };

const libcPath = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
// Darwin's public openat is variadic: arm64 passes its mode on the stack.
// Bind the fixed-arity syscall entry so FFI passes creation mode correctly.
const openSignature = {
  args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32],
  returns: FFIType.i32,
} as const;
const nativeOpen =
  process.platform === "darwin"
    ? dlopen(libcPath, { __openat: openSignature }).symbols.__openat
    : dlopen(libcPath, { openat: openSignature }).symbols.openat;
const libc = dlopen(libcPath, {
  readlinkat: {
    args: [FFIType.i32, FFIType.cstring, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },
  fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
  readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
  closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
  renameat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring], returns: FFIType.i32 },
  unlinkat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
  ...(process.platform === "darwin"
    ? { __error: { args: [], returns: FFIType.ptr } }
    : { __errno_location: { args: [], returns: FFIType.ptr } }),
});

const O_DIRECTORY = constants.O_DIRECTORY;
const O_NOFOLLOW = constants.O_NOFOLLOW;
const O_CLOEXEC = process.platform === "darwin" ? 0x100_0000 : 0x8_0000;
const O_OPEN_SYMLINK = process.platform === "darwin" ? 0x20_0000 : 0x20_0000 | O_NOFOLLOW;
/**
 * Every descriptor this driver opens is opened non-blocking. A regular file or
 * directory is unaffected, while a FIFO or device node in an export would
 * otherwise park the daemon inside open(2) until a writer appeared.
 */
const O_TARGET = constants.O_RDONLY | constants.O_NONBLOCK;
const MAX_SYMLINK_EXPANSIONS = 40;
const READLINK_BUFFER_BYTES = 4096;

function cString(value: string): Buffer {
  return Buffer.from(`${value}\0`);
}

function errno(): number {
  const symbols = libc.symbols as typeof libc.symbols & {
    __error?: () => Pointer | null;
    __errno_location?: () => Pointer | null;
  };
  const pointer = symbols.__error?.() ?? symbols.__errno_location?.();
  if (pointer === null || pointer === undefined) return 0;
  return new DataView(toArrayBuffer(pointer, 0, 4)).getInt32(0, true);
}

function kindOf(entry: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): EntryKind {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "dir";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function displayPath(path: string): string {
  return path === "" ? "." : path;
}

function refused(reason: Refusal["reason"], message: string): Refusal {
  return { status: "refused", reason, message };
}

function isRefusal(result: WalkResult | WalkLink): result is Refusal {
  return "status" in result;
}

function requestSegments(path: string): string[] | undefined {
  if (isAbsolute(path) || path.includes("\0")) return undefined;
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  return segments.includes("..") ? undefined : segments;
}

function resolveLink(
  root: Root,
  traversed: readonly string[],
  target: string,
): string[] | undefined {
  if (isAbsolute(target)) {
    const normalized = resolve(target);
    if (!isWithin(root.canonicalPath, normalized)) return undefined;
    const remainder = relative(root.canonicalPath, normalized);
    return remainder === "" ? [] : remainder.split(sep);
  }

  const resolved = [...traversed];
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0) return undefined;
      resolved.pop();
    } else {
      resolved.push(segment);
    }
  }
  return resolved;
}

function readLinkAt(dirfd: number, name: string): { target: string } | { errno: number } {
  const buffer = Buffer.allocUnsafe(READLINK_BUFFER_BYTES);
  const length = Number(
    libc.symbols.readlinkat(dirfd, cString(name), buffer, BigInt(buffer.byteLength)),
  );
  if (length < 0) return { errno: errno() };
  if (length === buffer.byteLength) return { errno: 0 };
  return { target: buffer.subarray(0, length).toString("utf8") };
}

function openAt(dirfd: number, name: string, flags: number): { fd: number } | { errno: number } {
  const fd = nativeOpen(dirfd, cString(name), flags, 0o600);
  return fd < 0 ? { errno: errno() } : { fd };
}

function openSymlinkAt(dirfd: number, name: string): number | undefined {
  const opened = openAt(dirfd, name, O_OPEN_SYMLINK | O_CLOEXEC);
  if (!("fd" in opened)) return undefined;
  const metadata = fstatSync(opened.fd);
  if (metadata.isSymbolicLink()) return opened.fd;
  closeSync(opened.fd);
  return undefined;
}

function refusalForOpenError(errorNumber: number, shown: string): Refusal {
  if (errorNumber === 2 || errorNumber === 20) {
    return refused("not_found", `path not found: ${shown}`);
  }
  return refused("io_error", `filesystem operation failed for: ${shown}`);
}

type WalkLink = { readonly pending: string[]; readonly preservedSymlinkFd?: number } | Refusal;

function expandWalkLink(
  root: Root,
  traversed: readonly string[],
  pending: readonly string[],
  segment: string,
  openErrno: number,
  isFinal: boolean,
  finalDirectory: boolean,
  preserveFinalSymlink: boolean,
  preservedSymlinkFd: number | undefined,
  expansions: number,
  shown: string,
  dirfd: number,
  testHooks: FsDriverTestHooks,
): WalkLink {
  const link = readLinkAt(dirfd, segment);
  if (!("target" in link)) {
    if (isFinal && finalDirectory && openErrno === 20)
      return refused("wrong_kind", `path is not a directory: ${shown}`);
    return refusalForOpenError(openErrno, shown);
  }
  testHooks.afterSymlinkRead?.();
  const rewritten = resolveLink(root, traversed, link.target);
  if (rewritten === undefined)
    return refused("path_escapes_export", `path escapes export: ${shown}`);
  if (expansions + 1 > MAX_SYMLINK_EXPANSIONS)
    return refused("io_error", `filesystem operation failed for: ${shown}`);
  let preserved = preservedSymlinkFd;
  if (isFinal && preserveFinalSymlink && preserved === undefined) {
    preserved = openSymlinkAt(dirfd, segment);
    if (preserved === undefined)
      return refused("io_error", `filesystem operation failed for: ${shown}`);
  }
  return { pending: [...rewritten, ...pending.slice(1)], preservedSymlinkFd: preserved };
}

function finishWalkTarget(
  fd: number,
  remainingSegments: number,
  preservedSymlinkFd: number | undefined,
): WalkResult | undefined {
  if (remainingSegments !== 0) return undefined;
  const symlinkStat = preservedSymlinkFd === undefined ? undefined : fstatSync(preservedSymlinkFd);
  if (preservedSymlinkFd !== undefined) closeSync(preservedSymlinkFd);
  return { fd, symlinkStat };
}

function walk(
  root: Root,
  initialSegments: readonly string[],
  finalDirectory: boolean,
  preserveFinalSymlink: boolean,
  shown: string,
  targetFlags: number,
  testHooks: FsDriverTestHooks,
): WalkResult {
  let pending = [...initialSegments];
  let traversed: string[] = [];
  let dirfd = root.fd;
  let ownsDirfd = false;
  let expansions = 0;
  let preservedSymlinkFd: number | undefined;

  const closeOwned = () => {
    if (ownsDirfd) closeSync(dirfd);
    ownsDirfd = false;
    dirfd = root.fd;
  };
  const fail = (result: Refusal): Refusal => {
    closeOwned();
    if (preservedSymlinkFd !== undefined) closeSync(preservedSymlinkFd);
    return result;
  };

  while (pending.length > 0) {
    const segment = pending[0] as string;
    const isFinal = pending.length === 1;
    const flags =
      (isFinal ? targetFlags : constants.O_RDONLY) |
      O_NOFOLLOW |
      O_CLOEXEC |
      (!isFinal || finalDirectory ? O_DIRECTORY : 0);
    const opened = openAt(dirfd, segment, flags);
    if ("fd" in opened) {
      closeOwned();
      dirfd = opened.fd;
      ownsDirfd = true;
      traversed.push(segment);
      pending.shift();
      const completed = finishWalkTarget(dirfd, pending.length, preservedSymlinkFd);
      if (completed !== undefined) return completed;
      continue;
    }

    const expanded = expandWalkLink(
      root,
      traversed,
      pending,
      segment,
      opened.errno,
      isFinal,
      finalDirectory,
      preserveFinalSymlink,
      preservedSymlinkFd,
      expansions,
      shown,
      dirfd,
      testHooks,
    );
    if (isRefusal(expanded)) return fail(expanded);
    pending = expanded.pending;
    preservedSymlinkFd = expanded.preservedSymlinkFd;
    expansions += 1;
    traversed = [];
    closeOwned();
  }

  const opened = openAt(dirfd, ".", O_TARGET | O_CLOEXEC | (finalDirectory ? O_DIRECTORY : 0));
  if (!("fd" in opened)) return fail(refusalForOpenError(opened.errno, shown));
  closeOwned();
  const symlinkStat = preservedSymlinkFd === undefined ? undefined : fstatSync(preservedSymlinkFd);
  if (preservedSymlinkFd !== undefined) closeSync(preservedSymlinkFd);
  return { fd: opened.fd, symlinkStat };
}

function closeRootDescriptor(testHooks: FsDriverTestHooks, fd: number): void {
  if (testHooks.closeRootDescriptor === undefined) closeSync(fd);
  else testHooks.closeRootDescriptor(fd);
}

/**
 * Resolve an Owner-configured export root into a pinned descriptor by walking
 * its components with openat(O_NOFOLLOW) from the filesystem root, expanding
 * any symlink component explicitly and restarting the walk. The canonical path
 * is recorded from the components actually traversed, so the descriptor and the
 * recorded path are produced by one traversal instead of a resolution that is
 * verified and then re-resolved by name when the descriptor is opened.
 */
function openRoot(configuredRoot: string, testHooks: FsDriverTestHooks): Root {
  const absolute = resolve(configuredRoot);
  let pending = absolute.split(sep).filter((segment) => segment.length > 0);
  let traversed: string[] = [];
  let expansions = 0;
  /**
   * `owned` is the sole owner of the walk descriptor: it holds an fd only
   * while that fd is open, and `release()` clears it BEFORE closing. No
   * failure path can therefore close a released fd a second time — by then a
   * reused fd number belongs to an unrelated open, and the secondary close
   * would also mask the failure that caused the unwind. The walk reads the
   * held fd through `dirfd`, which every acquisition rebinds in the same step.
   */
  let owned: number | undefined;

  const acquire = (fd: number): number => {
    testHooks.onRootDescriptorAcquired?.(fd);
    owned = fd;
    return fd;
  };
  const openFilesystemRoot = () =>
    acquire(
      testHooks.openRootDirectory === undefined
        ? openSync(sep, constants.O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        : testHooks.openRootDirectory(),
    );
  const release = () => {
    if (owned === undefined) return;
    const fd = owned;
    owned = undefined;
    closeRootDescriptor(testHooks, fd);
  };

  let dirfd = openFilesystemRoot();

  let walkCompleted = false;
  try {
    while (pending.length > 0) {
      const segment = pending[0] as string;
      const opened = openAt(
        dirfd,
        segment,
        constants.O_RDONLY | O_NOFOLLOW | O_DIRECTORY | O_CLOEXEC,
      );
      if ("fd" in opened) {
        release();
        dirfd = acquire(opened.fd);
        traversed.push(segment);
        pending.shift();
        continue;
      }

      const link = readLinkAt(dirfd, segment);
      if (!("target" in link)) {
        throw new FilesystemFailure({ operation: "fs.open", message: `export root is not a directory: ${configuredRoot}`, cause: "export root walk hit a non-directory component" });
      }
      expansions += 1;
      if (expansions > MAX_SYMLINK_EXPANSIONS) {
        throw new FilesystemFailure({ operation: "fs.open", message: `export root has too many symlink levels: ${configuredRoot}`, cause: "symlink expansion exceeded MAX_SYMLINK_EXPANSIONS" });
      }
      // Both branches must be lexically normalized. An absolute target may
      // still carry "."/".." components, and leaving them raw makes
      // canonicalPath disagree with the pinned descriptor, which then breaks
      // containment comparisons in resolveLink().
      const linkBase = resolve(
        isAbsolute(link.target) ? sep : sep + traversed.join(sep),
        link.target,
      );
      pending = [
        ...linkBase.split(sep).filter((segment_) => segment_.length > 0),
        ...pending.slice(1),
      ];
      traversed = [];
      release();
      dirfd = openFilesystemRoot();
    }
    walkCompleted = true;
  } finally {
    if (!walkCompleted) release();
  }

  const canonicalPath = sep + traversed.join(sep);
  testHooks.afterRootPathResolution?.(canonicalPath);
  // Past the walk, ownership of the pinned descriptor belongs to the returned
  // root: the driver closes it on disposal, and `release()` is out of reach.
  return { canonicalPath, fd: dirfd };
}

function directoryNames(fd: number, testHooks: FsDriverTestHooks): string[] {
  const duplicate = openAt(fd, ".", constants.O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (!("fd" in duplicate)) throw new FilesystemFailure({ operation: "fs.list", message: "directory duplication failed", cause: `openat errno ${duplicate.errno}` });
  const directory = (testHooks.openDirectoryStream ?? libc.symbols.fdopendir)(duplicate.fd);
  if (directory === null) {
    closeSync(duplicate.fd);
    throw new FilesystemFailure({ operation: "fs.list", message: "fdopendir failed", cause: "fdopendir returned NULL" });
  }
  const names: string[] = [];
  try {
    while (true) {
      const entry = libc.symbols.readdir(directory);
      if (entry === null) break;
      const name =
        process.platform === "darwin"
          ? new CString(
              entry,
              21,
              new DataView(toArrayBuffer(entry, 0, 20)).getUint16(18, true),
            ).toString()
          : new CString(entry, 19).toString();
      if (name !== "." && name !== "..") names.push(name);
    }
  } finally {
    libc.symbols.closedir(directory);
  }
  return names.sort((left, right) => left.localeCompare(right));
}

function entryAt(dirfd: number, name: string): { name: string; kind: EntryKind; size?: number } {
  const opened = openAt(dirfd, name, O_TARGET | O_NOFOLLOW | O_CLOEXEC);
  if ("fd" in opened) {
    try {
      const metadata = fstatSync(opened.fd);
      const kind = kindOf(metadata);
      return kind === "file" ? { name, kind, size: metadata.size } : { name, kind };
    } finally {
      closeSync(opened.fd);
    }
  }
  const link = readLinkAt(dirfd, name);
  if ("target" in link) return { name, kind: "symlink" };
  // Sockets, devices and other non-openable nodes reach here: O_NOFOLLOW open
  // fails and the entry is not a symlink. They are listable but unreadable, so
  // report them as "other" instead of failing the whole listing. A read of one
  // is refused wrong_kind on its own path.
  return { name, kind: "other" };
}

/**
 * Daemon-local filesystem surface. Each canonical export root is
 * opened once, and requests walk from that descriptor with openat(O_NOFOLLOW).
 * Symlinks are expanded lexically and every expansion restarts at the root fd,
 * so no pathname is checked and then resolved again for use.
 */
function openFlags(op: Machine.FsRequest["op"]): number {
  return op === "write" ? constants.O_WRONLY | constants.O_CREAT | constants.O_NONBLOCK : O_TARGET;
}

function executeWrite(target: OpenedTarget, data: Buffer, shown: string): Machine.FsResult {
  if (!fstatSync(target.fd).isFile()) return refused("wrong_kind", `path is not a file: ${shown}`);
  // Never truncate before checking the pinned descriptor's kind.
  ftruncateSync(target.fd, 0);
  let bytesWritten = 0;
  while (bytesWritten < data.length) {
    bytesWritten += writeSync(
      target.fd,
      data,
      bytesWritten,
      data.length - bytesWritten,
      bytesWritten,
    );
  }
  return { status: "completed", value: { op: "write", bytesWritten } };
}

function executeRead(
  target: OpenedTarget,
  request: Extract<Machine.FsRequest, { op: "read" }>,
  shown: string,
): Machine.FsResult {
  const metadata = fstatSync(target.fd);
  if (!metadata.isFile()) return refused("wrong_kind", `path is not a file: ${shown}`);
  const limit = Math.min(request.limit ?? Machine.FS_READ_MAX_BYTES, Machine.FS_READ_MAX_BYTES);
  const offset = request.offset ?? 0;
  const buffer = Buffer.alloc(limit);
  const bytesRead = readSync(target.fd, buffer, 0, limit, offset);
  return {
    status: "completed",
    value: {
      op: "read",
      data: buffer.subarray(0, bytesRead).toString("base64"),
      bytesRead,
      size: metadata.size,
      truncated: offset + bytesRead < metadata.size,
    },
  };
}

function executeList(target: OpenedTarget, testHooks: FsDriverTestHooks): Machine.FsResult {
  const directoryEntries = directoryNames(target.fd, testHooks);
  const selected = directoryEntries.slice(0, Machine.FS_LIST_MAX_ENTRIES);
  return {
    status: "completed",
    value: {
      op: "list",
      entries: selected.map((name) => entryAt(target.fd, name)),
      truncated: directoryEntries.length > Machine.FS_LIST_MAX_ENTRIES,
    },
  };
}

function executeStat(target: OpenedTarget): Machine.FsResult {
  const metadata = target.symlinkStat ?? fstatSync(target.fd);
  return {
    status: "completed",
    value: {
      op: "stat",
      kind: kindOf(metadata),
      size: Number(metadata.size),
      mtimeMs: Number(metadata.mtimeMs),
    },
  };
}

export function createFsDriver(
  exports: ReadonlyMap<string, string>,
  testHooks: FsDriverTestHooks = {},
): Effect.Effect<FsDriver, MachineError> {
  return Effect.try({ try: () => {
  const roots = new Map<string, Root>();
  let rootsOpened = false;
  try {
    for (const [name, configuredRoot] of exports) {
      roots.set(name, openRoot(configuredRoot, testHooks));
    }
    rootsOpened = true;
  } finally {
    if (!rootsOpened)
      for (const root of roots.values()) closeRootDescriptor(testHooks, root.fd);
  }

  let closed = false;
  type Transfer = {
    fd: number;
    mode: "read" | "write";
    destination?: { dirfd: number; targetName: string; tempName: string };
    begin: string;
    size: number;
    offset: number;
    remaining: number;
    seq: number;
    hash: Hash;
    last?: { request: string; result: Machine.FsStreamResult };
  };
  const transfers = new Map<string, Transfer>();
  const MAX_OPEN_TRANSFERS = 32;
  type StreamRefusal = Extract<Machine.FsStreamResult, { status: "refused" }>;
  function streamRefused(reason: StreamRefusal["reason"]): StreamRefusal {
    return { status: "refused", reason, message: `filesystem transfer refused: ${reason}` };
  }
  function openTransfer(request: Extract<Machine.FsStreamRequest, { op: "begin" }>): (OpenedTarget & { destination?: Transfer["destination"] }) | StreamRefusal {
    const root = roots.get(request.export);
    if (root === undefined) return streamRefused("export_not_available");
    const segments = requestSegments(request.path);
    if (segments === undefined) return streamRefused("path_escapes_export");
    if (request.mode === "write") return openWriteTemp(root, segments, request.transferId);
    const target = walk(root, segments, false, false, displayPath(request.path), openFlags(request.mode), testHooks);
    if (isRefusal(target)) return { status: "refused", reason: target.reason, message: target.message };
    let retained = false;
    try {
      if (fstatSync(target.fd).isFile()) {
        retained = true;
        return target;
      }
      return streamRefused("wrong_kind");
    } finally {
      if (!retained) closeSync(target.fd);
    }
  }
  function checkWriteTarget(dirfd: number, targetName: string): StreamRefusal | undefined {
    const existing = openAt(dirfd, targetName, O_TARGET | O_NOFOLLOW | O_CLOEXEC);
    if ("fd" in existing) {
      try {
        return fstatSync(existing.fd).isFile() ? undefined : streamRefused("wrong_kind");
      } finally {
        closeSync(existing.fd);
      }
    }
    if ("target" in readLinkAt(dirfd, targetName)) return streamRefused("path_escapes_export");
    return existing.errno === 2 ? undefined : streamRefused("io_error");
  }
  function openWriteTemp(root: Root, segments: readonly string[], transferId: string): (OpenedTarget & { destination: NonNullable<Transfer["destination"]> }) | StreamRefusal {
    if (segments.length === 0) return streamRefused("wrong_kind");
    const parent = walk(root, segments.slice(0, -1), true, false, segments.join("/"), O_TARGET, testHooks);
    if (isRefusal(parent)) return { status: "refused", reason: parent.reason, message: parent.message };
    let retained = false;
    try {
      const targetName = segments.at(-1) as string;
      const refusal = checkWriteTarget(parent.fd, targetName);
      if (refusal !== undefined) return refusal;
      const tempName = `.oni-transfer-${createHash("sha256").update(transferId).digest("hex").slice(0, 32)}`;
      const staged = openAt(parent.fd, tempName, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_CLOEXEC | constants.O_NONBLOCK);
      if (!("fd" in staged)) return streamRefused("io_error");
      retained = true;
      return { fd: staged.fd, destination: { dirfd: parent.fd, targetName, tempName } };
    } finally {
      if (!retained) closeSync(parent.fd);
    }
  }
  function releaseTransfer(transfer: Transfer, published = false): void {
    closeSync(transfer.fd);
    const destination = transfer.destination;
    if (destination === undefined) return;
    const removed = published || libc.symbols.unlinkat(destination.dirfd, cString(destination.tempName), 0) === 0;
    const unlinkError = removed ? undefined : new Error(`failed to remove staged filesystem transfer: ${errno()}`);
    closeSync(destination.dirfd);
    if (unlinkError !== undefined) throw unlinkError;
  }
  function clearTransfers(): void {
    const active = [...transfers.values()];
    transfers.clear();
    let failure: Error | undefined;
    for (const transfer of active) {
      try {
        releaseTransfer(transfer);
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    if (failure !== undefined) throw failure;
  }
  function startTransfer(request: Extract<Machine.FsStreamRequest, { op: "begin" }>, begin: string, target: OpenedTarget & { destination?: Transfer["destination"] }): Machine.FsStreamResult {
    let retained = false;
    try {
      const size = request.mode === "write" ? 0 : fstatSync(target.fd).size;
      const offset = request.mode === "read" ? (request.offset ?? 0) : 0;
      transfers.set(request.transferId, {
        fd: target.fd, mode: request.mode, destination: target.destination, begin, size, offset,
        remaining: request.mode === "read" ? Math.min(request.limit ?? Math.max(0, size - offset), Math.max(0, size - offset)) : 0,
        seq: 0, hash: createHash("sha256"),
      });
      retained = true;
      return { status: "begun", seq: 0, size };
    } finally {
      if (!retained) releaseTransfer({ fd: target.fd, mode: request.mode, destination: target.destination, begin, size: 0, offset: 0, remaining: 0, seq: 0, hash: createHash("sha256") });
    }
  }
  function streamBegin(request: Extract<Machine.FsStreamRequest, { op: "begin" }>): Machine.FsStreamResult {
    const begin = JSON.stringify(request);
    const previous = transfers.get(request.transferId);
    if (previous !== undefined) return previous.begin === begin && previous.seq === 0
      ? { status: "begun", seq: 0, size: previous.size }
      : streamRefused("invalid_sequence");
    if (transfers.size >= MAX_OPEN_TRANSFERS) return streamRefused("too_large");
    const target = openTransfer(request);
    if ("status" in target) return target;
    return startTransfer(request, begin, target);
  }
  function readTransfer(transfer: Transfer, seq: number): Machine.FsStreamResult {
    const buffer = Buffer.alloc(Math.min(transfer.remaining, Machine.FS_READ_MAX_BYTES));
    const count = readSync(transfer.fd, buffer, 0, buffer.length, transfer.offset);
    const data = buffer.subarray(0, count);
    transfer.hash.update(data);
    transfer.remaining -= count;
    transfer.offset += count;
    const last = transfer.remaining === 0 || count === 0;
    return { status: "chunk", seq, data: data.toString("base64"), last, ...(last ? { digest: transfer.hash.digest("hex") } : {}) };
  }
  function writeTransfer(transfer: Transfer, request: Extract<Machine.FsStreamRequest, { op: "write" }>): Machine.FsStreamResult {
    const data = Buffer.from(request.data, "base64");
    if (data.length > Machine.FS_WRITE_MAX_BYTES) return streamRefused("too_large");
    if (request.last !== (request.digest !== undefined)) return streamRefused("digest_mismatch");
    const digest = transfer.hash.copy().update(data).digest("hex");
    if (request.last && digest !== request.digest) return streamRefused("digest_mismatch");
    let written = 0;
    while (written < data.length) written += writeSync(transfer.fd, data, written, data.length - written, transfer.offset + written);
    transfer.offset += written;
    transfer.hash.update(data);
    return { status: "written", seq: request.seq, bytesWritten: transfer.offset, last: request.last };
  }
  function streamChunk(request: Extract<Machine.FsStreamRequest, { op: "read" | "write" }>): Machine.FsStreamResult {
    const transfer = transfers.get(request.transferId);
    if (transfer === undefined) return streamRefused("transfer_not_found");
    const key = JSON.stringify(request);
    if (request.seq === transfer.seq - 1 && transfer.last?.request === key) return transfer.last.result;
    if (request.seq !== transfer.seq || transfer.mode !== request.op || transfer.last?.result.status === "chunk" && transfer.last.result.last || transfer.last?.result.status === "written" && transfer.last.result.last) return streamRefused("invalid_sequence");
    const result = request.op === "read" ? readTransfer(transfer, request.seq) : writeTransfer(transfer, request);
    if (result.status === "refused") return result;
    transfer.last = { request: key, result };
    transfer.seq += 1;
    return result;
  }
  function abortTransfer(transferId: string): Machine.FsStreamResult {
    const transfer = transfers.get(transferId);
    if (transfer !== undefined) {
      transfers.delete(transferId);
      releaseTransfer(transfer);
    }
    return { status: "finished" };
  }
  function finishTransfer(transferId: string): Machine.FsStreamResult {
    const transfer = transfers.get(transferId);
    if (transfer === undefined) return streamRefused("transfer_not_found");
    const terminal = transfer.last?.result;
    if (terminal?.status !== "chunk" && terminal?.status !== "written" || !terminal.last)
      return streamRefused("invalid_sequence");
    transfers.delete(transferId);
    let published = false;
    try {
      const destination = transfer.destination;
      if (destination !== undefined) {
        fsyncSync(transfer.fd);
        if (libc.symbols.renameat(destination.dirfd, cString(destination.tempName), destination.dirfd, cString(destination.targetName)) !== 0)
          return streamRefused("io_error");
        published = true;
      }
      return { status: "finished" };
    } finally {
      releaseTransfer(transfer, published);
    }
  }
  function executeStream(request: Machine.FsStreamRequest): Machine.FsStreamResult {
    if (request.op === "begin") return streamBegin(request);
    if (request.op === "abort") return abortTransfer(request.transferId);
    if (request.op === "finish") return finishTransfer(request.transferId);
    return streamChunk(request);
  }
  function performTarget(request: Machine.FsRequest, target: OpenedTarget, data: Buffer | undefined, shown: string): Machine.FsResult {
    try {
      if (data !== undefined) return executeWrite(target, data, shown);
      if (request.op === "read") return executeRead(target, request, shown);
      if (request.op === "list") return executeList(target, testHooks);
      return executeStat(target);
    } finally {
      closeSync(target.fd);
    }
  }

  function executeRequest(request: Machine.FsRequest): Machine.FsResult {
    const root = roots.get(request.export);
    if (root === undefined) {
      return refused("export_not_available", `export is not available: ${request.export}`);
    }

    const shown = displayPath(request.path);
    const segments = requestSegments(request.path);
    if (segments === undefined) {
      return refused("path_escapes_export", `path escapes export: ${shown}`);
    }

    const data = request.op === "write" ? Buffer.from(request.data, "base64") : undefined;
    if (data !== undefined && data.length > Machine.FS_WRITE_MAX_BYTES) {
      return refused("too_large", "write exceeds socket byte cap");
    }
    const target = walk(
      root,
      segments,
      request.op === "list",
      request.op === "stat",
      shown,
      openFlags(request.op),
      testHooks,
    );

    if (isRefusal(target)) return target;

    return performTarget(request, target, data, shown);
  }
  const driver = (request: Machine.FsRequest): Effect.Effect<Machine.FsResult, MachineError> => Effect.try({ try: () => executeRequest(request), catch: decodeMachineFailure("fs.operation") }).pipe(Effect.mapError((error) => new FilesystemFailure({ operation: "fs.operation", message: `filesystem operation failed for: ${displayPath(request.path)}`, cause: String(error) })));

  driver.stream = (request: Machine.FsStreamRequest) => Effect.try({ try: () => executeStream(request), catch: decodeMachineFailure("fs.stream") });
  driver.modeOf = (transferId: string) => transfers.get(transferId)?.mode;
  driver.abortAll = () => Effect.try({ try: clearTransfers, catch: decodeMachineFailure("fs.abortAll") });
  driver.close = () => Effect.try({ try: () => {
    if (closed) return;
    closed = true;
    clearTransfers();
    for (const root of roots.values()) closeRootDescriptor(testHooks, root.fd);
    roots.clear();
  }, catch: decodeMachineFailure("fs.close") });
  return driver;
  }, catch: decodeMachineFailure("fs.open") });
}
