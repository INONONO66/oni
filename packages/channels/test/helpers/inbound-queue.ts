import type { Channel } from "@oni/protocol";
import { bounded } from "./bounded";

export function inboundQueue(adapter: Pick<Channel.Surface, "onMessage">) {
  const inbound: Channel.InboundMessage[] = [];
  const waiters: Array<(message: Channel.InboundMessage) => void> = [];
  const next = () => {
    const waiter = Promise.withResolvers<Channel.InboundMessage>();
    waiters.push(waiter.resolve);
    return bounded(waiter.promise);
  };
  adapter.onMessage(async (message) => {
    inbound.push(message);
    waiters.shift()?.(message);
  });
  return { inbound, next };
}
