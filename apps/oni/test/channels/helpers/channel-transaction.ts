import { Effect, Result } from "effect";
import { decodeChannelFailure, type ChannelError } from "../../../../../packages/channels/src/errors.js";
import { runEffect } from "../../../../../packages/channels/test/helpers/effect.js";
import { ledger } from "./ledger.js";

/** Match the gateway's atomic synchronous admission boundary, including rollback on failure. */
export function channelTransaction<A>(operation: Effect.Effect<A, ChannelError>): Effect.Effect<A, ChannelError> {
  return Effect.try({
    try: () => ledger().stores.transaction(() => Result.getOrThrowWith(
      runEffect(Effect.result(operation), "sync"),
      (error: ChannelError) => error,
    )),
    catch: decodeChannelFailure("message.transaction"),
  });
}
