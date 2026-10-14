/**
 * #1497 media resolver: an image/file part's `ref` becomes bytes only at
 * delivery time, from an attached machine (the `read` tool's door) or an
 * https URL; anything else is a typed refusal before any channel call.
 */
import { expect, test } from "bun:test";
import {
  MEDIA_BYTE_CAP,
  MediaRefused,
  createMediaResolver,
  mediaMime,
} from "../src/composition/media";
import type { FilePorts } from "../src/bundles/tools/core/filesystem";

type ToolMachine = ReturnType<NonNullable<FilePorts["machines"]>["get"]>;

function machineWith(
  files: Record<string, Uint8Array>,
  chunk = Number.POSITIVE_INFINITY,
  reads: string[] = [],
  sizes: Record<string, number> = {},
): ToolMachine {
  const unsupported = () => Promise.reject(new Error("not under test"));
  return {
    fs: {
      read: (path: string, window?: { offset?: number }) => {
        reads.push(path);
        const data = files[path];
        if (data === undefined) return Promise.reject(new Error(`ENOENT ${path}`));
        const offset = window?.offset ?? 0;
        const slice = data.slice(offset, offset + chunk);
        return Promise.resolve({
          op: "read",
          data: slice,
          bytesRead: slice.byteLength,
          truncated: offset + slice.byteLength < data.byteLength,
        });
      },
      stat: (path: string) => {
        const data = files[path];
        if (data === undefined) return Promise.reject(new Error(`ENOENT ${path}`));
        return Promise.resolve({
          op: "stat",
          kind: "file",
          size: sizes[path] ?? data.byteLength,
          mtimeMs: 0,
        });
      },
      write: unsupported,
      list: unsupported,
    },
    exec: unsupported,
    pty: {
      open: unsupported,
      write: unsupported,
      resize: unsupported,
      close: unsupported,
      read: unsupported,
    },
  } as unknown as ToolMachine;
}

function ports(machine: ToolMachine, defaultMachine = "self"): FilePorts {
  return { machines: { defaultMachine, get: () => machine } };
}

type Resolve = ReturnType<typeof createMediaResolver>;
async function refusal(resolve: Resolve, part: Parameters<Resolve>[0]): Promise<string> {
  const error: unknown = await resolve(part).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(MediaRefused);
  return (error as MediaRefused).data.code;
}

test("a machine path is read whole through the daemon's bounded reads; name and mime follow the part or the path", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
  const resolve = createMediaResolver(
    ports(machineWith({ "/tmp/shot.png": png, "/tmp/report": png }, 4)),
  );
  expect(await resolve({ kind: "image", ref: "/tmp/shot.png" })).toEqual({
    bytes: png,
    name: "shot.png",
    mime: "image/png",
  });
  expect(
    await resolve({
      kind: "file",
      ref: "box:/tmp/report",
      name: "q3.pdf",
      mime: "application/pdf",
    }),
  ).toEqual({
    bytes: png,
    name: "q3.pdf",
    mime: "application/pdf",
  });
  expect(
    await resolve({ kind: "file", ref: "/tmp/report", name: "notes.unknownext" }),
  ).toMatchObject({ mime: "application/octet-stream" });
});

test("an oversize machine file is refused on stat, before any byte is read", async () => {
  const reads: string[] = [];
  const machine = machineWith({ "/tmp/huge.bin": new Uint8Array(1) }, 1, reads, {
    "/tmp/huge.bin": MEDIA_BYTE_CAP + 1,
  });
  const resolve = createMediaResolver(ports(machine));
  expect(await refusal(resolve, { kind: "file", ref: "/tmp/huge.bin", name: "huge.bin" })).toBe(
    "too_large",
  );
  expect(reads).toEqual([]);
});

