import { describe, expect, test } from "bun:test";
import { validateSideEffectRules } from "../lint-side-effects";

const processorPath = "packages/llm/src/processor/index.ts";

describe("side-effect ordering gate", () => {
  const bind =
    "const sink = createProjectedSink(events, configuredSink, sessionID, trace.traceId);";
  test.each([
    `function unrelated() { ${bind} } function emit(sink) { sink.onMessage(message); }`,
    `${bind} function emit(sink) { sink.onMessage(message); }`,
    `${bind} { const sink = raw; sink.onMessage(message); }`,
    `// ${bind}\nsink.onMessage(message);`,
    `const text = ${JSON.stringify(bind)}; sink.onMessage(message);`,
  ])("rejects emissions without their own projected binding: %s", (source) => {
    expect(validateSideEffectRules(processorPath, source)).toHaveLength(1);
  });

  test("accepts a captured projected sink and the projector's forwarding parameter", () => {
    const source = `${bind} function emit() { sink.onMessage(message); }
      function createProjectedSink(events, sink, sessionID, traceId) {
        return { onMessage(message) { sink.onMessage(message); } };
      }`;
    expect(validateSideEffectRules(processorPath, source)).toEqual([]);
  });

  test("requires projected sink binding before processor emission", () => {
    const bind =
      "const sink = createProjectedSink(events, configuredSink, sessionID, trace.traceId);";
    const emit = "sink.onMessage(message);";
    expect(validateSideEffectRules(processorPath, `${bind}\n${emit}`)).toEqual([]);
    expect(validateSideEffectRules(processorPath, `${emit}\n${bind}`)).toHaveLength(1);
    expect(validateSideEffectRules(processorPath, bind)).toHaveLength(1);
  });
});
