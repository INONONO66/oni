import { describe, expect, test } from "bun:test";
import { useProcessor, capturingSink, statusStates } from "../helpers/processor";

describe("Processor attempt settlement", () => {
  const { createProcessor, events } = useProcessor();

  test.each([
    true,
    false,
  ])("records failure before promise settlement (synchronous=%s)", async (synchronous) => {
    const failure = new Error("stream failure fixture");
    const capture = capturingSink();
    const processor = createProcessor({
      sink: capture.sink,
      createStream: () => {
        if (synchronous) throw failure;
        return Promise.reject(failure);
      },
    });
    function assertSettled() {
      expect(capture.messages).toHaveLength(1);
      expect(capture.messages[0]?.info).toMatchObject({ finish: "error" });
      expect(statusStates(events)).toEqual(["busy", "idle"]);
    }
    const processing = processor.process({ system: "", promptText: "" });
    // Registered before any await: this handler observes the state at the moment of rejection.
    const settledAtRejection = processing.then(
      () => false,
      () => {
        assertSettled();
        return true;
      },
    );
    await expect(processing).rejects.toMatchObject({ _tag: "TransportFailure", cause: failure });
    expect(await settledAtRejection).toBe(true);
  });
});
