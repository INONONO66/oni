/**
 * #1497 media resolver: an outbound media part's `ref` becomes bytes only at
 * delivery time, from an attached machine (the `read` tool's door), an
 * https URL or (#1783) the sending session's own stored tool output; anything
 * else is a typed refusal before any channel call.
 */
import { expect, spyOn, test } from "bun:test";
import {
  MEDIA_BYTE_CAP,
  type MediaFetch,
  type MediaLookup,
  MediaRefused,
  createMediaResolver,
  mediaExtension,
  mediaMime,
} from "../src/composition/media";
import type { FilePorts } from "../src/bundles/tools/core/filesystem";
import { eventSignal } from "./helpers/event-signal";
import { testPlane } from "./helpers/ledger";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaTooLarge } from "@oni/channels";
import type { Gateway, Outbound } from "@oni/protocol";
import { createHash } from "node:crypto";
import { createSlackProvider } from "../../../packages/channels/src/provider/slack/provider";
import { createTelegramProvider } from "../../../packages/channels/src/provider/telegram/provider";
import { recordHttp } from "../../../packages/channels/test/helpers/http";
import { fakeSlackSdk } from "../../../packages/channels/test/helpers/slack-sdk";
import { fakeTelegramOwner } from "../../../packages/channels/test/helpers/telegram-owner-sdk";
import { injectedOptions } from "../../../packages/channels/test/helpers/injected";

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
async function refusal(resolve: Resolve, part: Parameters<Resolve>[0], sender?: Gateway.IngestSender): Promise<string> {
  const error = await resolve(part, sender).then(() => undefined, (caught: Error) => caught);
  expect(error).toBeInstanceOf(MediaRefused);
  if (!(error instanceof MediaRefused)) throw new Error("expected a media refusal");
  return error.data.code;
}

/**
 * Session A holds one PNG tool output in a file-backed ledger; the resolver's
 * URL and machine doors record every entry so the output door proves it never
 * falls through. `close` releases the plane and its directory.
 */
