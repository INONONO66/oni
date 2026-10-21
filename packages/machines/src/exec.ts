import { spawn } from "node:child_process";
import { Machine } from "@oni/protocol";
import { Deferred, Effect, Exit } from "effect";
import { z } from "zod";
import { SpawnFailure, type MachineError } from "./errors";
import { onAbort } from "./interrupt-on";

const spawnFailure = z.preprocess(String, z.string()).transform((cause) => new SpawnFailure({ operation: "exec.spawn", message: cause, cause })).parse;
const killFailure = z.object({ code: z.enum(["ESRCH", "EPERM"]) });

/** Cancellation interrupts, kills the process group, and waits for its close event. */
export function execute(request: Machine.ExecRequest, signal: AbortSignal): Effect.Effect<Machine.ExecResult, MachineError> {
  return Effect.gen(function* () {
    if (signal.aborted) return yield* Effect.interrupt;
    const closed = yield* Deferred.make<Machine.ExecResult, MachineError>();
    const child = yield* Effect.try({ try: () => spawn("/bin/sh", ["-c", request.cmd], { cwd: request.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] }), catch: spawnFailure });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let exited = false;
    let failed: SpawnFailure | undefined;
    const kill = () => {
      if (child.pid === undefined || exited) return;
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) {
        if (killFailure.safeParse(error).success) child.kill("SIGKILL");
        else throw error;
      }
    };
    const capture = (target: Buffer[], chunk: Buffer) => {
      const remaining = Machine.EXEC_MAX_BYTES - size;
      target.push(chunk.subarray(0, remaining));
      size += Math.min(remaining, chunk.length);
      if (chunk.length > remaining) { truncated = true; kill(); }
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", (error) => { failed = spawnFailure(error); });
    child.once("close", (exitCode, exitSignal) => {
      exited = true;
      Deferred.doneUnsafe(closed, failed ? Exit.fail(failed) : Exit.succeed({ status: "completed", stdout: Buffer.concat(stdout).toString("base64"), stderr: Buffer.concat(stderr).toString("base64"), exitCode, signal: exitSignal, truncated }));
    });
    const abort = onAbort(signal, Effect.interrupt);
    const cleanup = Effect.try({ try: kill, catch: spawnFailure }).pipe(Effect.andThen(Deferred.await(closed)), Effect.asVoid, Effect.orDie);
    const result = yield* Deferred.await(closed).pipe(Effect.raceFirst(abort), Effect.timeoutOption(Machine.EXEC_TIMEOUT_MS), Effect.ensuring(cleanup));
    return result._tag === "None" ? { status: "timed_out" } : result.value;
  });
}
