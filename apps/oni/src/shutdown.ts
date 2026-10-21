import { Core } from "@oni/agent";
const closeSessions = Core.closeSessions;
type SessionError = Core.SessionError;
type SessionRuntime = Core.SessionRuntime;
import { Effect, Result } from "effect";
import { type AppLifecycleFailure, lifecycleFailure } from "./runtime";

export function shutdownSessions(runtime: SessionRuntime, recovery: Promise<void>) {
  // Recovery and retained raw work are owned by the app Scope, not this waiter.
  // Both waiters run to completion; any failure fails the whole with one Option per waiter.
  return Effect.all(
    [
      closeSessions(runtime),
      Effect.tryPromise({ try: () => recovery, catch: lifecycleFailure("sessions.recovery") }),
    ],
    { concurrency: 2, mode: "result" },
  ).pipe(Effect.flatMap((results: readonly Result.Result<void, SessionError | AppLifecycleFailure>[]) =>
    results.some(Result.isFailure) ? Effect.fail(results.map(Result.getFailure)) : Effect.void));
}
