import { describe, expect, test } from "bun:test";
import { Gateway } from "@openomni/protocol";
import { TelegramNormalizer } from "../src/provider/telegram/normalizer";
import { TelegramUpdateSchema } from "../src/provider/telegram/types";
import { SlackNormalizer } from "../src/provider/slack/normalizer";
import { SlackMessageEventSchema } from "../src/provider/slack/types";
import { DiscordNormalizer } from "../src/provider/discord/normalizer";
import { DiscordMessageSchema } from "../src/provider/discord/types";

const telegram = new TelegramNormalizer({ botId: "42", botUsername: "bot" });
const slack = new SlackNormalizer({ botUserId: "UBOT", team: "T1" });
const discord = new DiscordNormalizer("bot");

/**
 * Telegram Message, PhotoSize, Document, Audio, Voice and Sticker fields:
 * https://core.telegram.org/bots/api#message
 */
describe("Telegram incoming media", () => {
  const message = {
    message_id: 10, from: { id: 7, is_bot: false, first_name: "Alex" },
    chat: { id: 7, type: "private" }, date: 1_700_000_000,
  };
  test.each([
    ["photo", { photo: [{ file_id: "small", file_size: 10 }, { file_id: "large", file_size: 25 }] },
      [{ kind: "image", ref: "large", bytes: 25 }]],
    ["document", { document: { file_id: "doc", file_name: "report.pdf", mime_type: "application/pdf", file_size: 90 } },
      [{ kind: "file", ref: "doc", name: "report.pdf", mime: "application/pdf", bytes: 90 }]],
    ["document sent as a file but holding an image", { document: { file_id: "scan", file_name: "scan.png", mime_type: "image/png" } },
      [{ kind: "image", ref: "scan", name: "scan.png", mime: "image/png" }]],
    ["voice", { voice: { file_id: "voice", mime_type: "audio/ogg", file_size: 8 } },
      [{ kind: "audio", ref: "voice", mime: "audio/ogg", bytes: 8 }]],
    ["audio", { audio: { file_id: "song", file_name: "song.mp3", mime_type: "audio/mpeg", file_size: 20 } },
      [{ kind: "audio", ref: "song", name: "song.mp3", mime: "audio/mpeg", bytes: 20 }]],
    ["sticker", { sticker: { file_id: "sticker" } },
      [{ kind: "image", ref: "sticker", mime: "image/webp" }]],
  ] as const)("preserves a %s without a text body", (_label, media, expected) => {
    const parsed = TelegramUpdateSchema.parse({ update_id: 1, message: { ...message, ...media } });
    if (parsed.message === undefined) throw new Error("message fixture was not parsed");
    const inbound = telegram.normalize(parsed.message);
    expect(inbound?.facts.render).toBe("");
    expect(inbound?.facts.attachments).toEqual(expected);
  });
  test("caption and caption mentions survive alongside a photo", () => {
    const parsed = TelegramUpdateSchema.parse({
      update_id: 2,
      message: {
        ...message, caption: "@bot look", caption_entities: [{ type: "mention", offset: 0, length: 4 }],
        photo: [{ file_id: "photo" }],
      },
    });
    if (parsed.message === undefined) throw new Error("message fixture was not parsed");
    const inbound = telegram.normalize(parsed.message);
    expect(inbound?.facts.render).toBe("@bot look");
    expect(inbound?.facts.event).toBe("mention");
    expect(inbound?.facts.attachments).toEqual([{ kind: "image", ref: "photo" }]);
  });
});

/**
 * Slack file object and message event:
 * https://docs.slack.dev/reference/objects/file-object/
 */
describe("Slack incoming files", () => {
  test("retains private download URLs and metadata without text", () => {
    const event = SlackMessageEventSchema.parse({
      type: "message", user: "U1", channel: "C1", ts: "10", text: "",
      files: [
        { url_private_download: "https://files.slack.com/private/photo", mimetype: "image/png", name: "photo.png", size: 12 },
        { url_private_download: "https://files.slack.com/private/audio", mimetype: "audio/mpeg", name: "note.mp3", size: 13 },
        { url_private_download: "https://files.slack.com/private/file", mimetype: "application/pdf", name: "report.pdf", size: 14 },
        { id: "F-ext", url_private: "https://files.slack.com/private/ext", name: "ext.txt" },
        { id: "F-stub", name: "stub" },
        { name: "no-handle" },
      ],
    });
    const inbound = slack.normalize(event);
    expect(inbound?.facts.render).toBe("");
    expect(inbound?.facts.attachments).toEqual([
      { kind: "image", ref: "https://files.slack.com/private/photo", mime: "image/png", name: "photo.png", bytes: 12 },
      { kind: "audio", ref: "https://files.slack.com/private/audio", mime: "audio/mpeg", name: "note.mp3", bytes: 13 },
      { kind: "file", ref: "https://files.slack.com/private/file", mime: "application/pdf", name: "report.pdf", bytes: 14 },
      { kind: "file", ref: "https://files.slack.com/private/ext", name: "ext.txt" },
      { kind: "file", ref: "F-stub", name: "stub" },
    ]);
  });
});

/**
 * Discord message attachment object:
 * https://discord.com/developers/docs/resources/message#attachment-object
 */
describe("Discord incoming attachments", () => {
  test("preserves URLs and types in a media-only gateway message", () => {
    const message = DiscordMessageSchema.parse({
      id: "m1", channel_id: "c1", author: { id: "u1", username: "Alex" }, content: "",
      attachments: [
        { url: "https://cdn.discordapp.com/a.png", content_type: "image/png", filename: "a.png", size: 9 },
        { url: "https://cdn.discordapp.com/b.ogg", content_type: "audio/ogg", filename: "b.ogg", size: 11 },
        { url: "https://cdn.discordapp.com/c.pdf", content_type: "application/pdf", filename: "c.pdf", size: 12 },
      ],
    });
    const inbound = discord.normalize(message);
    expect(inbound?.facts.render).toBe("");
    expect(inbound?.facts.attachments).toEqual([
      { kind: "image", ref: "https://cdn.discordapp.com/a.png", name: "a.png", mime: "image/png", bytes: 9 },
      { kind: "audio", ref: "https://cdn.discordapp.com/b.ogg", name: "b.ogg", mime: "audio/ogg", bytes: 11 },
      { kind: "file", ref: "https://cdn.discordapp.com/c.pdf", name: "c.pdf", mime: "application/pdf", bytes: 12 },
    ]);
  });
});

test("the ingress schema preserves attachment references across parse and serialization", () => {
  const facts = {
    eventId: "e1", surface: "discord", channelId: "c1",
    addressees: [], dm: true, payload: {}, render: "",
    attachments: [{ kind: "image" as const, ref: "https://cdn.discordapp.com/a.png", name: "a.png", bytes: 10 }],
  };
  expect(Gateway.IngressFacts.parse(JSON.parse(JSON.stringify(Gateway.IngressFacts.parse(facts)))))
    .toEqual(facts);
});
