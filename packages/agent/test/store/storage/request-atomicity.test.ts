import { sessionTree } from "../helpers/session-tree";
import { Effect, Result } from "effect";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BusEvent, L0Observation, type ObservationSink } from "@oni/protocol";
import { openCatalogStore } from "../../../src/core/store/catalog";
import { openSessionStore } from "../../../src/core/store/session-file";
import * as SessionHandleStore from "../../../src/core/store/fence";
import { runLedgerSync } from "../helpers/effect";
import { expectCommitted, requestFixture, requestStateAction } from "../helpers/request";
import { testNow, useSqliteStores } from "../helpers/storage";

const stores = useSqliteStores("request-atomicity");

test("failed request insert rolls back original action, revision and observation", () => {
  const { request, original, commit } = requestFixture(stores.kernel);
  using raw = new Database(stores.sessionPath);
  raw.run(`CREATE TRIGGER refuse_request BEFORE INSERT ON action WHEN NEW.kind = 'request'
    BEGIN SELECT RAISE(ABORT, 'request write failed'); END`);
  const before = stores.kernel.row(request.sessionId);
  const tree = sessionTree(request.sessionId, stores.session.actions);
  expect(() => commit([original, requestStateAction(request)])).toThrow(
    expect.objectContaining({ _tag: "AgentFailure" }),
  );
  expect(stores.kernel.row(request.sessionId)).toEqual(before);
  expect(sessionTree(request.sessionId, stores.session.actions)).toEqual(tree);
  expect(stores.kernel.requestRows()).toEqual([]);
});

test("request commit requires the adopted fence rather than borrowing another owner's fence", () => {
  const { request, original, commit } = requestFixture(stores.kernel);
  expectCommitted(commit([original, requestStateAction(request)]));
  const before = sessionTree(request.sessionId, stores.session.actions);
  const result = () =>
    Result.getOrThrowWith(
      runLedgerSync(
        Effect.result(
          stores.kernel.commit({
            sessionId: request.sessionId,
            owner: "foreign",
            fence: 1,
            now: 5,
            expectedRevision: stores.kernel.row(request.sessionId).revision,
            actions: [requestStateAction(request, "foreign")],
            state: "idle",
          }),
        ),
      ),
      (error) => error,
    );
  expect(result).toThrow(expect.objectContaining({ _tag: "CommitRefused", reason: "fence" }));
  expect(sessionTree(request.sessionId, stores.session.actions)).toEqual(before);
});

test("commit observations see durable request state after the complete batch", () => {
  const directory = mkdtempSync(join(tmpdir(), "request-atomicity-observed-"));
  const seen: string[] = [];
  let kernel: SessionHandleStore.SessionKernel | undefined;
  const sink: ObservationSink = {
    publish<T>(event: BusEvent.Descriptor<T>, data: T) {
      if (event.name !== L0Observation.ActionCommittedEvent.name) return;
      const receipt = L0Observation.ActionCommitted.parse(data);
      if (receipt.sessionId !== "request-session" || receipt.revision < 3) return;
      expect(kernel?.requestById("original")?.state).toBe("open");
      seen.push(receipt.sessionId);
    },
  };
  const session = openSessionStore(join(directory, "session.sqlite"), { now: testNow, observationSink: sink });
  const catalog = openCatalogStore(join(directory, "catalog.sqlite"), { now: testNow, observationSink: sink });
  try {
    kernel = SessionHandleStore.createSessionKernel(session, catalog);
    const { request, original, commit } = requestFixture(kernel);
    expectCommitted(commit([original, requestStateAction(request)]));
    expect(request.sessionId).toBe("request-session");
    expect(seen.length).toBeGreaterThan(0);
  } finally {
    session.close();
    catalog.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
