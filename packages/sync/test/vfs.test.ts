import { describe, expect, test } from "bun:test";
import { blobDigest, type BlobSource, commitCheckpoint, createSyncVfs, MemoryBundleStore, replayCheckpoints } from "@oni/sync";
import { code } from "./sync-error.js";

const text = (value: string) => new TextEncoder().encode(value);

function fixture() {
  const store = new MemoryBundleStore({ maxEntries: 8, maxBytes: 64 });
  const files = [
    { path: "README.md", bytes: text("hi") },
    { path: "src/lib/a.ts", bytes: text("a") },
    { path: "src/main.ts", bytes: text("main") },
  ];
  store.publish(files);
  const head = commitCheckpoint(
    "project-1",
    undefined,
    files.map((file) => ({ path: file.path, digest: blobDigest(file.bytes), size: file.bytes.byteLength })),
  );
  const state = replayCheckpoints("project-1", [head.checkpoint]);
  return { store, manifest: state.manifest, vfs: createSyncVfs(state.manifest, store) };
}

describe("read-only sync vfs", () => {
  test("reads, stats and lists only synced files", () => {
    const { vfs } = fixture();
    expect(new TextDecoder().decode(vfs.read("src/main.ts"))).toBe("main");
    expect(vfs.stat("src/main.ts")).toEqual({ path: "src/main.ts", kind: "file", size: 4 });
    expect(vfs.stat("src")).toEqual({ path: "src", kind: "directory", size: 0 });
    expect(vfs.list("")).toEqual(["README.md", "src"]);
    expect(vfs.list("src")).toEqual(["lib", "main.ts"]);
    expect(code(() => vfs.read("src/missing.ts"))).toBe("not_found");
    expect(code(() => vfs.stat("nope"))).toBe("not_found");
    expect(code(() => vfs.list("README.md"))).toBe("not_found");
  });

  test("rejects traversal before any lookup", () => {
    const { vfs } = fixture();
    for (const path of ["../etc/passwd", "/etc/passwd", "src/../../x", "src/./main.ts"]) {
      expect(code(() => vfs.read(path))).toBe("path_rejected");
      expect(code(() => vfs.stat(path))).toBe("path_rejected");
      expect(code(() => vfs.list(path))).toBe("path_rejected");
    }
  });

  test("exposes no mutation and isolates callers from content and manifest", () => {
    const { vfs, manifest, store } = fixture();
    expect(Object.keys(vfs).sort()).toEqual(["list", "read", "stat"]);
    expect(Object.isFrozen(vfs)).toBe(true);
    expect(() => Object.assign(vfs, { write: () => undefined })).toThrow(TypeError);
    vfs.read("README.md").fill(0);
    expect(new TextDecoder().decode(vfs.read("README.md"))).toBe("hi");
    if (manifest instanceof Map) manifest.delete("README.md");
    expect(vfs.stat("README.md").kind).toBe("file");
    expect(store.blob(blobDigest(text("hi")))).toEqual(text("hi"));
  });

  test("captures checkpoint entry values when the caller changes them", () => {
    const { manifest, store } = fixture();
    const vfs = createSyncVfs(manifest, store);
    const entry = manifest.get("README.md");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    Object.assign(entry, { digest: blobDigest(text("main")), size: 4 });
    expect(new TextDecoder().decode(vfs.read("README.md"))).toBe("hi");
    expect(vfs.stat("README.md").size).toBe(2);
  });

  test("refuses content that is missing or does not match the manifest", () => {
    const { manifest } = fixture();
    const empty: BlobSource = { blob: () => undefined };
    const lying: BlobSource = { blob: () => text("tampered") };
    expect(code(() => createSyncVfs(manifest, empty).read("README.md"))).toBe("missing");
    expect(code(() => createSyncVfs(manifest, lying).read("README.md"))).toBe("corrupt");
  });
});
