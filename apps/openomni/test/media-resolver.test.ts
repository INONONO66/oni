/**
 * #1497 media resolver: an image/file part's `ref` becomes bytes only at
 * delivery time, from an attached machine (the `read` tool's door) or an
 * https URL; anything else is a typed refusal before any channel call.
 */
import { expect, test } from "bun:test";
import { MEDIA_BYTE_CAP, MediaRefused, createMediaResolver, mediaMime } from "../src/composition/media";
import type { FilePorts } from "../src/bundles/tools/core/filesystem";

type ToolMachine = ReturnType<NonNullable<FilePorts["machines"]>["get"]>;

function machineWith(files: Record<string, Uint8Array>, chunk = Number.POSITIVE_INFINITY): ToolMachine {
  const unsupported = () => Promise.reject(new Error("not under test"));
  return {
    fs: {
      read: (path: string, window?: { offset?: number }) => {
        const data = files[path];
        if (data === undefined) return Promise.reject(new Error(`ENOENT ${path}`));
        const offset = window?.offset ?? 0;
        const slice = data.slice(offset, offset + chunk);
        return Promise.resolve({ op: "read", data: slice, bytesRead: slice.byteLength, truncated: offset + slice.byteLength < data.byteLength });
      },
      write: unsupported,
      list: unsupported,
      stat: unsupported,
    },
    exec: unsupported,
    pty: { open: unsupported, write: unsupported, resize: unsupported, close: unsupported, read: unsupported },
  } as unknown as ToolMachine;
}

function ports(machine: ToolMachine, defaultMachine = "self"): FilePorts {
  return { machines: { defaultMachine, get: () => machine } };
}

test("a machine path is read whole through the daemon's bounded reads; name and mime follow the part or the path", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
  const resolve = createMediaResolver(ports(machineWith({ "/tmp/shot.png": png, "/tmp/report": png }, 4)));
  expect(await resolve({ kind: "image", ref: "/tmp/shot.png" })).toEqual({ bytes: png, name: "shot.png", mime: "image/png" });
  expect(await resolve({ kind: "file", ref: "box:/tmp/report", name: "q3.pdf", mime: "application/pdf" })).toEqual({
    bytes: png,
    name: "q3.pdf",
    mime: "application/pdf",
  });
  expect(await resolve({ kind: "file", ref: "/tmp/report", name: "notes.unknownext" })).toMatchObject({ mime: "application/octet-stream" });
});

test("an https URL is fetched; non-https schemes, failed fetches and oversize bodies are typed refusals", async () => {
  const calls: string[] = [];
  const fetchImpl = ((input: URL) => {
    calls.push(input.href);
    if (input.pathname === "/missing") return Promise.resolve(new Response("", { status: 404 }));
    if (input.pathname === "/big")
      return Promise.resolve(new Response("x", { headers: { "content-length": String(MEDIA_BYTE_CAP + 1) } }));
    return Promise.resolve(new Response(new Uint8Array([7, 8]), { headers: { "content-type": "image/webp; charset=binary" } }));
  }) as unknown as typeof fetch;
  const resolve = createMediaResolver(ports(machineWith({})), fetchImpl);
  expect(await resolve({ kind: "image", ref: "https://cdn.test/pics/cat.webp?x=1" })).toEqual({
    bytes: new Uint8Array([7, 8]),
    name: "cat.webp",
    mime: "image/webp",
  });
  const refusal = async (part: Parameters<typeof resolve>[0]) => {
    const error: unknown = await resolve(part).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MediaRefused);
    return (error as MediaRefused).data.code;
  };
  expect(await refusal({ kind: "image", ref: "http://cdn.test/cat.png" })).toBe("scheme");
  expect(await refusal({ kind: "image", ref: "ftp://cdn.test/cat.png" })).toBe("scheme");
  expect(await refusal({ kind: "file", ref: "https://cdn.test/missing", name: "m" })).toBe("fetch_failed");
  expect(await refusal({ kind: "file", ref: "https://cdn.test/big", name: "b" })).toBe("too_large");
  expect(calls).toEqual(["https://cdn.test/pics/cat.webp?x=1", "https://cdn.test/missing", "https://cdn.test/big"]);
});

test("mime follows the extension table and falls back to octet-stream", () => {
  expect(mediaMime("a.JPG")).toBe("image/jpeg");
  expect(mediaMime("archive.tar.gz")).toBe("application/gzip");
  expect(mediaMime("noext")).toBe("application/octet-stream");
});
