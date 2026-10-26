import { canonicalDigest } from "@oni/protocol";

/**
 * Per-project checkpoints over synced project files. A checkpoint records a
 * change set against its parent; its identity digests the project, its
 * position, its parent and its changes, so the same content in two projects
 * never shares an identity and a history is verified by replaying it.
 *
 * Paths here are manifest keys, never filesystem paths: the confinement of
 * real files stays the machine fs policy's, and this module only refuses keys
 * that are not one canonical relative spelling.
 */

export type SyncErrorCode =
  | "path_rejected"
  | "invalid_change"
  | "checkpoint_broken"
  | "limit_exceeded"
  | "missing"
  | "corrupt"
  | "not_found";

export class SyncError extends Error {
  readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode, message: string) {
    super(message);
    this.name = "SyncError";
    this.code = code;
  }
}

const MAX_PATH_LENGTH = 4096;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Accept only a canonical relative key: no root, no empty, dot or parent segment. */
export function syncPath(raw: string): string {
  const malformed =
    raw.length === 0 ||
    raw.length > MAX_PATH_LENGTH ||
    raw.startsWith("/") ||
    raw.includes("\\") ||
    raw.includes("\0");
  if (malformed || raw.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new SyncError("path_rejected", `sync path ${JSON.stringify(raw)} is not a canonical relative path`);
  }
  return raw;
}

export function isContentDigest(digest: string): boolean {
  return DIGEST_PATTERN.test(digest);
}

export function isByteSize(size: number): boolean {
  return Number.isSafeInteger(size) && size >= 0;
}

interface ManifestEntry {
  readonly digest: string;
  readonly size: number;
}

export type Manifest = ReadonlyMap<string, ManifestEntry>;

export type SyncChange =
  | { readonly path: string; readonly digest: string; readonly size: number }
  | { readonly path: string; readonly removed: true };

export interface Checkpoint {
  readonly id: string;
  readonly projectId: string;
  readonly sequence: number;
  readonly parent: string | null;
  readonly changes: readonly SyncChange[];
}

export interface CheckpointState {
  readonly checkpoint: Checkpoint;
  readonly manifest: Manifest;
}

function applyChange(manifest: Map<string, ManifestEntry>, change: SyncChange): void {
  const path = syncPath(change.path);
  if ("removed" in change) {
    if (!manifest.delete(path)) {
      throw new SyncError("invalid_change", `cannot remove ${path}: it is not synced`);
    }
    return;
  }
  if (!(isContentDigest(change.digest) && isByteSize(change.size))) {
    throw new SyncError("invalid_change", `change for ${path} has a malformed digest or size`);
  }
  manifest.set(path, { digest: change.digest, size: change.size });
}

function canonicalChanges(changes: readonly SyncChange[]): readonly SyncChange[] {
  const sorted = [...changes].sort((left, right) => (left.path < right.path ? -1 : 1));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]?.path === sorted[index]?.path) {
      throw new SyncError("invalid_change", `change set names ${sorted[index]?.path} twice`);
    }
  }
  return sorted.map((change) =>
    "removed" in change
      ? { path: change.path, removed: true }
      : { path: change.path, digest: change.digest, size: change.size },
  );
}

/** Commit one change set on top of `head` (or as the project's first checkpoint). */
export function commitCheckpoint(
  projectId: string,
  head: CheckpointState | undefined,
  changes: readonly SyncChange[],
): CheckpointState {
  if (projectId.length === 0) {
    throw new SyncError("invalid_change", "a checkpoint needs a project id");
  }
  if (head !== undefined && head.checkpoint.projectId !== projectId) {
    throw new SyncError("checkpoint_broken", `head belongs to project ${head.checkpoint.projectId}, not ${projectId}`);
  }
  const ordered = canonicalChanges(changes);
  const manifest = new Map(head?.manifest);
  for (const change of ordered) applyChange(manifest, change);
  const sequence = (head?.checkpoint.sequence ?? 0) + 1;
  const parent = head?.checkpoint.id ?? null;
  const id = canonicalDigest({ projectId, sequence, parent, changes: ordered });
  return { checkpoint: { id, projectId, sequence, parent, changes: ordered }, manifest };
}

/** Rebuild a project's state from its full history, refusing any break in the chain. */
export function replayCheckpoints(projectId: string, history: readonly Checkpoint[]): CheckpointState {
  let state: CheckpointState | undefined;
  for (const recorded of history) {
    const expectedParent = state?.checkpoint.id ?? null;
    if (recorded.projectId !== projectId || recorded.parent !== expectedParent) {
      throw new SyncError("checkpoint_broken", `checkpoint ${recorded.id} does not extend ${expectedParent ?? "the project root"} of ${projectId}`);
    }
    const next = commitCheckpoint(projectId, state, recorded.changes);
    if (next.checkpoint.id !== recorded.id || next.checkpoint.sequence !== recorded.sequence) {
      throw new SyncError("checkpoint_broken", `checkpoint ${recorded.id} does not match its replayed identity ${next.checkpoint.id}`);
    }
    state = next;
  }
  if (state === undefined) {
    throw new SyncError("checkpoint_broken", `project ${projectId} has no checkpoints to replay`);
  }
  return state;
}
