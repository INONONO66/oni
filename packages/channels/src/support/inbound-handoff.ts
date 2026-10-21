import { Operational } from "@oni/protocol";
import type { PublishPort } from "../types";
import type { Dedupe } from "./dedupe";

/** Claim before normalization; failed handoffs release only their own claim generation. */
export async function handoffInbound(input: {
  dedupe: Dedupe;
  key: string;
  traceId: string;
  now: () => number;
  publish: PublishPort;
  errorMessage: string;
  rethrowFailure: boolean;
  handle: () => Promise<void>;
}): Promise<void> {
  const acquisition = input.dedupe.acquire(input.key);
  if (acquisition.duplicate) return;
  try {
    await input.handle();
  } catch (error) {
    input.dedupe.forget(input.key, acquisition.token);
    input.publish(Operational.Events.Error, {
      traceId: input.traceId,
      time: input.now(),
      component: "server",
      msg: input.errorMessage,
      context: { err: String(error) },
    });
    if (input.rethrowFailure) throw error;
  }
}
