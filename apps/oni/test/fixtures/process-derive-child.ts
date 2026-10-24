import { createInterface } from "node:readline";
import { Effect, Logger } from "effect";
import { z } from "zod";
import { createProcessReplyChannel, ProcessReplyReceipt } from "../../src/composition/process-replies";
import { runEffect } from "../helpers/effect";

const warnings: { ref: string; err: string }[] = [];
const logger = Logger.make((entry) => {
  if (entry.logLevel !== "Warn") return;
  for (const value of z.array(z.union([z.string(), z.object({ ref: z.string(), err: z.string() })])).parse(entry.message)) {
    if (typeof value !== "string") warnings.push(value);
  }
});
const receipts: string[] = [];
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => receipts.push(line));
const channel = createProcessReplyChannel(process.stdin, console.log, runEffect);
try {
  await channel.first;
  const result = await runEffect(channel.media.derive(
    { kind: "audio", ref: "mac:/inbox/note.ogg", mime: "audio/ogg" },
    { input: ["text", "image"], api: { npm: "@ai-sdk/openai", style: "responses" } },
  ).pipe(Effect.provide(Logger.layer([logger]))));
  console.log(JSON.stringify({ sessionIds: [JSON.stringify({ result, warnings, receipt: ProcessReplyReceipt.parse(JSON.parse(receipts[1] ?? "null")) })] }));
} finally {
  lines.close();
  channel.close();
}
