import { createHash } from "node:crypto";
import { canonicalDigest } from "@oni/protocol";
import { isByteSize, isContentDigest, SyncError, syncPath } from "./checkpoints";

/**
 * Bounded, content-addressed artifact bundles. A bundle names its files by
 * path and blob digest; its own digest covers that entry list, so a host that
 * fetches a bundle through an injected `BundleSource` verifies every byte it
 * receives instead of trusting the source.
 */

export function blobDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export interface BlobSource {
  blob(digest: string): Uint8Array | undefined;
}

interface BundleEntry {
  readonly path: string;
  readonly digest: string;
  readonly size: number;
}

export interface ArtifactBundle {
  readonly digest: string;
  readonly entries: readonly BundleEntry[];
  readonly totalBytes: number;
}

/** The port a host fetches through; the app binds it to whatever carries bundles. */
export interface BundleSource extends BlobSource {
  bundle(digest: string): ArtifactBundle | undefined;
}

export interface BundleLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export interface SyncFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface FetchedBundle {
  readonly bundle: ArtifactBundle;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

function bundleDigest(entries: readonly BundleEntry[]): string {
  return canonicalDigest({ entries: entries.map(({ path, digest, size }) => ({ path, digest, size })) });
}

function enforceLimits(entryCount: number, totalBytes: number, limits: BundleLimits): void {
  if (entryCount > limits.maxEntries || totalBytes > limits.maxBytes) {
    throw new SyncError(
      "limit_exceeded",
      `bundle of ${entryCount} entries and ${totalBytes} bytes exceeds ${limits.maxEntries} entries / ${limits.maxBytes} bytes`,
    );
  }
}

function copyBundle(bundle: ArtifactBundle): ArtifactBundle {
  return { ...bundle, entries: bundle.entries.map((entry) => ({ ...entry })) };
}

/** In-memory bundle store: the reference `BundleSource` and the publishing side. */
export class MemoryBundleStore implements BundleSource {
  readonly #blobs = new Map<string, Uint8Array>();
  readonly #bundles = new Map<string, ArtifactBundle>();
  readonly #limits: BundleLimits;

  constructor(limits: BundleLimits) {
    this.#limits = limits;
  }

  blob(digest: string): Uint8Array | undefined {
    return this.#blobs.get(digest)?.slice();
  }

  bundle(digest: string): ArtifactBundle | undefined {
    const bundle = this.#bundles.get(digest);
    return bundle === undefined ? undefined : copyBundle(bundle);
  }

  /** Store each file's blob and the bundle that names them; refuses oversize or duplicate input. */
  publish(files: readonly SyncFile[]): ArtifactBundle {
    const totalBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    enforceLimits(files.length, totalBytes, this.#limits);
    const blobs = files.map((file) => ({ path: syncPath(file.path), digest: blobDigest(file.bytes), bytes: file.bytes.slice() }));
    const entries = blobs
      .map(({ path, digest, bytes }) => ({ path, digest, size: bytes.byteLength }))
      .sort((left, right) => (left.path < right.path ? -1 : 1));
    if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
      throw new SyncError("invalid_change", "bundle names one path twice");
    }
    for (const { digest, bytes } of blobs) this.#blobs.set(digest, bytes);
    const bundle = { digest: bundleDigest(entries), entries, totalBytes };
    this.#bundles.set(bundle.digest, bundle);
    return copyBundle(bundle);
  }
}

function verifiedEntry(source: BlobSource, entry: BundleEntry): Uint8Array {
  syncPath(entry.path);
  if (!(isContentDigest(entry.digest) && isByteSize(entry.size))) {
    throw new SyncError("corrupt", `bundle entry ${entry.path} has a malformed digest or size`);
  }
  const bytes = source.blob(entry.digest);
  if (bytes === undefined) {
    throw new SyncError("missing", `blob ${entry.digest} for ${entry.path} is not available`);
  }
  if (bytes.byteLength !== entry.size || blobDigest(bytes) !== entry.digest) {
    throw new SyncError("corrupt", `blob for ${entry.path} does not match ${entry.digest}`);
  }
  return bytes.slice();
}

/** Fetch one bundle by digest and verify identity, bounds and every blob before returning it. */
export function fetchBundle(source: BundleSource, digest: string, limits: BundleLimits): FetchedBundle {
  const bundle = source.bundle(digest);
  if (bundle === undefined) {
    throw new SyncError("missing", `bundle ${digest} is not available`);
  }
  if (bundleDigest(bundle.entries) !== digest || bundle.digest !== digest) {
    throw new SyncError("corrupt", `bundle ${digest} does not hash to its own identity`);
  }
  const declaredBytes = bundle.entries.reduce((sum, entry) => sum + entry.size, 0);
  enforceLimits(bundle.entries.length, Math.max(declaredBytes, bundle.totalBytes), limits);
  if (declaredBytes !== bundle.totalBytes) {
    throw new SyncError("corrupt", `bundle ${digest} declares ${bundle.totalBytes} bytes but its entries sum to ${declaredBytes}`);
  }
  const files = new Map<string, Uint8Array>();
  for (const entry of bundle.entries) {
    if (files.has(entry.path)) {
      throw new SyncError("corrupt", `bundle ${digest} names ${entry.path} twice`);
    }
    files.set(entry.path, verifiedEntry(source, entry));
  }
  return { bundle, files };
}
