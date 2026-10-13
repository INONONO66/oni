import type { MessageSource } from "../../src/core/journal/message-factory";

/** Deterministic message source for fixtures: fixed time, counter ids. */
export function testMessageSource(prefix = "msg"): MessageSource {
  let n = 0;
  return { now: () => 0, id: () => `${prefix}-${++n}` };
}

/** Shared fixture source for call sites that only need valid identities. */
export const messageSource: MessageSource = testMessageSource();
