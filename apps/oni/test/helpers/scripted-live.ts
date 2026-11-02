import type { Message } from "@oni/protocol";
import type { LiveEvent, LiveSession } from "../../src/composition/live-session";

export function scriptedLive(steps: readonly (LiveEvent | (() => void | Promise<void>))[]) {
  const sent: Message.Part[] = [];
  const output: Message.Part[] = [];
  let closed = false;
  const live: LiveSession = {
    model: { provider: "scripted", id: "live-fixture" },
    port: {
      events: (async function* () {
        try {
          for (const step of steps) {
            if (typeof step === "function") await step();
            else yield step;
          }
        } finally {
          closed = true;
        }
      })(),
      send: (part) => {
        sent.push(part);
        return Promise.resolve();
      },
    },
    output: (part) => {
      output.push(part);
      return Promise.resolve();
    },
  };
  return { live, sent, output, closed: () => closed };
}