function outputFixture() {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
  // The id names the bytes: the same digest the capture store writes (`sha256:<hex>` of the raw frame).
  const outputId = `sha256:${createHash("sha256").update(png).digest("hex")}`;
  const dir = mkdtempSync(join(tmpdir(), "oni-media-outputs-"));
  const plane = testPlane({ sessionsDir: dir });
  const session = (id: string) => {
    plane.catalog.indexSession({ id, parentId: null, role: "resident", createdAt: 1 });
    return plane.openKernel(id);
  };
  session("session-a").putToolOutput({ outputId, bytes: png, mediaType: "image/png" });
  const reads: string[] = [];
  const fetched: string[] = [];
  const resolve = createMediaResolver(
    { ...ports(machineWith({ [outputId]: png }, Number.POSITIVE_INFINITY, reads)), outputs: plane.read },
    (url) => {
      fetched.push(url.href);
      return Promise.resolve(new Response(png));
    },
    lookupTable,
  );
  const sender = (id: string): Gateway.IngestSender => ({ kind: "session", id });
  const close = () => {
    plane.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { png, outputId, dir, session, reads, fetched, resolve, sender, close, name: `${outputId.slice(7, 19)}.png` };
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
  const error = await resolve({ kind: "file", ref: "/tmp/huge.bin", name: "huge.bin" })
    .then(() => undefined, (caught: Error) => caught);
  expect(error).toBeInstanceOf(MediaTooLarge);
  expect(error).toMatchObject({ kind: "file", bytes: MEDIA_BYTE_CAP + 1, limit: MEDIA_BYTE_CAP });
  expect(reads).toEqual([]);
  // Through the real Owner adapter the stat-time refusal keeps its typed size receipt, with no physical send.
  const dir = mkdtempSync(join(tmpdir(), "oni-media-owner-"));
  try {
    const fake = fakeTelegramOwner();
    const arm = createTelegramProvider(undefined, fake.sdk).owner;
    const runtime = arm?.create({ apiId: "123", apiHash: "a".repeat(32) },
      () => undefined, { ...injectedOptions(), telegramDataDir: dir, media: resolve });
    await runtime?.surface.start("start");
    expect(await runtime?.deliveryRoute?.("peer", { kind: "message", parts: [{ kind: "video", ref: "/tmp/huge.bin" }] }, "oversize"))
      .toEqual({ value: "rejected", reason: `media_too_large video ${MEDIA_BYTE_CAP + 1}>${MEDIA_BYTE_CAP}` });
    expect(fake.sends).toEqual([]);
    await runtime?.surface.stop("stop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("a stored output's upload extension inverts the mime table, first-listed extension wins, unknown is bin (#1783)", () => {
  expect(mediaExtension("image/png")).toBe("png");
  expect(mediaExtension("image/jpeg")).toBe("jpg");
  expect(mediaExtension("audio/ogg")).toBe("ogg");
  expect(mediaExtension("Audio/OGG; codecs=opus")).toBe("ogg");
  expect(mediaExtension("application/x-unknown")).toBe("bin");
});

test("a sha256 ref attaches the sender session's stored output: bytes, mime and a digest-named file reach the Telegram and Slack bots (#1783)", async () => {
  const fixture = outputFixture();
  const part: Outbound.Part = { kind: "image", ref: fixture.outputId, caption: "the frame" };
  // The resolver alone: the stored row's media type names the mime and the extension; a part's own name wins.
  expect(await fixture.resolve(part, fixture.sender("session-a"))).toEqual({
    bytes: fixture.png, name: fixture.name, mime: "image/png",
  });
  expect(await fixture.resolve({ kind: "file", ref: fixture.outputId, name: "frame.bin", mime: "application/x-frame" }, fixture.sender("session-a")))
    .toEqual({ bytes: fixture.png, name: "frame.bin", mime: "application/x-frame" });

  // Telegram bot: the upload carries the stored bytes under the digest-named PNG.
  const wire = recordHttp(() => Response.json({ ok: true, result: { message_id: 17 } }));
  try {
    const telegram = createTelegramProvider().create(
      { token: "tg-test" }, {}, () => undefined, { ...injectedOptions(), media: fixture.resolve },
    );
    expect(await telegram.deliveryRoute?.("123", { kind: "message", parts: [part] }, "upload-output", undefined, fixture.sender("session-a")))
      .toEqual({ value: "accepted", externalMessageId: "17" });
    expect(wire.requests).toHaveLength(1);
    const request = wire.requests[0];
    if (request === undefined) throw new Error("missing request");
    expect(request.url).toEndWith("/sendPhoto");
    const form = await request.formData();
    expect(form.get("caption")).toBe("the frame");
    const file = form.get("photo");
    if (!(file instanceof File)) throw new Error("missing file");
    expect(file.name).toBe(fixture.name);
    expect(file.type).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(fixture.png);
  } finally {
    wire.restore();
  }

  // Slack bot: the same letter uploads the same bytes under the same name.
  const slack = fakeSlackSdk();
  const runtime = createSlackProvider(slack.sdk).create(
    { botToken: "xoxb-test", appToken: "xapp-test" }, {}, () => undefined, { ...injectedOptions(), media: fixture.resolve },
  );
  expect(await runtime.deliveryRoute?.("T1:U1", { kind: "message", parts: [part] }, "upload-output-slack", { channelId: "C1" }, fixture.sender("session-a")))
    .toEqual({ value: "accepted" });
  expect(slack.client.calls).toEqual([
    { method: "uploadFile", args: ["C1", [...fixture.png], fixture.name, { initial_comment: "the frame" }] },
  ]);
  // Neither door behind the output door was entered.
  expect(fixture.reads).toEqual([]);
  expect(fixture.fetched).toEqual([]);
  fixture.close();
});

test("a sha256 ref another session holds, a never-stored digest, an unindexed sender or a letter without a session sender is refused output_missing before any URL or machine read (#1783)", async () => {
  const fixture = outputFixture();
  const part: Outbound.Part = { kind: "image", ref: fixture.outputId };
  const unknown = `sha256:${"00".repeat(32)}`;
  // Session B exists (it holds its own, different output) but not this digest.
  fixture.session("session-b").putToolOutput({ outputId: unknown, bytes: new Uint8Array([1]), mediaType: "image/png" });
  expect(await refusal(fixture.resolve, part, fixture.sender("session-b"))).toBe("output_missing");
  expect(await refusal(fixture.resolve, { kind: "image", ref: unknown }, fixture.sender("session-a"))).toBe("output_missing");
  expect(await refusal(fixture.resolve, part)).toBe("output_missing");
  expect(await refusal(fixture.resolve, part, { kind: "external", surface: "telegram", externalId: "u1" })).toBe("output_missing");
  // A sender id the catalog never indexed is refused without opening a session: the read mints no session file.
  expect(await refusal(fixture.resolve, part, fixture.sender("session-ghost"))).toBe("output_missing");
  expect(readdirSync(fixture.dir).filter((file) => file.startsWith("session-ghost"))).toEqual([]);
  const error = await fixture.resolve(part, fixture.sender("session-b")).then(() => undefined, (caught: Error) => caught);
  expect(error instanceof MediaRefused ? error.data : undefined).toEqual({
    code: "output_missing", ref: fixture.outputId, detail: "not a stored tool output of session session-b",
  });
  // A composition without an outputs port refuses the same way rather than reading a path named like a digest.
  const portless = createMediaResolver(ports(machineWith({ [fixture.outputId]: fixture.png }, Number.POSITIVE_INFINITY, fixture.reads)));
  expect(await refusal(portless, part, fixture.sender("session-a"))).toBe("output_missing");

  // Through the Telegram bot the refusal is the letter's receipt, not an upload.
  const wire = recordHttp(() => Response.json({ ok: true, result: { message_id: 17 } }));
  try {
    const telegram = createTelegramProvider().create(
      { token: "tg-test" }, {}, () => undefined, { ...injectedOptions(), media: fixture.resolve },
    );
    expect(await telegram.deliveryRoute?.("123", { kind: "message", parts: [part] }, "upload-foreign", undefined, fixture.sender("session-b")))
      .toMatchObject({ value: "rejected" });
    expect(wire.requests).toHaveLength(0);
  } finally {
    wire.restore();
  }
  expect(fixture.reads).toEqual([]);
  expect(fixture.fetched).toEqual([]);
  fixture.close();
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
  const running = resolve({ kind: "file", ref: "https://cdn.test/start", name: "file" }, undefined, {
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
  const running = resolve({ kind: "file", ref: "https://cdn.test/held", name: "held" }, undefined, {
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
