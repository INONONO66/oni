import { describe, expect, test } from "bun:test";
import { canonicalDigest } from "@oni/protocol";
import {
  type ArtifactBundle,
  blobDigest,
  type BundleSource,
  fetchBundle,
  MemoryBundleStore,
} from "@oni/sync";
import { code } from "./sync-error.js";

const LIMITS = { maxEntries: 4, maxBytes: 64 };
type BundleEntryLike = { path: string; digest: string; size: number };
const text = (value: string) => new TextEncoder().encode(value);

function published() {
  const store = new MemoryBundleStore(LIMITS);
  const bundle = store.publish([
    { path: "out/b.txt", bytes: text("bb") },
    { path: "out/a.txt", bytes: text("a") },
  ]);
  return { store, bundle };
}

/** A source that serves a doctored bundle record or blob over the honest store. */
function doctored(
  store: MemoryBundleStore,
  bundle: (honest: ArtifactBundle) => ArtifactBundle,
  blob: (digest: string, honest: Uint8Array | undefined) => Uint8Array | undefined = (_, honest) => honest,
): BundleSource {
  return {
    bundle: (digest) => {
      const honest = store.bundle(digest);
      return honest === undefined ? undefined : bundle(honest);
    },
    blob: (digest) => blob(digest, store.blob(digest)),
  };
}

describe("artifact bundles", () => {
  test("publish is content-addressed and fetch returns verified copies", () => {
    const { store, bundle } = published();
    expect(bundle.entries.map((entry) => entry.path)).toEqual(["out/a.txt", "out/b.txt"]);
    expect(bundle.totalBytes).toBe(3);
    expect(new MemoryBundleStore(LIMITS).publish([
      { path: "out/a.txt", bytes: text("a") },
      { path: "out/b.txt", bytes: text("bb") },
    ]).digest).toBe(bundle.digest);
    const fetched = fetchBundle(store, bundle.digest, LIMITS);
    expect(new TextDecoder().decode(fetched.files.get("out/b.txt"))).toBe("bb");
    fetched.files.get("out/a.txt")?.fill(0);
    expect(store.blob(blobDigest(text("a")))).toEqual(text("a"));
  });

  test("the store hands out copies, so callers cannot rewrite what it serves", () => {
    const { store, bundle } = published();
    const digest = blobDigest(text("a"));
    store.blob(digest)?.fill(0);
    const [entry] = bundle.entries as BundleEntryLike[];
    if (entry !== undefined) entry.size = 99;
    const served = store.bundle(bundle.digest) as { entries: BundleEntryLike[]; totalBytes: number } | undefined;
    served?.entries.pop();
    if (served !== undefined) served.totalBytes = 0;
    expect(store.blob(digest)).toEqual(text("a"));
    expect(fetchBundle(store, bundle.digest, LIMITS).files.get("out/a.txt")).toEqual(text("a"));
  });

  test("publish enforces bounds, paths and uniqueness", () => {
    const store = new MemoryBundleStore(LIMITS);
    expect(code(() => store.publish([{ path: "big", bytes: new Uint8Array(65) }]))).toBe("limit_exceeded");
    const many = ["a", "b", "c", "d", "e"].map((path) => ({ path, bytes: text(path) }));
    expect(code(() => store.publish(many))).toBe("limit_exceeded");
    expect(code(() => store.publish([{ path: "../escape", bytes: text("x") }]))).toBe("path_rejected");
    const twice = [
      { path: "same", bytes: text("1") },
      { path: "same", bytes: text("2") },
    ];
    expect(code(() => store.publish(twice))).toBe("invalid_change");
  });

  test("fetch refuses missing, forged, oversize and corrupted bundles", () => {
    const { store, bundle } = published();
    const [first, second] = bundle.entries;
    if (first === undefined || second === undefined) throw new Error("entries");
    expect(code(() => fetchBundle(store, blobDigest(text("nope")), LIMITS))).toBe("missing");
    expect(code(() => fetchBundle(doctored(store, (b) => ({ ...b, entries: [first] })), bundle.digest, LIMITS))).toBe("corrupt");
    expect(code(() => fetchBundle(doctored(store, (b) => ({ ...b, digest: blobDigest(text("x")) })), bundle.digest, LIMITS))).toBe("corrupt");
    expect(code(() => fetchBundle(store, bundle.digest, { maxEntries: 1, maxBytes: 64 }))).toBe("limit_exceeded");
    expect(code(() => fetchBundle(doctored(store, (b) => ({ ...b, totalBytes: 999 })), bundle.digest, LIMITS))).toBe("limit_exceeded");
    expect(code(() => fetchBundle(doctored(store, (b) => ({ ...b, totalBytes: 2 })), bundle.digest, LIMITS))).toBe("corrupt");
    expect(code(() => fetchBundle(doctored(store, (b) => b, () => undefined), bundle.digest, LIMITS))).toBe("missing");
    expect(code(() => fetchBundle(doctored(store, (b) => b, () => text("zz")), bundle.digest, LIMITS))).toBe("corrupt");
  });

  test("fetch re-checks entry paths, digests and duplicates even when the record hashes", () => {
    const blobs = new MemoryBundleStore(LIMITS);
    blobs.publish([{ path: "a", bytes: text("a") }]);
    const forged = (entries: ArtifactBundle["entries"]) => {
      const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
      const digest = canonicalDigest({ entries: entries.map(({ path, digest: d, size }) => ({ path, digest: d, size })) });
      const source: BundleSource = { bundle: () => ({ digest, entries, totalBytes }), blob: (d) => blobs.blob(d) };
      return () => fetchBundle(source, digest, LIMITS);
    };
    const a = { path: "a", digest: blobDigest(text("a")), size: 1 };
    expect(forged([a])().files.size).toBe(1);
    expect(code(forged([{ ...a, path: "../a" }]))).toBe("path_rejected");
    expect(code(forged([{ ...a, digest: "md5:x" }]))).toBe("corrupt");
    expect(code(forged([a, a]))).toBe("corrupt");
  });
});
