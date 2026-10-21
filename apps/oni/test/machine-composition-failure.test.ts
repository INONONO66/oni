import { expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import * as Machines from "@oni/machines";
import type { Machine } from "@oni/protocol";
import * as Codemode from "../src/composition/codemode";
import { startOni } from "../src/index";
import { runEffect } from "./helpers/effect";
import { socketPath } from "./helpers/socket-path";
import { testSelfMachine } from "./helpers/self-machine";

test("the app machine host translates a codemode failure at its callback boundary", async () => {
  const createHost = Machines.createMachineHost;
  const compose = Codemode.composeCodemode;
  let callTool: Parameters<typeof createHost>[0]["callTool"] | undefined;
  const capture = spyOn(Machines, "createMachineHost").mockImplementation((options: Parameters<typeof createHost>[0]) => {
    callTool = options.callTool;
    return createHost(options);
  });
  const failure = new Machines.MachinesFailure({ operation: "code.tool", cause: "lost cell" });
  const failCell = spyOn(Codemode, "composeCodemode").mockImplementation((host: Machines.MachineHost, sources: { readonly id: () => string }) =>
    compose(host, sources).pipe(Effect.map((mode: Codemode.ComposedCodemode) => ({
      ...mode, callTool: (_call: Machine.ToolCall) => Effect.fail(failure),
    }))),
  );
  try {
    const app = await startOni({ config: {
      host: "127.0.0.1", wsPort: 0,
      kek: { kind: "locked", reason: "no vault key in this fixture" },
      model: { provider: "fake", id: "fixture", apiKey: "fixture" },
      machines: { self: testSelfMachine(), listen: { unix: socketPath() }, enrolled: [] },
    } });
    try {
      if (callTool === undefined) throw new Error("machine callback was not installed");
      expect(await runEffect(Effect.flip(callTool({ cellId: "cell", name: "read", arguments: {} })))).toMatchObject({
        _tag: "MachinesFailure", operation: "codemode.callTool", cause: String(failure),
      });
      expect((await fetch(`http://127.0.0.1:${app.port}/health`)).status).toBe(200);
    } finally {
      await app.stop();
    }
  } finally {
    capture.mockRestore();
    failCell.mockRestore();
  }
});
