import { expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { createCliDeps } from "../src/cli/main";
import { bounded } from "./helpers/protected-dispatch";

test.each([
  { secret: false, fallback: undefined },
  { secret: false, fallback: "default" },
  { secret: true, fallback: undefined },
])("readline adapter returns a terminal answer: %j", async (options) => {
  const input = new PassThrough();
  Object.defineProperty(input, "isTTY", { value: true });
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
  const stdout = Object.getOwnPropertyDescriptor(process, "stdout");
  if (stdin === undefined || stdout === undefined) throw new Error("stdio descriptor missing");
  const prompted = Promise.withResolvers<void>();
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk: string | Uint8Array, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      chunks.push(String(chunk));
      prompted.resolve();
      callback();
    },
  });
  // Both sides must be terminal-capable: otherwise ordinary readline also
  // suppresses echo and the secret test passes with masking disabled.
  Object.defineProperty(output, "isTTY", { value: true });
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  Object.defineProperty(process, "stdout", { value: output, configurable: true });
  try {
    const answer = createCliDeps().ask("fixture", options);
    await bounded(prompted.promise);
    input.write("ANSWER_SENTINEL\n");
    expect(await bounded(answer)).toBe("ANSWER_SENTINEL");
    const rendered = chunks.join("");
    if (options.secret) {
      expect(rendered).not.toContain("ANSWER_SENTINEL");
      // Main's mask is a silent sink, not replacement stars. Require the
      // complete visible prompt and answer terminator, not just absent bytes.
      expect(chunks).toEqual(["fixture: ", "\n"]);
    } else {
      expect(rendered).toContain("ANSWER_SENTINEL");
      if (options.fallback !== undefined) expect(rendered).toContain("[default]");
    }
  } finally {
    Object.defineProperty(process, "stdin", stdin);
    Object.defineProperty(process, "stdout", stdout);
    input.destroy();
    output.destroy();
  }
});
