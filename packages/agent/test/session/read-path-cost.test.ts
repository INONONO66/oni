import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { createSession } from "../../src/core/session/create";
import { Ledger, openLedgerPlane } from "../../src/core/session/host";
import { createSessionRequests } from "../../src/core/session/request";
import { hydrateSessionHistory } from "../../src/inspect/history";
import { isolated, isolatedLedger, isolatedRun } from "../helpers/isolated";
import { paddingActions } from "../helpers/reconstruction-fixture";
import { requestLedger } from "../helpers/request-ledger";
import { seedPolicy } from "../helpers/seed-policy";
import { completingChatSession } from "../helpers/session-chat";
import { allowConfigure, isolatedRuntime, type SessionFixture, silentRuntime, withSessionServices } from "../helpers/session-services";
import { runLedgerSync } from "../store/helpers/effect";
import { testNow } from "../store/helpers/storage";

test("one turn carries its activation hydration and reuses configure reads within a revision", () =>
  isolated(Effect.gen(function* () {
    seedPolicy();
    const runtime = silentRuntime("read-path", "read-path");
    const handle = yield* completingChatSession("S", runtime);
    yield* handle.prompt("warm");
    const { session: store } = isolatedLedger();
    const checkpoints = spyOn(store.actions, "latestFoldCheckpoint");
    const configure = spyOn(store.actions, "configurationActions");
    let reads: { readonly checkpointReads: number; readonly configureReads: number };
    try {
      yield* handle.prompt("measured");
    } finally {
      reads = { checkpointReads: checkpoints.mock.calls.length, configureReads: configure.mock.calls.length };
      checkpoints.mockRestore();
      configure.mockRestore();
    }
    console.log(`read-path turn: checkpointReads=${reads.checkpointReads} configureReads=${reads.configureReads}`);
    expect(reads).toEqual({ checkpointReads: 3, configureReads: 33 });
  })));

test("repeated generation lookups reuse one read until a commit advances the revision", () =>
  isolated(Effect.gen(function* () {
    seedPolicy();
    const runtime = silentRuntime("memo", "memo");
    const handle = yield* completingChatSession("M", runtime);
    yield* handle.prompt("warm");
    const { kernel, session: store } = isolatedLedger();
    const configure = spyOn(store.actions, "configurationActions");
    try {
      const first = kernel.latestGenerationFor("M");
      expect(kernel.latestGenerationFor("M")).toBe(first);
      const unchanged = configure.mock.calls.length;
      yield* handle.prompt("advance");
      const before = configure.mock.calls.length;
      kernel.latestGenerationFor("M");
      expect({ unchanged, reread: configure.mock.calls.length - before }).toEqual({ unchanged: 1, reread: 1 });
    } finally {
      configure.mockRestore();
    }
  })));

const SCANNED_SESSIONS = Number(process.env.READ_PATH_SESSIONS ?? 40);

test("a deadline lookup across many session files retains no session handle", () =>
  isolated(Effect.gen(function* () {
    const directory = mkdtempSync(join(tmpdir(), "request-scan-"));
    const config = {
      now: testNow,
      catalog: { path: join(directory, "catalog.sqlite") },
      sessions: { dir: join(directory, "sessions") },
    };
    const seeding = openLedgerPlane(config);
    for (let index = 0; index < SCANNED_SESSIONS; index += 1)
      runLedgerSync(createSession(seeding, {
        id: `s-${index}`,
        parentId: null,
        role: "resident",
        genesis: {
          tools: [],
          bundles: [],
          system: { preset: "", blocks: [] },
          policyGeneration: 0,
          actionId: `s-${index}:genesis`,
          at: 1,
        },
      }));
    seeding.close();
    const plane = openLedgerPlane(config);
    try {
      const fixture: SessionFixture = {
        clock: () => 100,
        observations: { publish: () => undefined },
        authorizeConfigure: allowConfigure,
        ...isolatedRuntime(),
        openKernel: plane.openKernel,
        listSessions: plane.listSessions,
      };
      const port = yield* withSessionServices(
        createSessionRequests(fixture).pipe(Effect.provideService(Ledger, plane)),
        fixture,
      );
      const handles = () => readdirSync("/dev/fd").length;
      const baseline = handles();
      const started = performance.now();
      expect(port.list()).toEqual([]);
      const listed = handles() - baseline;
      const missing = yield* Effect.exit(port.timeout("absent", 100));
      const scanned = handles() - baseline;
      const ms = (performance.now() - started).toFixed(1);
      console.log(`request scan @${SCANNED_SESSIONS} sessions: retained after list=${listed} after deadline lookup=${scanned} scan=${ms}ms`);
      expect(Exit.isFailure(missing)).toBe(true);
      expect({ listed, scanned }).toEqual({ listed: 0, scanned: 0 });
    } finally {
      plane.close();
      rmSync(directory, { recursive: true });
    }
  })));

test("repeated hydrations past one fold checkpoint validate its seed once", () => isolatedRun((ledger) => {
  const recording = requestLedger();
  const id = recording.identity.sessionId;
  expect(recording.commitBatch(paddingActions(id, recording.identity.turnId, 300)).ok).toBe(true);
  expect(ledger.kernel.latestFoldCheckpoint(id).checkpoint).toBeDefined();
  const actions = ledger.session.actions;
  const original = actions.latestFoldCheckpoint.bind(actions);
  let payloadReads = 0;
  const watch = spyOn(actions, "latestFoldCheckpoint").mockImplementation((sessionId, through) => {
    const found = original(sessionId, through);
    if (found === undefined) return found;
    const { effect, ...rest } = found;
    return Object.defineProperty({ ...rest }, "effect", {
      enumerable: true,
      get: () => {
        payloadReads += 1;
        return effect;
      },
    }) as typeof found;
  });
  try {
    hydrateSessionHistory(ledger.kernel, id);
    const first = payloadReads;
    for (let index = 0; index < 4; index += 1) hydrateSessionHistory(ledger.kernel, id);
    payloadReads -= first;
  } finally {
    watch.mockRestore();
  }
  console.log(`checkpoint payload reads over 4 repeat hydrations: ${payloadReads}`);
  expect(payloadReads).toBe(0);
}));
