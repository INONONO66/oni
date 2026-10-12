import { expect, test } from "bun:test";
import { rendererTarget } from "../src/main/window";

test("renderer target uses the boot-time URL only when present", () => {
  const file = "/app/renderer/index.html";
  expect(rendererTarget("http://localhost:5173", file)).toEqual({
    kind: "url",
    target: "http://localhost:5173",
  });
  expect(rendererTarget(undefined, file)).toEqual({ kind: "file", target: file });
});
