import { Data } from "effect";

/**
 * A broken programmer invariant on a synchronous channel-store path — corrupt
 * stored facts or caller misuse. Thrown, never `Effect.fail`ed: these paths
 * are not Effect code and the condition is not a caller-handleable refusal.
 */
export class ChannelStoreInvariant extends Data.TaggedError("ChannelStoreInvariant")<{
  readonly operation: string;
  readonly message: string;
}> {}
