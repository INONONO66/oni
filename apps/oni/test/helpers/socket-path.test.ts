import { describe, expect, test } from "bun:test";
import { socketPath } from "./socket-path";

describe("socketPath", () => {
  test("creates distinct paths within the macOS Unix socket limit", () => {
    const first = socketPath();
    const second = socketPath();

    expect(first).not.toBe(second);
    expect(first.endsWith(".sock")).toBe(true);
    expect(first.length).toBeLessThan(104);
    expect(second.length).toBeLessThan(104);
  });
});
