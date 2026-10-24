import { expect, test } from "bun:test";
import { wsParts } from "../src/composition/ws-parts";

const image = { kind: "image", ref: "mac:/inbox/k-a.png", mime: "image/png" } as const;

test("parts on a ws text frame are handed to ingest once by connection and event", () => {
  const parts = wsParts();
  const captured = parts.capture("owner", JSON.stringify({ text: "look", eventId: "e1", parts: [image] }));

  expect(captured !== undefined && !("type" in captured)).toBe(true);
  expect(parts.take("other", "e1")).toBeUndefined();
  expect(parts.take("owner", "e1")).toEqual([image]);
  expect(parts.take("owner", "e1")).toBeUndefined();
});

test("a frame without parts is left to the perimeter, and release drops an unclaimed capture", () => {
  const parts = wsParts();
  expect(parts.capture("owner", JSON.stringify({ text: "plain", eventId: "e1" }))).toBeUndefined();
  expect(parts.capture("owner", Buffer.from("not json"))).toBeUndefined();

  const captured = parts.capture("owner", Buffer.from(JSON.stringify({ text: "x", eventId: "e2", parts: [image] })));
  if (captured === undefined || "type" in captured) throw new Error("expected a capture");
  captured.release();
  expect(parts.take("owner", "e2")).toBeUndefined();
});

test.each([
  ["an unknown part kind", { text: "x", eventId: "e1", parts: [{ kind: "sticker", ref: "r" }] }],
  ["an empty parts list", { text: "x", eventId: "e1", parts: [] }],
  ["parts without an event key", { text: "x", parts: [image] }],
])("a frame with %s is refused whole", (_name, frame) => {
  const refused = wsParts().capture("owner", JSON.stringify(frame));
  expect(refused !== undefined && "type" in refused ? refused.reason : undefined).toBe("invalid_parts");
});
