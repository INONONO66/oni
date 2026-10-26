import { blobDigest, type BlobSource } from "./bundles";
import { type Manifest, SyncError, syncPath } from "./checkpoints";

/**
 * A read-only view over one checkpoint's synced files. It resolves manifest
 * keys only, never the host filesystem, and exposes no mutating operation:
 * every change goes through a new checkpoint.
 */

interface SyncVfsStat {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size: number;
}

export interface SyncVfs {
  read(path: string): Uint8Array;
  stat(path: string): SyncVfsStat;
  list(directory: string): readonly string[];
}

const ROOT = "";

function directoryKey(directory: string): string {
  return directory === ROOT ? ROOT : syncPath(directory);
}

function childrenOf(manifest: Manifest, directory: string): readonly string[] {
  const prefix = directory === ROOT ? ROOT : `${directory}/`;
  const names = new Set<string>();
  for (const path of manifest.keys()) {
    if (path.startsWith(prefix)) names.add(path.slice(prefix.length).split("/")[0] ?? "");
  }
  return [...names].sort();
}

export function createSyncVfs(manifest: Manifest, blobs: BlobSource): SyncVfs {
  const view = new Map([...manifest].map(([path, entry]) => [
    path,
    { digest: entry.digest, size: entry.size },
  ] as const));
  return Object.freeze({
    read(path: string): Uint8Array {
      const key = syncPath(path);
      const entry = view.get(key);
      if (entry === undefined) {
        throw new SyncError("not_found", `${key} is not a synced file`);
      }
      const bytes = blobs.blob(entry.digest);
      if (bytes === undefined) {
        throw new SyncError("missing", `content ${entry.digest} for ${key} is not available`);
      }
      if (blobDigest(bytes) !== entry.digest) {
        throw new SyncError("corrupt", `content for ${key} does not match ${entry.digest}`);
      }
      return bytes.slice();
    },
    stat(path: string): SyncVfsStat {
      const key = syncPath(path);
      const entry = view.get(key);
      if (entry !== undefined) return { path: key, kind: "file", size: entry.size };
      if (childrenOf(view, key).length > 0) return { path: key, kind: "directory", size: 0 };
      throw new SyncError("not_found", `${key} is not synced`);
    },
    list(directory: string): readonly string[] {
      const key = directoryKey(directory);
      const names = childrenOf(view, key);
      if (names.length === 0 && key !== ROOT) {
        throw new SyncError("not_found", `${key} is not a synced directory`);
      }
      return names;
    },
  });
}
