import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { LedgerAction } from "@oni/protocol";
import { z } from "zod";
import { bounded } from "./bounded";
import { effectValue } from "./native-executor";

const helperScript = new URL("./fiber-outcome-process.ts", import.meta.url).pathname;
const reopened = z.object({
  before: z.array(LedgerAction.Node), after: z.array(LedgerAction.Node),
  repeated: z.array(LedgerAction.Node), results: z.array(LedgerAction.Node),
});

async function barrier(reader: {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
}): Promise<string> {
  const decoder = new TextDecoder();
  let line = "";
  while (!line.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("executor exited before barrier");
    line += decoder.decode(chunk.value, { stream: true });
  }
  return line.slice(0, line.indexOf("\n"));
}

export async function fiberCrashCell(dbPath: string, receipt: "absent" | "present" = "absent") {
  const child = Bun.spawn([process.execPath, helperScript, "execute", dbPath, receipt], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  try {
    const cut = await bounded(barrier(reader), "execute-before-commit barrier");
    expect(JSON.parse(cut)).toEqual({
      barrier: "fiber_exit_after_execute_before_action_commit",
    });
    expect(readFileSync(`${dbPath}.effect`, "utf8")).toBe("write-once\n");
    child.kill("SIGKILL");
    await bounded(child.exited, "killed executor exit");
    expect(await stderr).toBe("");
  } finally {
    reader.releaseLock();
    child.kill("SIGKILL");
  }
  const recovery = Bun.spawn([process.execPath, helperScript, "recover", dbPath, receipt], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, errors] = await bounded(Promise.all([
    recovery.exited, new Response(recovery.stdout).text(), new Response(recovery.stderr).text(),
  ]), "fresh process boot sweep");
  expect({ code, errors }).toEqual({ code: 0, errors: "" });
  const witness = reopened.parse(JSON.parse(stdout));
  expect(witness.after.slice(0, witness.before.length)).toEqual(witness.before);
  expect(witness.repeated).toEqual(witness.after);
  expect(witness.results).toHaveLength(1);
  expect(witness.results.map(effectValue)).toMatchObject([{
    terminal: receipt === "absent" ? "outcome_unknown" : "executed",
    recovery: { site: "crash", proof: receipt === "absent" ? "indeterminate" : "applied" },
  }]);
  expect(readFileSync(`${dbPath}.effect`, "utf8")).toBe("write-once\n");
  return receipt === "absent" ? "lost" : "resumed_without_reexecution";
}
