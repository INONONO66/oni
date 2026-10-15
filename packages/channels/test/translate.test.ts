import { beforeAll, describe, expect, mock, test } from "bun:test";
import { Outbound } from "@openomni/protocol";
import { DeliveryNotSent } from "../src/errors";
import type { MediaLimits, RenderPolicy } from "../src/provider/contract";
import { slackEmojiName } from "../src/provider/slack/emoji";
import { TELEGRAM_RENDER } from "../src/provider/telegram/format";
import { PartialDeliveryError, type NativeStep, type SurfaceSends, translate } from "../src/support/translate";
import type { MediaBytes } from "../src/types";

/** Identity dialect with a small limit so chunking is observable. */
const CAPABILITIES = {
  Markdown: "text", Code: "text", Table: "text", Image: "text", File: "text",
  Buttons: "text", Button: "text", Card: "text", Carousel: "text", Poll: "text",
  Status: "text", Divider: "text", Context: "text",
} as const;
const RENDER: RenderPolicy = { renderMarkdown: (markdown) => markdown, messageLimit: 64, capabilities: CAPABILITIES };
const UNBOUNDED: RenderPolicy = {
  renderMarkdown: (markdown) => `<${markdown}>`,
  messageLimit: null,
  capabilities: CAPABILITIES,
};

type Sent =
  | { kind: "text"; chunk: string }
  | { kind: "media"; mediaKind: "image" | "file"; name: string; caption: string | undefined }
  | { kind: "react"; messageId: string; emoji: string; replaces?: string };

const LIMITS: MediaLimits = { imageBytes: 10, fileBytes: 20, captionLength: 8 };

function recorder(
  options: {
    media?: boolean;
    limits?: MediaLimits;
    react?: boolean;
    ids?: (string | undefined)[];
  } = {},
) {
  const sent: Sent[] = [];
  const scripted = options.ids === undefined ? undefined : [...options.ids];
  let posted = 0;
  const next = () => (scripted === undefined ? `m${++posted}` : scripted.shift());
  const sends: SurfaceSends = {
    text: async (chunk) => {
      sent.push({ kind: "text", chunk });
      return next();
    },
    ...(options.media
      ? {
          media: {
            limits: options.limits ?? LIMITS,
            upload: async (
              mediaKind: "image" | "file",
              bytes: MediaBytes,
              caption: string | undefined,
            ) => {
              sent.push({ kind: "media", mediaKind, name: bytes.name, caption });
              const externalMessageId = next();
              return externalMessageId === undefined ? {} : { externalMessageId };
            },
          },
        }
      : {}),
    ...(options.react
      ? {
          react: async (messageId: string, emoji: string, replaces?: string) => {
            sent.push({ kind: "react", messageId, emoji, ...(replaces === undefined ? {} : { replaces }) });
          },
        }
      : {}),
  };
  return { sent, sends };
}

const resolve = async (part: Outbound.Part & { kind: "image" | "file" }): Promise<MediaBytes> => ({
  bytes: new Uint8Array([1, 2, 3]),
  name: part.kind === "image" ? (part.name ?? "image.png") : part.name,
  mime: "application/octet-stream",
});

