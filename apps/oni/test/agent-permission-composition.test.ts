// Loaded first on purpose: when `src/index` is the first module to reach the
// role presets, Bun skips the `roleText` macro (#1644, reproducible on main).
import "../src/bundles/prompt/roles";
import { expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { startOni } from "../src/index";
import * as AgentPermission from "../src/bundles/approval-policy/agent-permission";
import { runEffect } from "./helpers/effect";
import { residentSuite } from "./helpers/resident-suite";
import { testSelfMachine } from "./helpers/self-machine";
import { socketPath } from "./helpers/socket-path";

const suite = residentSuite();
type Deps = Parameters<typeof AgentPermission.createAgentPermissionPort>[0];

/** Boots the app and hands back the dependencies the composition gave the permission port. */
async function withComposedPort(body: (deps: Deps) => Promise<void>) {
  const create = AgentPermission.createAgentPermissionPort;
  let captured: Deps | undefined;
  const spy = spyOn(AgentPermission, "createAgentPermissionPort").mockImplementation((deps: Deps) => {
    captured = deps;
    return create(deps);
  });
  try {
    const app = await startOni({ config: suite.config("oni-agent-permission-", {
      machines: { self: testSelfMachine(), listen: { unix: socketPath() }, enrolled: [] },
    }) });
    try {
      if (captured === undefined) throw new Error("agent permission port was not composed");
      await body(captured);
    } finally {
      await app.stop();
    }
  } finally {
    spy.mockRestore();
  }
}

test("the composed port delivers through the session entity and a receiver that was never activated is one typed refusal", async () => {
  await withComposedPort(async (deps) => {
    // No cli turn runs, so no child has an owner before the runner is composed.
    expect(deps.owner("agent-unowned")).toBeUndefined();
    const refused = await runEffect(
      deps
        .deliver("session-missing", { kind: "action", body: "{}", source: "{}", idempotencyKey: "agent-permission:x" })
        .pipe(Effect.flip),
    );
    expect(refused).toBeInstanceOf(Error);
    expect(refused).toMatchObject({ _tag: "AdmissionFailure", code: "activation" });
  });
});
