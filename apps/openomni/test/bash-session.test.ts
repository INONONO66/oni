import { expect, test } from "bun:test";
import { readUntilMarker, SessionIncomplete } from "../src/bundles/tools/bash";

type View = {
  readonly status: "ok";
  readonly data: Uint8Array;
  readonly cursor: string;
  readonly truncated: boolean;
};

function scriptedRead(chunks: readonly string[]) {
  let index = 0;
  return async (_cursor: string, _waitMs: number): Promise<View> => ({
    status: "ok",
    data: new TextEncoder().encode(chunks[index++] ?? ""),
    cursor: `c${index}`,
    truncated: false,
  });
}

test.each([
  ["zero", "output\nnonce:0\n", 0],
  ["non-zero", "output\nnonce:7\n", 7],
])("session sentinel reports %s exit code", async (_label, chunk, exitCode) => {
  const result = await readUntilMarker(scriptedRead([chunk]), "c0", "nonce:", "command");
  expect(result.prefix).toBe("output");
  expect(Number.parseInt(result.suffix, 10)).toBe(exitCode);
});

test("session sentinel survives a quiet round between output chunks", async () => {
  const result = await readUntilMarker(
    scriptedRead(["first\n", "", "second\nnonce:0\n"]),
    "c0",
    "nonce:",
    "command",
  );
  expect(result.prefix).toBe("first\nsecond");
});

test("session drain cap reports an explicit typed incomplete result", async () => {
  await expect(
    readUntilMarker(
      scriptedRead(Array.from({ length: 33 }, () => "")),
      "c0",
      "nonce:",
      "command",
    ),
  ).rejects.toBeInstanceOf(SessionIncomplete);
});
