import { sessionTree } from "../helpers/session-tree";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { L0Observation } from "@oni/protocol";
import { materializeSession } from "../helpers/session";
import { useMemoryStores } from "../helpers/storage";
import { Bus } from "../helpers/observation";

const stores = useMemoryStores(Bus);
beforeEach(() => Bus.reset());
afterEach(() => Bus.reset());

test("canonical commit observation sees the already durable row and action", async () => {
  const seen = Promise.withResolvers<L0Observation.ActionCommitted>();
  const stop = Bus.subscribe(L0Observation.ActionCommittedEvent, seen.resolve);
  const timeout = setTimeout(() => seen.reject(new Error("commit observation timed out")), 1000);
  try {
    materializeSession(stores.kernel, "observed");
    const event = await seen.promise;
    expect(event).toEqual({
      id: "observed:configure",
      sessionId: "observed",
      kind: "session.configure",
      revision: 1,
    });
    expect(stores.kernel.row(event.sessionId).revision).toBe(event.revision);
    expect(sessionTree(event.sessionId, stores.session.actions).map((action) => action.id)).toEqual(
      [event.id],
    );
  } finally {
    clearTimeout(timeout);
    stop();
  }
});
