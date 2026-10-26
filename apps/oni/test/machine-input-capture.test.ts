import { expect, spyOn, test } from "bun:test";
import { Core } from "@oni/agent";
import * as Machines from "@oni/machines";
import { Machine } from "@oni/protocol";
import { Effect } from "effect";
import { startOni } from "../src/index";
import { runEffect } from "./helpers/effect";
import { executor, fixtureLedger } from "./helpers/executor";
import { APPROVAL_POLICY } from "../src/composition/policy";
import { compiledPolicy } from "../../../packages/agent/test/helpers/compiled-policy";
import { executorLayer } from "../../../packages/agent/test/helpers/service-layers";
import { nullRetryAlarm } from "../../../packages/agent/test/helpers/effect-g1";
import { runSyncEffect } from "./helpers/effect";
import { residentSuite } from "./helpers/resident-suite";
import { testSelfMachine } from "./helpers/self-machine";
import { socketPath } from "./helpers/socket-path";

const suite = residentSuite();
type Capture = NonNullable<Parameters<typeof Machines.createMachineHost>[0]["captureInput"]>;

async function withCapture(body: (capture: Capture) => Promise<void>) {
  const createHost = Machines.createMachineHost;
  let captured: Capture | undefined;
  const spy = spyOn(Machines, "createMachineHost").mockImplementation((options: Parameters<typeof createHost>[0]) => {
    captured = options.captureInput;
    return createHost(options);
  });
  try {
    const app = await startOni({ config: suite.config("oni-machine-input-", {
      machines: { self: testSelfMachine(), listen: { unix: socketPath() }, enrolled: [] },
    }) });
    try {
      if (captured === undefined) throw new Error("machine input capture was not installed");
      await body(captured);
    } finally {
      await app.stop();
    }
  } finally {
    spy.mockRestore();
  }
}

const request: Machines.MachineInputCapture = {
  machineId: "desk", generation: 3, method: Machine.WireMethod.InputText, params: { captureId: "cap-1", text: "hi" },
};

test("machine input is captured as a tool effect and forwarded only from the executed body", async () => {
  await withCapture(async (capture) => {
    let forwarded = 0;
    const forward = Effect.sync(() => { forwarded += 1; return { status: "ok" } as const; });
    expect(await runEffect(capture(request, forward))).toEqual({
      status: "refused", reason: "permission_denied", message: "machine input requires an active tool invocation",
    });
    expect(forwarded).toBe(0);
    const outcome = await Core.withExecutor(executor, () => runEffect(capture(request, forward)));
    expect({ outcome, forwarded }).toEqual({ outcome: { status: "ok" }, forwarded: 1 });
  });
});

test("a tool.pre deny on the input op sends nothing and refuses permission_denied", async () => {
  const denying = runSyncEffect(Core.createExecutor({
    approvalPolicy: APPROVAL_POLICY,
    ledger: fixtureLedger,
    identity: { sessionId: "deny", role: "resident", parentActionId: null },
    retryAlarm: nullRetryAlarm,
  }).pipe(Effect.provide(executorLayer({
    policy: compiledPolicy([{
      name: "deny-machine-input", kind: "tool", phase: "pre",
      match: { encodingVersion: 1, value: { op: Machine.WireMethod.InputText } },
      verdict: { encodingVersion: 1, value: { type: "deny", reason: "input_denied" } },
      priority: 1, generation: 1,
    }]),
    clock: () => 1, entropy: () => "deny-action", observations: { publish: () => undefined },
  }))));
  await withCapture(async (capture) => {
    let forwarded = 0;
    const forward = Effect.sync(() => { forwarded += 1; return { status: "ok" } as const; });
    const outcome = await Core.withExecutor(denying, () => runEffect(capture(request, forward)));
    expect({ outcome, forwarded }).toEqual({
      outcome: { status: "refused", reason: "permission_denied", message: "machine input not executed: blocked_pre" },
      forwarded: 0,
    });
  });
});
