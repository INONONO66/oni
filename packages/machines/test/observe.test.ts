import { expect, test } from "bun:test";
import { legacyPointer } from "../src/observe";

test("legacyPointer flattens the capture form for a contract-2 peer", () => {
  expect(legacyPointer({ requestId: "1-1", kind: "click", at: { captureId: "cap-1", x: 10, y: 20 }, button: "left", count: 1 })).toEqual({
    kind: "click",
    button: "left",
    count: 1,
    captureId: "cap-1",
    x: 10,
    y: 20,
  });
});

test("legacyPointer withholds the element form a contract-2 peer cannot observe", () => {
  expect(legacyPointer({ requestId: "1-2", kind: "move", at: { observationId: "o1", ref: "window[0]/button[2]" } })).toBeUndefined();
});
