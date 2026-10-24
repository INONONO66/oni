/**
 * #1497 media resolver: an outbound media part's `ref` becomes bytes only at
 * delivery time, from an attached machine (the `read` tool's door) or an
 * https URL; anything else is a typed refusal before any channel call.
 */
import { expect, spyOn, test } from "bun:test";
import {
  MEDIA_BYTE_CAP,
  type MediaFetch,
  type MediaLookup,
  MediaRefused,
  createMediaResolver,
  mediaMime,
} from "../src/composition/media";
import type { FilePorts } from "../src/bundles/tools/core/filesystem";
import { eventSignal } from "./helpers/event-signal";

type ToolMachine = ReturnType<NonNullable<FilePorts["machines"]>["get"]>;

function machineWith(
  files: Record<string, Uint8Array>,
  chunk = Number.POSITIVE_INFINITY,
  reads: string[] = [],
  sizes: Record<string, number> = {},
): ToolMachine {
  const unsupported = () => Promise.reject(new Error("not under test"));
  const machine: ToolMachine = {
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
          size: sizes[path] ?? data.byteLength,
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
      read: unsupported,
    },
  };
  return machine;
}

function ports(machine: ToolMachine, defaultMachine = "self"): FilePorts {
  return { machines: { defaultMachine, get: () => machine } };
}

const RESOLVED: Readonly<Record<string, readonly string[]>> = {
  "cdn.test": ["93.184.216.34"],
  "dual.test": ["2606:4700::1", "93.184.216.34"],
  "v6.test": ["2606:4700::1"],
  localhost: ["::1", "127.0.0.1"],
  "rebind.test": ["10.0.0.7"],
  "mixed.test": ["93.184.216.34", "192.168.1.1"],
  "mapped.test": ["::ffff:7f00:1"],
  "tailnet.test": ["100.100.1.2"],
  "empty.test": [],
};
const lookupTable: MediaLookup = (hostname) => {
  const addresses = RESOLVED[hostname];
  return addresses === undefined
    ? Promise.reject(new Error(`ENOTFOUND ${hostname}`))
    : Promise.resolve(addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
};

type Resolve = ReturnType<typeof createMediaResolver>;
async function refusal(resolve: Resolve, part: Parameters<Resolve>[0]): Promise<string> {
  const error = await resolve(part).then(() => undefined, (caught: Error) => caught);
  expect(error).toBeInstanceOf(MediaRefused);
  if (!(error instanceof MediaRefused)) throw new Error("expected a media refusal");
  return error.data.code;
}

test("a machine path is read whole through the daemon's bounded reads; name and mime follow the part or the path", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
  const resolve = createMediaResolver(
    ports(machineWith({ "/tmp/shot.png": png, "/tmp/report": png, "/tmp/note.m4a": png }, 4)),
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
  expect(
    await resolve({
      kind: "audio",
      ref: "box:/tmp/note.m4a",
      name: "voice.bin",
      mime: "audio/ogg",
    }),
  ).toEqual({
    bytes: png,
    name: "voice.bin",
    mime: "audio/ogg",
  });
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
  const fetchImpl: MediaFetch = (input) => {
    calls.push(input.href);
    if (input.pathname === "/missing") return Promise.resolve(new Response("", { status: 404 }));
    if (input.pathname === "/big")
      return Promise.resolve(
        new Response("x", { headers: { "content-length": String(MEDIA_BYTE_CAP + 1) } }),
      );
    if (input.pathname === "/clips/demo.mov")
      return Promise.resolve(
        new Response(new Uint8Array([9]), { headers: { "content-type": "video/quicktime" } }),
      );
    return Promise.resolve(
      new Response(new Uint8Array([7, 8]), {
        headers: { "content-type": "image/webp; charset=binary" },
      }),
    );
  };
  const resolve = createMediaResolver(ports(machineWith({})), fetchImpl, lookupTable);
  expect(await resolve({ kind: "image", ref: "https://cdn.test/pics/cat.webp?x=1" })).toEqual({
    bytes: new Uint8Array([7, 8]),
    name: "cat.webp",
    mime: "image/webp",
  });
  expect(await resolve({ kind: "video", ref: "https://cdn.test/clips/demo.mov" })).toEqual({
    bytes: new Uint8Array([9]),
    name: "demo.mov",
    mime: "video/quicktime",
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
    "https://cdn.test/clips/demo.mov",
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
  const fetchImpl: MediaFetch = () => Promise.resolve(new Response(endless));
  const resolve = createMediaResolver(ports(machineWith({})), fetchImpl, lookupTable);
  expect(await refusal(resolve, { kind: "file", ref: "https://cdn.test/stream", name: "s" })).toBe(
    "too_large",
  );
  expect(pulled).toBeLessThanOrEqual(MEDIA_BYTE_CAP / chunk.byteLength + 2);
  // A finite chunked body under the cap is concatenated in arrival order.
  const chunked = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3]));
      controller.close();
    },
  });
  const short = createMediaResolver(
    ports(machineWith({})),
    () => Promise.resolve(new Response(chunked, { headers: { "content-type": "image/png" } })),
    lookupTable,
  );
  expect(await short({ kind: "image", ref: "https://cdn.test/two.png" })).toEqual({
    bytes: new Uint8Array([1, 2, 3]),
    name: "two.png",
    mime: "image/png",
  });
});

