import { describe, expect, it } from "bun:test";
import { SlackNormalizer } from "../src/provider/slack/normalizer";

const normalizer = new SlackNormalizer({ botUserId: "B1", team: "T1" });
const message = { type: "message", channel: "C1", user: "U1", ts: "1", text: "hello" };

describe("Slack ingress facts", () => {
  it("derives the author from bot_id for a real bot_message frame with no user", () => {
    // Recorded shape of a Slack incoming-webhook/CI bot post: bot_message
    // frames carry bot_id and username but never a `user` field.
    const botMessage = {
      type: "message",
      subtype: "bot_message",
      channel: "C1",
      ts: "2",
      text: "build failed",
      bot_id: "B1234",
      username: "ci-bot",
    };
    expect(normalizer.normalize(botMessage)?.facts).toMatchObject({
      event: "message",
      author: { externalId: "T1:B1234", isBot: true },
    });
  });

  it("derives the author and text from message.user/message.text for message_changed", () => {
    expect(
      normalizer.normalize({
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        ts: "3",
        message: { user: "U2", text: "edited text" },
      })?.facts,
    ).toMatchObject({
      event: "message",
      author: { externalId: "T1:U2", isBot: false },
      render: "edited text",
    });
  });

  it("drops a message_changed edit authored by the bot itself", () => {
    expect(
      normalizer.normalize({
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        ts: "4",
        message: { user: "B1", text: "my own edited reply", bot_id: "BSELF" },
      }),
    ).toBeNull();
  });

  it("marks another bot's message_changed edit as bot-authored", () => {
    expect(
      normalizer.normalize({
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        ts: "5",
        message: { user: "U3", text: "other bot edited reply", bot_id: "BOTHER" },
      })?.facts.author,
    ).toMatchObject({ externalId: "T1:U3", isBot: true });
  });

  it("normalizes a reaction with a stable target, emoji and author id", () => {
    expect(
      normalizer.normalize({
        type: "reaction_added",
        user: "U1",
        reaction: "thumbsup",
        item: { channel: "C1", ts: "1" },
      })?.facts,
    ).toMatchObject({ eventId: "1:thumbsup:U1", event: "reaction", render: "thumbsup" });
  });

  it("drops only the bot's own echo", () => {
    expect(normalizer.normalize({ ...message, user: "B1" })).toBeNull();
  });

  it("marks direct mentions without losing the addressee", () => {
    expect(normalizer.normalize({ ...message, text: "hi <@B1>" })?.facts).toMatchObject({
      event: "mention",
      addressees: [{ externalId: "T1:B1" }],
    });
  });
});
