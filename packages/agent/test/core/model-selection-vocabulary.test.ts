import { describe, expect, it } from "bun:test";
import { selectModel } from "../../src/core/loop/model-select";
import type { RetryReason } from "../../src/core/loop/retry";

const REASONS = [
  "timeout",
  "tool_error",
  "transient_error",
  "validation_error",
  "context_overflow",
] as const satisfies readonly RetryReason[];
const exhaustive: [Exclude<RetryReason, (typeof REASONS)[number]>] extends [never] ? true : never =
  true;
void exhaustive;

describe("model selection and retry vocabulary", () => {
  const chain = [
    { provider: "test", id: "first" },
    { provider: "test", id: "next" },
  ];
  for (const reason of [...REASONS, "aborted"]) {
    it(`selects the correct candidate for ${reason}`, () => {
      const advances = ["timeout", "transient_error", "validation_error"].includes(reason);
      expect(selectModel(chain, [reason]).index).toBe(advances ? 1 : 0);
    });
  }
});