test("an https URL is fetched; non-https schemes, private hosts, failed fetches and oversize bodies are typed refusals", async () => {
  const calls: string[] = [];
  const fetchImpl = ((input: URL) => {
    calls.push(input.href);
    if (input.pathname === "/missing") return Promise.resolve(new Response("", { status: 404 }));
    if (input.pathname === "/big")
      return Promise.resolve(
        new Response("x", { headers: { "content-length": String(MEDIA_BYTE_CAP + 1) } }),
      );
    return Promise.resolve(
      new Response(new Uint8Array([7, 8]), {
        headers: { "content-type": "image/webp; charset=binary" },
      }),
    );
  }) as unknown as typeof fetch;
  const resolve = createMediaResolver(ports(machineWith({})), fetchImpl);
  expect(await resolve({ kind: "image", ref: "https://cdn.test/pics/cat.webp?x=1" })).toEqual({
    bytes: new Uint8Array([7, 8]),
    name: "cat.webp",
    mime: "image/webp",
  });
  expect(await refusal(resolve, { kind: "image", ref: "http://cdn.test/cat.png" })).toBe("scheme");
  expect(await refusal(resolve, { kind: "image", ref: "ftp://cdn.test/cat.png" })).toBe("scheme");
  for (const host of [
    "localhost",
    "127.0.0.1",
    "10.1.2.3",
    "192.168.0.9",
    "172.16.5.5",
    "169.254.169.254",
    "[::1]",
    "[fd12::1]",
  ])
    expect(await refusal(resolve, { kind: "image", ref: `https://${host}/secret.png` })).toBe(
      "host",
    );
  expect(await refusal(resolve, { kind: "file", ref: "https://cdn.test/missing", name: "m" })).toBe(
    "fetch_failed",
  );
  expect(await refusal(resolve, { kind: "file", ref: "https://cdn.test/big", name: "b" })).toBe(
    "too_large",
  );
  expect(calls).toEqual([
    "https://cdn.test/pics/cat.webp?x=1",
    "https://cdn.test/missing",
    "https://cdn.test/big",
  ]);
});

test("a streamed body with no content-length stops at the cap instead of buffering whole", async () => {
  let pulled = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(chunk);
    },
  });
  const fetchImpl = (() => Promise.resolve(new Response(endless))) as unknown as typeof fetch;
  const resolve = createMediaResolver(ports(machineWith({})), fetchImpl);
  expect(await refusal(resolve, { kind: "file", ref: "https://cdn.test/stream", name: "s" })).toBe(
    "too_large",
  );
  expect(pulled).toBeLessThanOrEqual(MEDIA_BYTE_CAP / chunk.byteLength + 2);
});

test("redirects are followed hop by hop with every hop admitted; the final hop names the download", async () => {
  const calls: { href: string; redirect: RequestInit["redirect"] }[] = [];
  const fetchImpl = ((input: URL, init?: RequestInit) => {
    calls.push({ href: input.href, redirect: init?.redirect });
    switch (input.pathname) {
      case "/start":
        return Promise.resolve(Response.redirect("https://cdn.test/hop/final.gif", 302));
      case "/to-http":
        return Promise.resolve(Response.redirect("http://cdn.test/x.png", 301));
      case "/to-private":
        return Promise.resolve(Response.redirect("https://169.254.169.254/latest", 307));
      case "/loop":
        return Promise.resolve(Response.redirect("https://cdn.test/loop", 302));
      default:
        return Promise.resolve(
          new Response(new Uint8Array([1]), { headers: { "content-type": "image/gif" } }),
        );
    }
  }) as unknown as typeof fetch;
  const resolve = createMediaResolver(ports(machineWith({})), fetchImpl);
  expect(await resolve({ kind: "image", ref: "https://cdn.test/start" })).toEqual({
    bytes: new Uint8Array([1]),
    name: "final.gif",
    mime: "image/gif",
  });
  expect(await refusal(resolve, { kind: "image", ref: "https://cdn.test/to-http" })).toBe("scheme");
  expect(await refusal(resolve, { kind: "image", ref: "https://cdn.test/to-private" })).toBe(
    "host",
  );
  expect(await refusal(resolve, { kind: "image", ref: "https://cdn.test/loop" })).toBe(
    "fetch_failed",
  );
  expect(calls.every((call) => call.redirect === "manual")).toBe(true);
  expect(calls.map((call) => call.href).filter((href) => href.endsWith("/loop"))).toHaveLength(4);
  expect(calls.map((call) => call.href)).not.toContain("http://cdn.test/x.png");
  expect(calls.map((call) => call.href)).not.toContain("https://169.254.169.254/latest");
});

test("mime follows the extension table and falls back to octet-stream", () => {
  expect(mediaMime("a.JPG")).toBe("image/jpeg");
  expect(mediaMime("archive.tar.gz")).toBe("application/gzip");
  expect(mediaMime("noext")).toBe("application/octet-stream");
});
