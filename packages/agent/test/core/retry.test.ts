import { describe, expect, it } from "bun:test";
import { abortError, isAbort } from "../../src/core/loop/retry";

describe("isAbort (audit M4)", () => {
  it("recognizes an aborted signal regardless of the error message", () => {
    const controller = new AbortController();
    controller.abort();
    expect(isAbort(new Error("connection timeout"), controller.signal)).toBe(true);
  });
  it("recognizes the typed abort error without a signal", () => {
    expect(isAbort(abortError(), undefined)).toBe(true);
    expect(abortError().name).toBe("AbortError");
  });
  it("does NOT classify by message substring: a tool error mentioning 'aborted' is not an abort", () => {
    const controller = new AbortController();
    expect(isAbort(new Error("tool run aborted by remote host"), controller.signal)).toBe(false);
  });
});