test("a bodyless response with an oversized declared length is refused", async () => {
  const resolve = createMediaResolver(
    {},
    () => Promise.resolve(new Response(null, { headers: { "content-length": String(MEDIA_BYTE_CAP + 1) } })),
    lookupTable,
  );
  expect(await refusal(resolve, { kind: "file", ref: "https://cdn.test/empty", name: "empty" })).toBe("too_large");
});

test("redirects are followed hop by hop with every hop admitted; the final hop names the download", async () => {
  const calls: { href: string; redirect: RequestInit["redirect"] }[] = [];
  // A 3xx whose location is not a URL: the platform mints only valid redirects,
  // so the header is replaced on a copy.
  const seed = Response.redirect("https://cdn.test/seed", 302);
  const badLocation = new Response(seed.body, {
    status: seed.status,
    headers: { location: "https://" },
  });
  const fetchImpl: MediaFetch = (input, init) => {
    calls.push({ href: input.href, redirect: init.redirect });
    switch (input.pathname) {
      case "/start":
        return Promise.resolve(Response.redirect("https://cdn.test/hop/final.gif", 302));
      case "/to-http":
        return Promise.resolve(Response.redirect("http://cdn.test/x.png", 301));
      case "/to-private":
        return Promise.resolve(Response.redirect("https://169.254.169.254/latest", 307));
      case "/loop":
        return Promise.resolve(Response.redirect("https://cdn.test/loop", 302));
      case "/to-nowhere":
        return Promise.resolve(badLocation);
      case "/down":
        return Promise.reject(new Error("ECONNRESET"));
      default:
        return Promise.resolve(
          new Response(new Uint8Array([1]), { headers: { "content-type": "image/gif" } }),
        );
    }
  };
  const resolve = createMediaResolver(ports(machineWith({})), fetchImpl, lookupTable);
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
  expect(await refusal(resolve, { kind: "image", ref: "https://cdn.test/to-nowhere" })).toBe(
    "fetch_failed",
  );
  expect(await refusal(resolve, { kind: "image", ref: "https://cdn.test/down" })).toBe(
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
  expect(mediaMime("voice.m4a")).toBe("audio/mp4");
  expect(mediaMime("voice.oga")).toBe("audio/ogg");
  expect(mediaMime("voice.opus")).toBe("audio/ogg");
  expect(mediaMime("clip.webm")).toBe("video/webm");
  expect(mediaMime("clip.mov")).toBe("video/quicktime");
  expect(mediaMime("noext")).toBe("application/octet-stream");
});

test.each([
  { status: 200, headers: new Headers({ "content-length": String(MEDIA_BYTE_CAP + 1) }), code: "too_large" },
  { status: 503, headers: new Headers(), code: "fetch_failed" },
])("refused HTTP $status bodies are canceled without reading", async ({ status, headers, code }) => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
  const resolve = createMediaResolver({}, () => Promise.resolve(new Response(body, { status, headers })), lookupTable);
  expect(await refusal(resolve, { kind: "file", ref: "https://cdn.test/refused", name: "file" })).toBe(code);
  expect(canceled).toBe(true);
  expect(body.locked).toBe(false);
});

test("one deadline follows redirects and interrupts a pending public response body", async () => {
  const controller = new AbortController();
  const entered = eventSignal<void>("body read entered");
  const pulling = Promise.withResolvers<void>();
  const signals: (AbortSignal | null | undefined)[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      controller.signal.addEventListener("abort", () => {
        stream.error(new DOMException("download deadline", "AbortError"));
        pulling.resolve();
      }, { once: true });
    },
    pull() {
      entered.resolve();
      return pulling.promise;
    },
  }, { highWaterMark: 0 });
  const resolve = createMediaResolver({}, (url, init) => {
    signals.push(init.signal);
    return Promise.resolve(url.pathname === "/start"
      ? Response.redirect("https://cdn.test/body")
      : new Response(body));
  }, lookupTable);
  const running = resolve({ kind: "file", ref: "https://cdn.test/start", name: "file" }, {
    maxBytes: MEDIA_BYTE_CAP, signal: controller.signal,
  });
  const outcome = running.then(() => undefined, (error: Error) => error);
  await entered.promise;
  controller.abort();
  const error = await outcome;
  expect(error).toBeInstanceOf(MediaRefused);
  if (!(error instanceof MediaRefused)) throw new Error("expected a media refusal");
  expect(error.data.code).toBe("fetch_failed");
  expect(signals).toEqual([controller.signal, controller.signal]);
  expect(body.locked).toBe(false);
});

