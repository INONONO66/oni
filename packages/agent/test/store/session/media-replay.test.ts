import { expect, test } from "bun:test";
import { Effect, Result } from "effect";
import { deliveryActions, receivedMessageAction } from "../../../src/core/journal/delivery";
import { foldSessionHistory } from "../../../src/inspect/history";
import { adoptWriter, materializeSession } from "../helpers/session";
import { runLedgerSync } from "../helpers/effect";
import { useSqliteStores } from "../helpers/storage";

const stores = useSqliteStores("media-replay");

test("a text and image delivery reopens as one user message with text and file parts", () => {
  const sessionId = "media-replay";
  materializeSession(stores.kernel, sessionId);
  const authority = adoptWriter(stores.kernel, sessionId);
  const content = [
    { kind: "text" as const, text: "look here" },
    { kind: "image" as const, ref: "blob:photo", name: "photo.png", mime: "image/png" },
  ];
  const input = {
    id: "media-input",
    sessionId,
    kind: "prompt" as const,
    content,
    origin: { encodingVersion: 1 as const, value: { kind: "test" } },
    status: "pending" as const,
    consumedBy: null,
    consumedAt: null,
    createdAt: 2,
    ordinal: 1,
  };
  Result.getOrThrowWith(runLedgerSync(Effect.result(stores.kernel.commit({
    ...authority,
    now: 2,
    expectedRevision: stores.kernel.row(sessionId).revision,
    actions: [
      receivedMessageAction({ ...input, parentActionId: `${sessionId}:configure`, at: 2 }),
      ...deliveryActions([input], { kind: "turn", turnId: "media-turn" }, "before_llm", input.id),
    ],
    state: "idle",
  }))), (error) => error);
  stores.reopen();
  const history = foldSessionHistory(sessionId, stores.kernel.historyPage(sessionId, { limit: 50 }).actions);
  expect(history).toHaveLength(1);
  expect(history[0]?.info.role).toBe("user");
  expect(history[0]?.parts).toMatchObject([
    { type: "text", text: "look here" },
    { type: "file", kind: "image", ref: "blob:photo", name: "photo.png", mime: "image/png" },
  ]);
});