describe("translate: text folding", () => {
  test("a spec message is delivered as one digest text step", async () => {
    const spec: Outbound.Spec = {
      root: "body",
      elements: { body: { type: "Markdown", props: { text: "structured" }, children: [] } },
    };
    const r = recorder();
    await translate({ kind: "message", spec }, UNBOUNDED, r.sends);
    expect(r.sent).toEqual([{ kind: "text", chunk: "<structured>" }]);
  });

  test("Telegram chunks before HTML rendering so escaped entities stay whole", async () => {
    const chunks: string[] = [];
    const sends: SurfaceSends = { text: async (chunk) => {
      chunks.push(chunk);
      return String(chunks.length);
    } };
    await translate(Outbound.payload("<".repeat(1200)), TELEGRAM_RENDER, sends);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe("&lt;".repeat(1200));
    expect(chunks.every((chunk) => chunk.length <= 4096 && !chunk.endsWith("&lt"))).toBe(true);
  });
  test("adjacent text and code parts fold into one rendered message", async () => {
    const r = recorder();
    const outcome = await translate(
      {
        kind: "message",
        parts: [
          { kind: "text", text: "see" },
          { kind: "code", text: "x = 1", lang: "py" },
        ],
      },
      UNBOUNDED,
      r.sends,
    );
    expect(r.sent).toEqual([{ kind: "text", chunk: "<see\n\n```py\nx = 1\n```>" }]);
    expect(outcome).toEqual({ accepted: true, externalMessageId: "m1" });
  });

  test("a long message splits at the surface limit and reports the last chunk's id", async () => {
    const r = recorder();
    const outcome = await translate(Outbound.payload("a".repeat(100)), RENDER, r.sends);
    expect(r.sent.length).toBeGreaterThan(1);
    expect(r.sent.every((s) => s.kind === "text" && s.chunk.length <= 64)).toBe(true);
    expect(outcome).toEqual({ accepted: true, externalMessageId: `m${r.sent.length}` });
  });

  test("a text send the platform acknowledges without a message id is not proven accepted", async () => {
    const r = recorder({ ids: [undefined] });
    expect(await translate(Outbound.payload("hi"), UNBOUNDED, r.sends)).toEqual({
      accepted: false,
    });
  });
});