test("an aborted lookup settles without waiting for DNS or invoking transport", async () => {
  const controller = new AbortController();
  const entered = eventSignal<void>("lookup entered");
  const held = Promise.withResolvers<readonly { address: string; family: number }[]>();
  const transported: string[] = [];
  const resolve = createMediaResolver({}, (url) => {
    transported.push(url.href);
    return Promise.resolve(new Response("bytes"));
  }, () => {
    entered.resolve();
    return held.promise;
  });
  const running = resolve({ kind: "file", ref: "https://cdn.test/held", name: "held" }, {
    maxBytes: MEDIA_BYTE_CAP, signal: controller.signal,
  }).then(() => undefined, (error: Error) => error);

  await entered.promise;
  controller.abort(new Error("deadline exceeded"));
  const error = await running;
  expect(error).toBeInstanceOf(MediaRefused);
  if (!(error instanceof MediaRefused)) throw new Error("expected a media refusal");
  expect(error.data.code).toBe("fetch_failed");
  expect(transported).toEqual([]);
});

test("every hop connects to its admitted address; names resolving to private or mapped-private addresses never reach the transport", async () => {
  const calls: string[] = [];
  const fetchImpl: MediaFetch = (url, _init, address) => {
    calls.push(`${url.host} -> ${address.address}`);
    return Promise.resolve(url.pathname === "/to-rebind"
      ? Response.redirect("https://rebind.test/x.png", 302)
      : new Response(new Uint8Array([1])));
  };
  const resolve = createMediaResolver({}, fetchImpl, lookupTable);
  await resolve({ kind: "image", ref: "https://dual.test/a.png" });
  await resolve({ kind: "image", ref: "https://v6.test/a.png" });
  await resolve({ kind: "image", ref: "https://[2606:4700::2]/a.png" });
  expect(calls).toEqual(["dual.test -> 93.184.216.34", "v6.test -> 2606:4700::1", "[2606:4700::2] -> 2606:4700::2"]);
  for (const host of [
    "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::ffff:a00:7]", "[::]",
    "rebind.test", "mixed.test", "mapped.test", "tailnet.test", "empty.test",
  ])
    expect(await refusal(resolve, { kind: "image", ref: `https://${host}/a.png` })).toBe("host");
  expect(await refusal(resolve, { kind: "image", ref: "https://cdn.test/to-rebind" })).toBe("host");
  expect(await refusal(resolve, { kind: "image", ref: "https://unknown.test/a.png" })).toBe("fetch_failed");
  expect(calls).toEqual([
    "dual.test -> 93.184.216.34", "v6.test -> 2606:4700::1", "[2606:4700::2] -> 2606:4700::2", "cdn.test -> 93.184.216.34",
  ]);
});

test("the default transport dials the admitted address while the Host header and TLS server name keep the URL's name", async () => {
  const dialed = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("a"))
    .mockResolvedValueOnce(new Response("b"));
  try {
    const resolve = createMediaResolver({}, undefined, lookupTable);
    await resolve({ kind: "file", ref: "https://cdn.test:8443/a.bin?x=1", name: "a" });
    await resolve({ kind: "file", ref: "https://v6.test/b.bin", name: "b" });
    expect(dialed.mock.calls.map(([target, init]) => [String(target), init])).toEqual([
      ["https://93.184.216.34:8443/a.bin?x=1", expect.objectContaining({
        redirect: "manual", headers: { host: "cdn.test:8443" }, tls: { serverName: "cdn.test" },
      })],
      ["https://[2606:4700::1]/b.bin", expect.objectContaining({
        redirect: "manual", headers: { host: "v6.test" }, tls: { serverName: "v6.test" },
      })],
    ]);
  } finally {
    dialed.mockRestore();
  }
});

test("the default lookup resolves through the system resolver and refuses a name on the host's own loopback", async () => {
  const transported: string[] = [];
  const resolve = createMediaResolver({}, (url) => {
    transported.push(url.href);
    return Promise.resolve(new Response("secret"));
  });
  expect(await refusal(resolve, { kind: "image", ref: "https://localhost/a.png" })).toBe("host");
  expect(transported).toEqual([]);
});
