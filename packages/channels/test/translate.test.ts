import { beforeAll, describe, expect, test } from "bun:test";
import { Outbound } from "@openomni/protocol";
import { DeliveryNotSent } from "../src/errors";
import type { MediaLimits, RenderPolicy } from "../src/provider/contract";
import { slackEmojiName } from "../src/provider/slack/emoji";
import { PartialDeliveryError, type SurfaceSends, translate } from "../src/support/translate";
import type { MediaBytes } from "../src/types";

/** Identity dialect with a small limit so chunking is observable. */
const RENDER: RenderPolicy = { renderMarkdown: (markdown) => markdown, messageLimit: 64 };
const UNBOUNDED: RenderPolicy = {
  renderMarkdown: (markdown) => `<${markdown}>`,
  messageLimit: null,
};

type Sent =
  | { kind: "text"; chunk: string }
  | { kind: "media"; mediaKind: "image" | "file"; name: string; caption: string | undefined }
  | { kind: "react"; messageId: string; emoji: string };

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
          react: async (messageId: string, emoji: string) => {
            sent.push({ kind: "react", messageId, emoji });
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
    const error = await translate(letter, UNBOUNDED, r.sends, failing).catch((e: unknown) => e);
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
    ).catch((e: unknown) => e);
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
    ).catch((e: unknown) => e);
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

  test("a surface without reactions refuses, never posts the emoji as text", async () => {
    const r = recorder();
    const error = await translate(react, UNBOUNDED, r.sends).catch((e: unknown) => e);
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
    const error = await translate(long, RENDER, sends).catch((e: unknown) => e);
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
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PartialDeliveryError);
  });

  test("a chunk accepted without a receipt after one with a receipt is a missing-receipt partial", async () => {
    const r = recorder({ ids: ["m1", undefined] });
    const error = await translate(long, RENDER, r.sends).catch((e: unknown) => e);
    expect(r.sent.length).toBe(chunkCount);
    expect(error).toBeInstanceOf(PartialDeliveryError);
    const partial = error as PartialDeliveryError;
    expect(partial.reason).toBe("missing_receipt");
    expect(partial.acceptedChunks).toEqual([{ index: 1, externalMessageId: "m1" }]);
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
