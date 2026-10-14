import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "../../src/core/loop/tool";

describe("buildSystemPrompt", () => {
  it("combines base prompt with tool prompt", () => {
    const result = buildSystemPrompt("base", [{ name: "bash", inputSchema: {}, prompt: "rules" }]);
    expect(result).toBe("base\n\n---\n\n## Tool: bash\nrules");
  });

  it("returns base prompt when no tool has prompt", () => {
    const result = buildSystemPrompt("base", [{ name: "bash", inputSchema: {} }]);
    expect(result).toBe("base");
  });

  it("returns tool prompt when no base prompt", () => {
    const result = buildSystemPrompt(undefined, [
      { name: "bash", inputSchema: {}, prompt: "rules" },
    ]);
    expect(result).toBe("## Tool: bash\nrules");
  });

  it("returns undefined when no base and no tool prompts", () => {
    const result = buildSystemPrompt(undefined, []);
    expect(result).toBeUndefined();
  });
});
