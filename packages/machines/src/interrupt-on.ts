import { listenForAbort } from "@oni/protocol";
import { Effect } from "effect";

/** Machines-local connector: resumes with `outcome` when `signal` aborts; interrupting the waiter detaches the listener. */
export const onAbort = <A, E = never>(signal: AbortSignal, outcome: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.callback<A, E>((resume) => Effect.sync(listenForAbort(signal, () => resume(outcome))));
