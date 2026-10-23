import { expect, test } from "bun:test";
import { Core, Testing } from "@oni/agent";
import { Cause, Effect, Exit, Result } from "effect";
import { configureFailures } from "../src/composition/failure";
import { AppInvariantError } from "../src/invariant";
import { runSyncEffect } from "./helpers/effect";

test.each(["absent", "stale"] as const)("configure facade preserves the %s authority contract", (authority) => {
  const plane = Testing.openLedgerPlane({ now: () => 1 });
  try {
    runSyncEffect(plane.session("s").create({
      parentId: null, role: "resident",
      genesis: { tools: [], system: { preset: "", blocks: [] }, policyGeneration: 0, actionId: "genesis", at: 1 },
    }));
    const kernel = plane.openKernel("s");
    if (authority === "stale") runSyncEffect(Testing.adoptSessionAuthority(kernel, "s", "first"));
    const result = runSyncEffect(Effect.exit(Effect.result(plane.session("s").configureTools([], {
      ...configureFailures,
      authorizeConfigure: () => Testing.adoptSessionAuthority(kernel, "s", "successor").pipe(Effect.as(true)),
      generations: { configure: <A>(_id: object, _snapshot: object, commit: Effect.Effect<A, Core.SessionError>) => commit },
      clock: () => 2, entropy: () => "configure",
    }))));
    if (authority === "absent") {
      expect(Exit.isFailure(result) ? Cause.squash(result.cause) : undefined).toBeInstanceOf(AppInvariantError);
      expect(Exit.isFailure(result) ? result.cause : undefined).toEqual(
        Cause.die(new AppInvariantError("session has no activation authority: s")),
      );
    } else {
      const failure = Exit.isSuccess(result) && Result.isFailure(result.value) ? result.value.failure : undefined;
      expect(failure).toMatchObject({
        _tag: "AgentFailure", operation: "session.configure",
        cause: String(new Core.CommitRefused({
          sessionId: "s", reason: "fence", expectedRevision: 1, currentRevision: 1,
          fence: 1, currentFence: 2,
        })),
      });
    }
    expect(kernel.latestGenerationFor("s").generation).toBe(1);
  } finally {
    plane.close();
  }
});
