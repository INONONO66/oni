import { Effect, Result } from "effect";
import { Core } from "@oni/agent";
const ExecutorContext = Core.ExecutorContext;
type ExecutionError = Core.ExecutionError;
type Executor = Core.Executor;
import { executor as productionExecutor } from "./executor";
import { runEffect } from "./effect";

/** Run an Effect-native app consumer with the session's attempt authority. */
export async function admittedEffect<T>(
  operation: Effect.Effect<T, ExecutionError>,
  executor: Executor = productionExecutor,
): Promise<T> {
  return Result.getOrThrowWith(
    await runEffect(Effect.result(Effect.provideService(operation, ExecutorContext, executor))),
    (error) => error,
  );
}
