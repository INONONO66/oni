import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { Ipc } from "@oni/protocol";
import type { z } from "zod";
import { connectIpcClient, createIpcServer, typedCall } from "./helpers/native";
import { socketPath } from "./helpers/socket-path";

const fixtureConfig = fileURLToPath(
  new URL("./typed-facade-fixtures/tsconfig.json", import.meta.url),
);

test("typed facade rejects schema-invalid calls while generic calls remain valid", () => {
  const config = ts.readConfigFile(fixtureConfig, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, fileURLToPath(new URL("./typed-facade-fixtures", import.meta.url)));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  expect(ts.getPreEmitDiagnostics(program)).toHaveLength(0);
}, 15_000);

test("typed facade round-trips a known method through the public transport barrel", async () => {
  const path = socketPath("typed-call");
  const params = { cellId: "typed-cell", code: "21 * 2", timeoutMs: 1_000 };
  const observed: Array<{ method: string; params: z.infer<typeof Ipc.Methods["machine.run_code"]["params"]> }> = [];
  const server = await createIpcServer(path, (method, received, respond) => {
    const request = Ipc.Methods["machine.run_code"].params.parse(received);
    observed.push({ method, params: request });
    respond(
      Ipc.Methods["machine.run_code"].result.parse({
        status: "completed",
        cellId: request.cellId,
        output: { stdout: request.code, stderr: "" },
        value: "42",
      }),
    );
  });
  try {
    const client = await connectIpcClient(path);
    try {
      const result = await typedCall(client, "machine.run_code", params, 1_000);
      expect(observed).toEqual([{ method: "machine.run_code", params }]);
      expect(result).toEqual({
        status: "completed",
        cellId: "typed-cell",
        output: { stdout: "21 * 2", stderr: "" },
        value: "42",
      });
    } finally {
      client.close();
    }
  } finally {
    server.close();
  }
});
