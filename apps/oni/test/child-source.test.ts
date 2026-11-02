import { expect, test } from "bun:test";
import type { MachineHandle } from "@oni/machines";
import type { Machine } from "@oni/protocol";
import { Effect } from "effect";
import { type ChildRow, contactCursor } from "../src/bundles/child-activity/reconcile";
import { agentSessionTail, childSource, type ChildSourcePorts } from "../src/composition/watch-sources";
import { spec } from "./helpers/child-activity";
import { runEffect } from "./helpers/effect";

const EMPTY_PAGE: Machine.AgentSessionTailResult = { status: "ok", records: [], cursor: spec.cursor, hasMore: false };

/** Ports whose every tail answers through the caller's queue of settled or deferred results. */
function tailPorts(answer: () => Promise<Machine.AgentSessionTailResult>): ChildSourcePorts {
  return {
    machines: { get: () => ({ agentSession: { tail: answer } }) },
    rows: () => [],
    admit: async (_sessionId, added) => added,
  };
}

test("agent transcript pages admit child facts and restore the server cursor", async () => {
  const rows: ChildRow[] = [];
  const last = { ...spec.cursor, byteOffset: 64, recordHash: "c".repeat(64) };
  const pages: Machine.AgentSessionTailResult[] = [
    { status: "ok", records: [{ kind: "turn", role: "user", text: "hello" }], cursor: { ...spec.cursor, byteOffset: 32, recordHash: "b".repeat(64) }, hasMore: true },
    { status: "ok", records: [{ kind: "turn", role: "assistant", text: "done" }], cursor: last, hasMore: false },
  ];
  const reads: number[] = [];
  const ports: ChildSourcePorts = {
    machines: {
      get: () => ({
        agentSession: {
          tail: async (input) => {
            if (!("cursor" in input)) throw new Error("expected server cursor");
            reads.push(input.cursor.byteOffset);
            return pages.shift() ?? { status: "ok", records: [], cursor: input.cursor, hasMore: false };
          },
        },
      }),
    },
    rows: () => rows,
    admit: async (_sessionId, added) => {
      rows.push(...added);
      return added;
    },
  };
  const failures: Error[] = [];
  const source = childSource(spec, ports, { clock: () => 100, failure: (error) => failures.push(error) });
  await source.ready;
  expect(reads).toEqual([0, 32]);
  expect(rows.filter((row) => row.kind === "child_fact").map((row) => row.content.phase)).toEqual(["observed", "terminal"]);
  expect(rows.filter((row) => row.kind === "child_receipt")).toHaveLength(2);
  expect(contactCursor(rows, spec.contact)).toEqual(last);
  await source.close();
  const restored = childSource(spec, ports, { clock: () => 101, failure: (error) => failures.push(error) });
  await restored.ready;
  expect(reads).toEqual([0, 32, 64]);
  expect(rows.filter((row) => row.kind === "child_fact")).toHaveLength(2);
  expect(failures).toEqual([]);
  await restored.close();
});

test("a refused first page fails the source's readiness as the typed child-source error", async () => {
  const drained: boolean[] = [];
  const failures: Error[] = [];
  const source = childSource(
    spec,
    tailPorts(async () => ({ status: "refused", reason: "session_not_found" })),
    { clock: () => 1, failure: (error) => failures.push(error), drained: (progress) => drained.push(progress) },
  );
  await expect(source.ready).rejects.toMatchObject({ name: "ChildSourceError", code: "tail_refused", message: "child source: tail_refused" });
  expect(drained).toEqual([false]);
  expect(failures).toEqual([]);
  // A later observe chains on the failed readiness: the failure door hears it once, the chain stays usable.
  await source.observe();
  expect(failures.map((error) => error.message)).toEqual(["child source: tail_refused"]);
  expect(drained).toEqual([false, false]);
});

test("a drain that rejects after readiness reports no progress and the failure, and the next drain still runs", async () => {
  const drained: boolean[] = [];
  const failures: Error[] = [];
  const deferred = Promise.withResolvers<Machine.AgentSessionTailResult>();
  const requested = Promise.withResolvers<void>();
  const answers: (() => Promise<Machine.AgentSessionTailResult>)[] = [
    () => Promise.resolve(EMPTY_PAGE),
    () => {
      requested.resolve();
      return deferred.promise;
    },
    () => Promise.resolve(EMPTY_PAGE),
  ];
  const source = childSource(
    spec,
    tailPorts(() => (answers.shift() ?? (() => Promise.reject(new Error("no more pages"))))()),
    { clock: () => 1, failure: (error) => failures.push(error), drained: (progress) => drained.push(progress) },
  );
  await source.ready;
  expect(drained).toEqual([true]);
  const observed = source.observe();
  await requested.promise;
  deferred.reject(new Error("transport lost"));
  await observed;
  expect(drained).toEqual([true, false]);
  expect(failures.map((error) => error.message)).toEqual(["transport lost"]);
  await source.observe();
  expect(drained).toEqual([true, false, true]);
  await source.close();
  expect(answers).toEqual([]);
});

test("the agent-session tail port runs the host handle's tail through the caller's boundary and names a machine without one", async () => {
  const tails: Machine.AgentSessionTailRequest[] = [];
  const agentSession: NonNullable<MachineHandle["agentSession"]> = {
    list: () => Effect.die(new Error("unused")),
    open: () => Effect.die(new Error("unused")),
    send: () => Effect.die(new Error("unused")),
    stop: () => Effect.die(new Error("unused")),
    tail: (input) => Effect.sync(() => {
      tails.push(input);
      return EMPTY_PAGE;
    }),
  };
  const ran: number[] = [];
  const port = agentSessionTail(
    { get: (id) => ({ agentSession: id === "body" ? agentSession : undefined }) },
    (effect) => {
      ran.push(1);
      return runEffect(effect);
    },
  );
  await expect(port.get("body").agentSession.tail({ cursor: spec.cursor })).resolves.toEqual(EMPTY_PAGE);
  expect(tails).toEqual([{ cursor: spec.cursor }]);
  expect(ran).toEqual([1]);
  expect(() => port.get("brain").agentSession.tail({ cursor: spec.cursor })).toThrow("machine brain does not support agent sessions");
  expect(ran).toEqual([1]);
});
