import { describe, expect, spyOn, test } from "bun:test";
import { Operational } from "@oni/protocol";
import { Bus } from "./helpers/observation";
import { useStreamCapture } from "./helpers/stream-capture";

describe("run provider options", () => {
  const capture = useStreamCapture();

  test("keeps provider namespaces nested without overwriting call-owned arguments", async () => {
    const options = {
      anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } },
      abortSignal: { clobbered: true },
      maxRetries: { clobbered: true },
      tools: { clobbered: true },
    };
    await capture.run({
      tools: [{ name: "lookup", description: "look", inputSchema: { type: "object" } }],
      providerOptions: options,
    });
    expect(capture.args.providerOptions).toEqual(options);
    expect(capture.args.maxRetries).toBe(0);
    expect(capture.args.abortSignal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(capture.args.tools)).toEqual(["lookup"]);
  });

  test("omits the providerOptions key when unconfigured", async () => {
    await capture.run();
    expect("providerOptions" in capture.args).toBe(false);
  });

  test("rejects non-object provider namespaces before invoking the SDK", async () => {
    const outcome = await capture.run({ providerOptions: { anthropic: false } });
    expect(outcome.type).toBe("error");
    expect(() => capture.args).toThrow("streamText was not called");
  });

  test("reports SDK errors only through the injected event sink", async () => {
    const globalPublish = spyOn(Bus, "publish");
    try {
      await capture.run();
      capture.args.onError({ error: new Error("upstream exploded") });
      const errors = capture.events
        .named(Operational.Events.Error.name)
        .map((event) => Operational.Events.Error.schema.parse(event));
      expect(errors).toMatchObject([
        { component: "llm.stream", error: "Error: upstream exploded" },
      ]);
      expect(globalPublish).not.toHaveBeenCalled();
    } finally {
      globalPublish.mockRestore();
    }
  });
});
