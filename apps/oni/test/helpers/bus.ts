import { testBus } from "../../../../packages/agent/test/helpers/isolated";

/** The app-suite shared bus fixture (PubSub-backed, #1249); suites reset() it between cases. */
export const Bus = testBus();

let traceCounter = 0;

/** Deterministic 32-hex trace ids for fixtures; production formats trace ids over injected entropy. */
export function newTraceId(): string {
  traceCounter += 1;
  return traceCounter.toString(16).padStart(32, "0");
}
