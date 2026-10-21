import { expect, spyOn, test } from "bun:test";
import { Machine } from "@oni/protocol";
import { Effect, Fiber, Cause, Exit } from "effect";
import { TestClock } from "effect/testing";
import { execute as nativeExecute } from "../src/exec";
import { run } from "./ipc/helpers/effects";
import { exit as runExit, fork } from "./helpers/effect";

const request = { cmd: "while :; do :; done", cwd: "/" };

test("aborting a shell interrupts and waits for its process group to close", async () => {
  const controller = new AbortController();
  const fiber = fork(nativeExecute(request, controller.signal));
  controller.abort();
  const exit = await run(Fiber.await(fiber));
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  const preAborted = await runExit(nativeExecute(request, controller.signal));
  expect(Exit.isFailure(preAborted) && Cause.hasInterrupts(preAborted.cause)).toBe(true);
});

test("the execution deadline kills the real shell and settles timed_out", async () => {
  const result = await run(Effect.scoped(Effect.gen(function* () {
    const fiber = yield* Effect.forkScoped(nativeExecute(request, new AbortController().signal));
    yield* TestClock.adjust(Machine.EXEC_TIMEOUT_MS);
    return yield* Fiber.join(fiber);
  })).pipe(Effect.provide(TestClock.layer())));
  expect(result).toEqual({ status: "timed_out" });
});

// Preserve the line-pinned runner sites above without growing the boundary allowlist.
import * as childProcess from "node:child_process";
import { within } from "./ipc/helpers/signal";

test.each(["ESRCH", "EPERM", "EINVAL"])("aborted exec handles group kill failure %s", async (code: string) => {
  const controller = new AbortController();
  const closed = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  const spawn = childProcess.spawn;
  let child: childProcess.ChildProcess | undefined;
  const spawning = spyOn(childProcess, "spawn").mockImplementation(new Proxy(spawn, {
    apply(target: typeof spawn, _receiver: typeof childProcess, args: Parameters<typeof spawn>) {
      child = target(...args);
      child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => closed.resolve({ code: exitCode, signal }));
      child.once("spawn", () => controller.abort());
      return child;
    },
  }));
  const error = Object.assign(new Error(`group kill ${code}`), { code });
  const killing = spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
    expect(pid).toBe(-(child?.pid ?? 0));
    expect(signal).toBe("SIGKILL");
    throw error;
  });
  try {
    const exit = await within(run(Effect.exit(nativeExecute({ cmd: "exec sleep 30", cwd: "/" }, controller.signal))), "aborted exec");
    expect(killing).toHaveBeenCalledTimes(1);
    expect(exit._tag).toBe("Failure");
    if (Exit.isSuccess(exit)) throw new Error("aborted exec succeeded");
    if (code === "EINVAL") {
      expect(exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)).toEqual([
        expect.objectContaining({ _tag: "SpawnFailure", operation: "exec.spawn", cause: String(error) }),
      ]);
    } else {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(await within(closed.promise, "fallback child close")).toEqual({ code: null, signal: "SIGKILL" });
    }
  } finally {
    killing.mockRestore();
    spawning.mockRestore();
    if (child !== undefined) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await within(closed.promise, "child cleanup");
    }
  }
});