describe("translate: media", () => {
  const letter: Outbound.Payload = {
    kind: "message",
    parts: [
      { kind: "text", text: "before" },
      { kind: "image", ref: "/tmp/shot.png", name: "shot.png", caption: "the shot" },
      { kind: "file", ref: "https://x/report.pdf", name: "report.pdf" },
      { kind: "text", text: "after" },
    ],
  };

  test("image and file parts upload in order between the text around them", async () => {
    const r = recorder({ media: true });
    const outcome = await translate(letter, UNBOUNDED, r.sends, resolve);
    expect(r.sent).toEqual([
      { kind: "text", chunk: "<before>" },
      { kind: "media", mediaKind: "image", name: "shot.png", caption: "the shot" },
      { kind: "media", mediaKind: "file", name: "report.pdf", caption: undefined },
      { kind: "text", chunk: "<after>" },
    ]);
    expect(outcome).toEqual({ accepted: true, externalMessageId: "m4" });
  });

  test("without a resolver or without surface media, the reference line stays in the text", async () => {
    const noResolver = recorder({ media: true });
    await translate(letter, UNBOUNDED, noResolver.sends);
    const noSurface = recorder();
    await translate(letter, UNBOUNDED, noSurface.sends, resolve);
    const folded = `<before\n\n[image: shot.png] /tmp/shot.png\nthe shot\n\n[file: report.pdf] https://x/report.pdf\n\nafter>`;
    expect(noResolver.sent).toEqual([{ kind: "text", chunk: folded }]);
    expect(noSurface.sent).toEqual([{ kind: "text", chunk: folded }]);
  });

  test("a reference that fails to resolve refuses the whole letter before anything is sent", async () => {
    const r = recorder({ media: true });
    const failing = () => Promise.reject(new Error("no such file"));
    const error = await translate(letter, UNBOUNDED, r.sends, failing).catch((e) => e);
    expect(error).toBeInstanceOf(DeliveryNotSent);
    expect(error).toMatchObject({ operation: "media.resolve", cause: "Error: no such file" });
    expect(r.sent).toEqual([]);
  });

  test.each([
    {
      part: { kind: "image", ref: "/large.png" } as const,
      size: 11,
      operation: "media.limit",
      cause: "11 bytes exceeds the image limit 10",
    },
    {
      part: { kind: "file", ref: "/large.bin", name: "large.bin" } as const,
      size: 21,
      operation: "media.limit",
      cause: "21 bytes exceeds the file limit 20",
    },
    {
      part: { kind: "image", ref: "/caption.png", caption: "123456789" } as const,
      size: 3,
      operation: "media.caption",
      cause: "9 characters exceeds the caption limit 8",
    },
  ])("refuses $operation before text or upload for $part.ref", async ({
    part,
    size,
    operation,
    cause,
  }) => {
    const r = recorder({ media: true });
    const error = await translate(
      { kind: "message", parts: [{ kind: "text", text: "before" }, part] },
      UNBOUNDED,
      r.sends,
      async () => ({ bytes: new Uint8Array(size), name: "part", mime: "application/octet-stream" }),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(DeliveryNotSent);
    expect(error).toMatchObject({ operation, cause });
    expect(r.sent).toEqual([]);
  });

  test("refuses a letter exceeding 64 MiB before any text or upload", async () => {
    const r = recorder({
      media: true,
      limits: {
        imageBytes: 70 * 1024 * 1024,
        fileBytes: 70 * 1024 * 1024,
        captionLength: 8,
      },
    });
    const bytes = new Uint8Array(33 * 1024 * 1024);
    const error = await translate(
      {
        kind: "message",
        parts: [
          { kind: "text", text: "before" },
          { kind: "image", ref: "/one.png" },
          { kind: "image", ref: "/two.png" },
        ],
      },
      UNBOUNDED,
      r.sends,
      async () => ({ bytes, name: "part.png", mime: "image/png" }),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(DeliveryNotSent);
    expect(error).toMatchObject({
      operation: "media.limit",
      cause: "69206016 bytes exceeds the letter limit 67108864",
    });
    expect(r.sent).toEqual([]);
  });

  test("an upload acknowledged without an id still counts as delivered", async () => {
    const r = recorder({ media: true, ids: ["m1", undefined] });
    const outcome = await translate(
      {
        kind: "message",
        parts: [
          { kind: "text", text: "t" },
          { kind: "image", ref: "/a.png" },
        ],
      },
      UNBOUNDED,
      r.sends,
      resolve,
    );
    expect(outcome).toEqual({ accepted: true, externalMessageId: "m1" });
  });
});

describe("translate: reactions", () => {
  const react: Outbound.Payload = { kind: "react", messageId: "msg-9", emoji: "👍" };

  test("a surface with reactions adds the emoji on the named message", async () => {
    const r = recorder({ react: true });
    expect(await translate(react, UNBOUNDED, r.sends)).toEqual({
      accepted: true,
      externalMessageId: "msg-9",
    });
    expect(r.sent).toEqual([{ kind: "react", messageId: "msg-9", emoji: "👍" }]);
  });

  test("a reaction names the earlier emoji it replaces, never becoming text", async () => {
    const r = recorder({ react: true });
    await translate({ ...react, replaces: "👀" }, UNBOUNDED, r.sends);
    expect(r.sent).toEqual([{ kind: "react", messageId: "msg-9", emoji: "👍", replaces: "👀" }]);
  });

  test("a surface without reactions refuses, never posts the emoji as text", async () => {
    const r = recorder();
    const error = await translate(react, UNBOUNDED, r.sends).catch((e) => e);
    expect(error).toBeInstanceOf(DeliveryNotSent);
    expect(error).toMatchObject({ operation: "react" });
    expect(r.sent).toEqual([]);
  });
});

describe("translate: partial delivery", () => {
  const long = Outbound.payload("a".repeat(100));
  let chunkCount = 0;
  beforeAll(async () => {
    const dry = recorder();
    await translate(long, RENDER, dry.sends);
    chunkCount = dry.sent.length;
    expect(chunkCount).toBeGreaterThan(2);
  });
  test("a failure after an accepted chunk is reported as partial with what landed", async () => {
    let calls = 0;
    const sends: SurfaceSends = {
      text: async () => {
        calls += 1;
        if (calls === 2) throw new Error("socket reset");
        return `m${calls}`;
      },
    };
    const error = await translate(long, RENDER, sends).catch((e) => e);
    expect(error).toBeInstanceOf(PartialDeliveryError);
    const partial = error as PartialDeliveryError;
    expect(partial.reason).toBe("send_failed");
    expect(partial.attemptedChunks).toBe(2);
    expect(partial.totalChunks).toBe(chunkCount);
    expect(partial.acceptedChunks).toEqual([{ index: 1, externalMessageId: "m1" }]);
    expect(partial.cause).toBeInstanceOf(Error);
  });

  test("a failure on the first chunk propagates as itself so the send stays retryable", async () => {
    const sends: SurfaceSends = { text: () => Promise.reject(new Error("refused")) };
    const error = await translate(Outbound.payload("hi"), UNBOUNDED, sends).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PartialDeliveryError);
  });

  test("a chunk accepted without a receipt after one with a receipt is a missing-receipt partial", async () => {
    const r = recorder({ ids: ["m1", undefined] });
    const error = await translate(long, RENDER, r.sends).catch((e) => e);
    expect(r.sent.length).toBe(chunkCount);
    expect(error).toBeInstanceOf(PartialDeliveryError);
    const partial = error as PartialDeliveryError;
    expect(partial.reason).toBe("missing_receipt");
    expect(partial.acceptedChunks).toEqual([{ index: 1, externalMessageId: "m1" }]);
  });
});

describe("translate: catalog specs", () => {
  const spec: Outbound.Spec = {
    root: "cards",
    elements: {
      cards: { type: "Carousel", props: {}, children: ["first", "second"] },
      first: { type: "Card", props: { title: "First", image: "/first.png" }, children: [] },
      second: { type: "Card", props: { title: "Second" }, children: [] },
      poll: { type: "Poll", props: { question: "Choose", options: ["One", "Two"] }, children: [] },
      image: { type: "Image", props: { ref: "/image.png" }, children: [] },
      table: { type: "Table", props: { columns: [{ header: "Name" }], rows: [["A"]] }, children: [] },
    },
  };
  const policy: RenderPolicy = {
    ...UNBOUNDED,
    capabilities: { ...CAPABILITIES, Card: "native", Carousel: "native", Image: "native",
      Poll: "downgrade:poll-to-buttons", Buttons: "native" },
  };

  test("catalog carousel falls back to ordered card sends and resolves media before posting", async () => {
    const calls: string[] = [];
    const sends: SurfaceSends = {
      text: async (chunk) => { calls.push(`text:${chunk}`); return "m1"; },
      native: async (step) => { calls.push(`native:${step.id}`); return { externalMessageId: "m2" }; },
      media: { limits: LIMITS, upload: async (_kind, bytes) => {
        calls.push(`media:${bytes.name}`); return { externalMessageId: "m3" };
      } },
    };
    const outcome = await translate({ kind: "message", spec }, policy, sends, async (part) => {
      calls.push(`resolve:${part.ref}`);
      return resolve(part);
    });
    expect(calls).toEqual(["resolve:/first.png", "native:first", "media:image.png", "native:second"]);
    expect(outcome).toEqual({ accepted: true, externalMessageId: "m2" });
  });

  test("poll downgrade creates actionable button steps after the question", async () => {
    const calls: string[] = [];
    const sends: SurfaceSends = {
      text: async (chunk) => { calls.push(`text:${chunk}`); return "m1"; },
      native: async (step: NativeStep) => {
        calls.push(`native:${step.element.type}:${step.spec.elements["poll:option:0"]?.type}`);
        return { externalMessageId: "m2" };
      },
    };
    await translate({ kind: "message", spec: { ...spec, root: "poll" } }, policy, sends);
    expect(calls).toEqual(["text:<Choose>", "native:Buttons:Button"]);
  });

  test("caption-keyboard downgrade uploads the image before its native actions", async () => {
    const cardSpec: Outbound.Spec = {
      root: "card",
      elements: {
        card: { type: "Card", props: { title: "Card", image: "/card.png" }, children: ["buttons"] },
        buttons: { type: "Buttons", props: {}, children: ["button"] },
        button: { type: "Button", props: { label: "Open", id: "open" }, children: [] },
      },
    };
    const calls: string[] = [];
    const sends: SurfaceSends = {
      text: async (chunk) => { calls.push(`text:${chunk}`); return "text"; },
      media: { limits: LIMITS, upload: async (_kind, bytes) => {
        calls.push(`media:${bytes.name}`); return { externalMessageId: "image" };
      } },
      native: async (step) => {
        calls.push(`native:${step.id}`); return { externalMessageId: "keyboard" };
      },
    };
    const cardPolicy: RenderPolicy = { ...policy, capabilities: {
      ...policy.capabilities, Card: "downgrade:card-to-caption-keyboard",
    } };
    expect(await translate({ kind: "message", spec: cardSpec }, cardPolicy, sends, resolve))
      .toEqual({ accepted: true, externalMessageId: "keyboard" });
    expect(calls).toEqual(["media:image.png", "native:card:keyboard"]);
  });

  test("caption-keyboard downgrade remains readable without media or native ports", async () => {
    const cardSpec: Outbound.Spec = {
      root: "card",
      elements: {
        card: { type: "Card", props: { title: "Card", image: "/card.png" }, children: ["button"] },
        button: { type: "Button", props: { label: "Open", id: "open" }, children: [] },
      },
    };
    const sent: string[] = [];
    const cardPolicy: RenderPolicy = { ...policy, capabilities: {
      ...policy.capabilities, Card: "downgrade:card-to-caption-keyboard",
    } };
    await translate({ kind: "message", spec: cardSpec }, cardPolicy, {
      text: async (chunk) => { sent.push(chunk); return "text"; },
    });
    expect(sent).toEqual(["<Card\n[image] /card.png>", "<[Open]>"]);
  });

  test("complete albums stay one native send while image elements use media", async () => {
    const albumSpec: Outbound.Spec = {
      root: "album",
      elements: {
        album: { type: "Carousel", props: {}, children: ["one", "two"] },
        one: { type: "Card", props: { title: "One", image: "https://example.test/one.png" }, children: [] },
        two: { type: "Card", props: { title: "Two", image: "https://example.test/two.png" }, children: [] },
        image: { type: "Image", props: { ref: "/image.png", caption: "shot" }, children: [] },
      },
    };
    const calls: string[] = [];
    const sends: SurfaceSends = {
      text: async (chunk) => { calls.push(`text:${chunk}`); return "text"; },
      media: { limits: LIMITS, upload: async (_kind, bytes) => {
        calls.push(`media:${bytes.name}`); return { externalMessageId: "image" };
      } },
      native: async (step) => {
        calls.push(`native:${step.id}`); return { externalMessageId: "native" };
      },
    };
    const albumPolicy: RenderPolicy = { ...policy, capabilities: {
      ...policy.capabilities, Carousel: "downgrade:carousel-to-album", Image: "native",
    } };
    await translate({ kind: "message", spec: albumSpec }, albumPolicy, sends, resolve);
    await translate({ kind: "message", spec: { ...albumSpec, root: "image" } }, albumPolicy, sends, resolve);
    expect(calls).toEqual(["native:album", "media:image.png"]);
  });

  test("an image downgrade falls back to text when the surface has no media port", async () => {
    const sent: string[] = [];
    const imagePolicy: RenderPolicy = { ...policy, capabilities: {
      ...policy.capabilities, Table: "downgrade:table-to-image",
    } };
    await translate({ kind: "message", spec: { ...spec, root: "table" } }, imagePolicy, {
      text: async (chunk) => { sent.push(chunk); return "text"; },
    });
    expect(sent).toEqual(["<Name\nA>"]);
  });

  test("an image downgrade refuses an oversized caption before rasterization", async () => {
    const imagePolicy: RenderPolicy = { ...policy, capabilities: {
      ...policy.capabilities, Table: "downgrade:table-to-image",
    } };
    const sends: SurfaceSends = {
      text: async () => "text",
      media: { limits: { ...LIMITS, captionLength: 2 }, upload: async () => ({}) },
    };
    const error = await translate(
      { kind: "message", spec: { ...spec, root: "table" } },
      imagePolicy,
      sends,
      resolve,
    ).catch((value) => value);
    expect(error).toBeInstanceOf(DeliveryNotSent);
    expect(error).toMatchObject({ operation: "media.caption" });
  });

  test("a failed native step after text reports partial delivery", async () => {
    const sends: SurfaceSends = {
      text: async () => "m1",
      native: async () => { throw new Error("upstream reset"); },
    };
    const error = await translate({ kind: "message", spec: { ...spec, root: "poll" } }, policy, sends).catch((value) => value);
    expect(error).toBeInstanceOf(PartialDeliveryError);
    expect(error).toMatchObject({ reason: "send_failed", attemptedChunks: 2,
      acceptedChunks: [{ index: 1, externalMessageId: "m1" }] });
  });

  test("media reference failure rejects all planned sends", async () => {
    const calls: string[] = [];
    const sends: SurfaceSends = {
      text: async () => { calls.push("text"); return "m1"; },
      native: async () => { calls.push("native"); return { externalMessageId: "m2" }; },
      media: { limits: LIMITS, upload: async () => { calls.push("media"); return {}; } },
    };
    await expect(translate({ kind: "message", spec }, policy, sends,
      async () => { throw new Error("missing image"); })).rejects.toBeInstanceOf(DeliveryNotSent);
    expect(calls).toEqual([]);
  });

  test("table-to-image uses the same upload and limit path", async () => {
    const uploads: { mime: string; caption: string | undefined; bytes: Uint8Array }[] = [];
    const sends: SurfaceSends = {
      text: async () => "text",
      media: { limits: { imageBytes: 1_000_000, fileBytes: 1_000_000, captionLength: 128 },
        upload: async (_kind, bytes, caption) => {
          uploads.push({ mime: bytes.mime, caption, bytes: bytes.bytes });
          return { externalMessageId: "png-1" };
        } },
    };
    const imagePolicy = { ...policy, capabilities: { ...policy.capabilities,
      Table: "downgrade:table-to-image" as const } };
    expect(await translate({ kind: "message", spec: { ...spec, root: "table" } },
      imagePolicy, sends, resolve)).toEqual({ accepted: true, externalMessageId: "png-1" });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.mime).toBe("image/png");
    expect([...uploads[0]?.bytes.slice(0, 8) ?? []]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  test("an image rasterization failure becomes a typed delivery refusal", async () => {
    mock.module("../src/support/render-image", () => ({
      renderElementImage: () => Promise.reject(new Error("raster failed")),
    }));
    try {
      const imagePolicy: RenderPolicy = { ...policy, capabilities: {
        ...policy.capabilities, Table: "downgrade:table-to-image",
      } };
      const sends: SurfaceSends = {
        text: async () => "text",
        media: { limits: { imageBytes: 1_000_000, fileBytes: 1_000_000, captionLength: 128 },
          upload: async () => ({}) },
      };
      const error = await translate(
        { kind: "message", spec: { ...spec, root: "table" } },
        imagePolicy,
        sends,
        resolve,
      ).catch((value) => value);
      expect(error).toBeInstanceOf(DeliveryNotSent);
      expect(error).toMatchObject({ operation: "image.render", cause: "Error: raster failed" });
    } finally {
      mock.restore();
    }
  });
});

describe("slack emoji names", () => {
  test("known characters map to the short name reactions.add takes", () => {
    expect(slackEmojiName("👍")).toBe("+1");
    expect(slackEmojiName("✅")).toBe("white_check_mark");
    expect(slackEmojiName("❤️")).toBe("heart");
  });

  test("presentation marks and skin tones fold to the base character; a short name passes through", () => {
    expect(slackEmojiName("👍🏽")).toBe("+1");
    expect(slackEmojiName("⚠️")).toBe("warning");
    expect(slackEmojiName(":partyparrot:")).toBe("partyparrot");
  });

  test("an unknown character or a malformed short name is refused rather than guessed", () => {
    expect(slackEmojiName("🦄")).toBeUndefined();
    expect(slackEmojiName(":Party Parrot:")).toBeUndefined();
    expect(slackEmojiName("")).toBeUndefined();
  });
});
