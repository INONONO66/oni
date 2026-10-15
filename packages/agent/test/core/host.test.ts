import { afterAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteError } from "bun:sqlite";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { TestClock } from "effect/testing";
import { SessionEntity } from "../../src/core/session/entity";
import { Ledger, type LedgerConfig, OpenRefused, openLedger, openLedgerPlane } from "../../src/core/session/host";
import { createSession } from "../../src/core/session/create";
import { createSessionRequests } from "../../src/core/session/request";
import * as SessionFile from "../../src/core/store/session-file";
import type { SessionStore } from "../../src/core/store/session-file";
import { Entropy } from "../../src/core/ports/ports";
import { releaseSessionKernel } from "../../src/core/store/fence";
import { TEST_APPROVAL_POLICY } from "../helpers/approval-policy";
import {
  BunTestCrypto,
  clusterMessages,
  indexResident,
  makeTurnPort,
  materializeResident,
  readChain,
  resolvedRunner,
  sessionFileClosed,
  verifyChain,
} from "../helpers/cluster-runtime";
import { runAgent } from "../helpers/isolated";

const root = mkdtempSync(join(tmpdir(), "core-host-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const bunCrypto = BunTestCrypto;

/** Counts the session stores the host opens and still holds, free of process-wide descriptor noise. */
function trackSessionStores() {
  const live = new Set<SessionStore>();
  let opened = 0;
  const open = SessionFile.openSessionStore;
  const spy = spyOn(SessionFile, "openSessionStore").mockImplementation((path, options) => {
    const store = open(path, options);
    const view: SessionStore = Object.create(store, {
      close: { value: () => { store.close(); live.delete(view); }, writable: true, configurable: true },
    });
    opened += 1;
    live.add(view);
    return view;
  });
  return { live: () => live.size, opened: () => opened, restore: () => spy.mockRestore() };
}

const drain = {
  alarmsBeforePrompt: 4,
  maxArmed: 64,
  idleMs: 60_000,
  sweep: { full: false, idleDays: 7 },
};

function fixedPorts(runTurn = makeTurnPort(resolvedRunner("ok"))): LedgerConfig["ports"] {
  return {
    approvalPolicy: TEST_APPROVAL_POLICY,
    runTurn,
    inputRegistrations: ["prompt", "signal"],
    capabilityKinds: ["tool", "compaction"],
  };
}

function home(name: string): { catalogPath: string; sessionsDir: string } {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return { catalogPath: join(dir, "catalog.sqlite"), sessionsDir: join(dir, "sessions") };
}

/** Process descriptors; other tests' handles may close meanwhile, so callers assert no growth. */
function descriptorCount(): number {
  return readdirSync("/dev/fd").length;
}

type Plane = ReturnType<typeof openLedgerPlane>;

const createPlaneSession = (plane: Plane, id: string, at: number) =>
  runAgent(
    createSession(plane, {
      id,
      parentId: null,
      role: "resident",
      genesis: {
        tools: [],
        bundles: [],
        system: { preset: "", blocks: [] },
        policyGeneration: 0,
        actionId: `${id}:genesis`,
        at,
      },
    }),
  );

async function createFileSessions(plane: Plane, count: number): Promise<void> {
  for (let n = 0; n < count; n += 1) {
    const id = `s${n}`;
    await createPlaneSession(plane, id, n);
    plane.releaseSession(id);
  }
}

/** The request port over one plane, with a fixed request owner. */
const requestPort = (plane: Plane) =>
  runAgent(
    createSessionRequests({
      approvalPolicy: TEST_APPROVAL_POLICY,
      authorizeConfigure: () => Effect.succeed(true),
      openKernel: plane.openKernel,
      listSessions: plane.listSessions,
    }).pipe(Effect.provideService(Entropy, { id: () => "request-owner", random: () => 0 })),
  );

function config(overrides: Partial<LedgerConfig>): LedgerConfig {
  return {
    now: () => Date.now(),
    owner: "host-test",
    cluster: { storagePath: ":memory:", entityIdleMs: 60_000 },
    drain,
    ports: fixedPorts(),
    ...overrides,
  };
}

const materialize = (sessionId: string) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    yield* materializeResident(ledger.openKernel(sessionId), sessionId);
    indexResident(ledger.catalog, sessionId);
  });

const deliverPrompt = (sessionId: string, key: string) =>
  Effect.gen(function* () {
    const makeClient = yield* SessionEntity.client;
    return yield* makeClient(sessionId).Deliver({
      kind: "prompt",
      body: JSON.stringify({ content: `hello ${key}` }),
      source: JSON.stringify({
        kind: "message",
        messageId: key,
        senderSessionId: sessionId,
        sourceActionId: key,
      }),
      idempotencyKey: key,
    });
  });

test("file mode: one scope opens catalog, runner storage and entity; the deliver commits and release closes the catalog", async () => {
  const { catalogPath, sessionsDir } = home("file");
  const sessionId = "file-session";
  const layer = openLedger(
    config({
      catalog: { path: catalogPath },
      sessions: { dir: sessionsDir },
      cluster: { storagePath: catalogPath, entityIdleMs: 60_000 },
    }),
  ).pipe(Layer.provide(bunCrypto));
  const scope = await runAgent(Scope.make());
  const context = await runAgent(Layer.buildWithScope(layer, scope));
  const program = Effect.gen(function* () {
    yield* materialize(sessionId);
    const receipt = yield* deliverPrompt(sessionId, "m1");
    const ledger = yield* Ledger;
    // File mode hands the entity a fresh handle, distinct from the plane's memoized one.
    expect(ledger.handles.openSession(sessionId)).not.toBe(ledger.sessionStore(sessionId));
    expect(ledger.listSessions().map((row) => row.id)).toEqual([sessionId]);
    return receipt;
  }).pipe(Effect.provide(context));
  const receipt = await runAgent(program);
  expect(receipt.existed).toBe(false);
  const file = join(sessionsDir, `${sessionId}.sqlite`);
  expect(verifyChain(file, sessionId)).toBeGreaterThanOrEqual(2);
  expect(readChain(file, sessionId).some((row) => row.id === "m1")).toBe(true);
  expect(clusterMessages(catalogPath, "Session").length).toBeGreaterThan(0);
  await runAgent(Scope.close(scope, Exit.void));
  expect(sessionFileClosed(catalogPath)).toBe(true);
  expect(sessionFileClosed(file)).toBe(true);
});

test("file mode: closing the scope releases the catalog exactly once (#1345 M1)", async () => {
  const { catalogPath, sessionsDir } = home("release-once");
  const sessionId = "release-once-session";
  const layer = openLedger(
    config({
      catalog: { path: catalogPath },
      sessions: { dir: sessionsDir },
      cluster: { storagePath: catalogPath, entityIdleMs: 60_000 },
    }),
  ).pipe(Layer.provide(bunCrypto));
  const scope = await runAgent(Scope.make());
  const context = await runAgent(Layer.buildWithScope(layer, scope));
  const catalog = Context.get(context, Ledger).catalog;
  const closes = spyOn(catalog, "close");
  await runAgent(
    Effect.gen(function* () {
      yield* materialize(sessionId);
      yield* deliverPrompt(sessionId, "m1");
    }).pipe(Effect.provide(context)),
  );
  expect(closes).toHaveBeenCalledTimes(0);
  await runAgent(Scope.close(scope, Exit.void));
  expect(closes).toHaveBeenCalledTimes(1);
  expect(sessionFileClosed(catalogPath)).toBe(true);
});

test("file mode: scanning ignores a session file that cannot open", async () => {
  const { catalogPath, sessionsDir } = home("scan-corrupt");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, "corrupt.sqlite"), "not a database");
  const layer = openLedger(
    config({
      catalog: { path: catalogPath },
      sessions: { dir: sessionsDir },
      cluster: { storagePath: catalogPath, entityIdleMs: 60_000 },
    }),
  ).pipe(Layer.provide(bunCrypto));
  const listed = await runAgent(
    Effect.scoped(
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        return ledger.listSessions().map((row) => row.id);
      }).pipe(Effect.provide(layer)),
    ),
  );
  expect(listed).toEqual([]);
});

test("memory mode: the entity and the plane share one in-memory store per session", async () => {
  const sessionId = "memory-session";
  const layer = openLedger(config({})).pipe(Layer.provide(bunCrypto));
  const seen = await runAgent(
    Effect.scoped(
      Effect.gen(function* () {
        yield* materialize(sessionId);
        const receipt = yield* deliverPrompt(sessionId, "m1");
        const ledger = yield* Ledger;
        // The entity's handle is a view over the plane's memoized store.
        expect(ledger.handles.openSession(sessionId).sessions).toBe(
          ledger.sessionStore(sessionId).sessions,
        );
        expect(ledger.catalogDatabase).toBe(ledger.catalog.database);
        const kernel = ledger.openKernel(sessionId);
        return {
          receipt,
          verdict: kernel.verifyChain(sessionId),
          inputs: kernel.inputMessages(sessionId).length,
        };
      }).pipe(Effect.provide(layer)),
    ),
  );
  expect(seen.receipt.existed).toBe(false);
  expect(seen.verdict.kind).toBe("intact");
  expect(seen.verdict.kind === "intact" && seen.verdict.length).toBeGreaterThanOrEqual(2);
  expect(seen.inputs).toBe(1);
});

test("file mode: catalog listing of 24 sessions closes every store it opens", async () => {
  const { catalogPath, sessionsDir } = home("listing-churn");
  const options = { now: () => 1, catalog: { path: catalogPath }, sessions: { dir: sessionsDir } };
  const creator = openLedgerPlane(options);
  try {
    await createFileSessions(creator, 24);
  } finally {
    creator.close();
  }
  const plane = openLedgerPlane(options);
  const stores = trackSessionStores();
  try {
    const descriptors = descriptorCount();
    for (let listing = 1; listing <= 2; listing += 1) {
      expect(plane.listSessions()).toHaveLength(24);
      expect({ opened: stores.opened(), live: stores.live() }).toEqual({ opened: 24 * listing, live: 0 });
      expect(descriptorCount()).toBeLessThanOrEqual(descriptors);
    }
  } finally {
    stores.restore();
    plane.close();
  }
});

test("file mode: deadline lookup over 24 sessions releases every scoped kernel", async () => {
  const { catalogPath, sessionsDir } = home("deadline-lookup");
  const plane = openLedgerPlane({
    now: () => 1,
    catalog: { path: catalogPath },
    sessions: { dir: sessionsDir },
  });
  await createFileSessions(plane, 24);
  const stores = trackSessionStores();
  try {
    const descriptors = descriptorCount();
    const port = await requestPort(plane);
    const exit = await runAgent(Effect.exit(port.timeout("missing-request", 1)));
    expect(Exit.isFailure(exit)).toBe(true);
    expect({ opened: stores.opened(), live: stores.live() }).toEqual({ opened: 48, live: 0 });
    expect(descriptorCount()).toBeLessThanOrEqual(descriptors);
  } finally {
    stores.restore();
    plane.close();
  }
});

test("memory mode: listing returns created sessions and skips a memoized id that was never created", async () => {
  const plane = openLedgerPlane({ now: () => 1 });
  try {
    for (const id of ["s0", "s1"]) await createPlaneSession(plane, id, 1);
    plane.openKernel("never-created");
    expect(plane.listSessions().map((row) => row.id)).toEqual(["s0", "s1"]);
  } finally {
    plane.close();
  }
});

test("file mode: listing inside a write transaction on a live session reads that session's handle", async () => {
  const { catalogPath, sessionsDir } = home("listing-in-transaction");
  const plane = openLedgerPlane({ now: () => 1, catalog: { path: catalogPath }, sessions: { dir: sessionsDir } });
  try {
    await createPlaneSession(plane, "s0", 1);
    const ids = plane.sessionStore("s0").transaction(() => plane.listSessions().map((row) => row.id));
    expect(ids).toEqual(["s0"]);
  } finally {
    plane.close();
  }
});

test("file mode: a scoped request read keeps a live session's handle and releases only what it opened", async () => {
  const { catalogPath, sessionsDir } = home("scoped-read-live");
  const plane = openLedgerPlane({ now: () => 1, catalog: { path: catalogPath }, sessions: { dir: sessionsDir } });
  await createFileSessions(plane, 2);
  const stores = trackSessionStores();
  try {
    const live = plane.openKernel("s0");
    expect(plane.openKernel("s0")[releaseSessionKernel]).toBeUndefined();
    const port = await requestPort(plane);
    const rows = plane.sessionStore("s0").transaction(() => port.list());
    expect(rows).toEqual([]);
    // s0 is opened once and stays held by its live opener; s1 is opened by the listing and by the read, both closed.
    expect({ opened: stores.opened(), live: stores.live() }).toEqual({ opened: 3, live: 1 });
    expect(live.row("s0").id).toBe("s0");
    live[releaseSessionKernel]?.();
    expect(stores.live()).toBe(0);
  } finally {
    stores.restore();
    plane.close();
  }
});

test("file mode: one failed open among 12 indexed sessions refuses instead of returning partial rows", async () => {
  const { catalogPath, sessionsDir } = home("listing-refused");
  const options = {
    now: () => 1,
    catalog: { path: catalogPath },
    sessions: { dir: sessionsDir },
  };
  const creator = openLedgerPlane(options);
  await createFileSessions(creator, 12);
  creator.close();
  rmSync(join(sessionsDir, "s7.sqlite"));
  mkdirSync(join(sessionsDir, "s7.sqlite"));
  const plane = openLedgerPlane(options);
  try {
    expect(plane.catalog.sessionIds()).toHaveLength(12);
    let error: OpenRefused | undefined;
    try {
      plane.listSessions();
    } catch (cause) {
      if (cause instanceof OpenRefused) error = cause;
      else throw cause;
    }
    expect(error).toBeInstanceOf(OpenRefused);
    expect(error?.code).toBe("sessions");
    expect(error?.cause).toBeInstanceOf(SQLiteError);
    expect(error?.cause).toHaveProperty("errno", 14);
    console.info(`A2 listing refusal=${error?._tag} errno=14`);
    expect(() => plane.openKernel("s7")).toThrow(OpenRefused);
    expect(() => plane.handles.openSession("s7")).toThrow(OpenRefused);
  } finally {
    plane.close();
  }
});

/**
 * Advances the test clock in fixed virtual steps until `done` holds: the
 * cluster's polls and the entity reaper sleep on that clock alone, so the
 * outcome depends on virtual time, never on wall-clock timing.
 */
const stepClockUntil = (done: Effect.Effect<boolean>, label: string, maxSteps = 600) =>
  Effect.gen(function* () {
    for (let step = 0; step < maxSteps; step += 1) {
      if (yield* done) return;
      yield* TestClock.adjust(100);
    }
    return yield* Effect.die(new Error(`${label}: not settled within ${maxSteps} clock steps`));
  });

/** Runs `program` on the test clock: forked, then stepped until its fiber settles. */
const settleOnClock = <A, E, R>(program: Effect.Effect<A, E, R>, label: string) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(program, { startImmediately: true });
    yield* stepClockUntil(
      Effect.sync(() => fiber.pollUnsafe() !== undefined),
      label,
    );
    return yield* Fiber.join(fiber);
  });

test("file mode: a rebuilt host on the same paths lists the session, verifies its chain and commits a new deliver (#1345 M3a)", async () => {
  const { catalogPath, sessionsDir } = home("reopen");
  const sessionId = "reopen-session";
  const host = () =>
    openLedger(
      config({
        catalog: { path: catalogPath },
        sessions: { dir: sessionsDir },
        cluster: { storagePath: catalogPath, entityIdleMs: 60_000 },
      }),
    ).pipe(Layer.provide(bunCrypto));
  const first = await runAgent(
    Effect.scoped(
      Effect.gen(function* () {
        yield* materialize(sessionId);
        return yield* deliverPrompt(sessionId, "m1");
      }).pipe(Effect.provide(host())),
    ),
  );
  expect(first.existed).toBe(false);
  expect(sessionFileClosed(catalogPath)).toBe(true);
  const second = await runAgent(
    Effect.scoped(
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const listed = ledger.listSessions().map((row) => row.id);
        const scannedClosed = sessionFileClosed(join(sessionsDir, `${sessionId}.sqlite`));
        const before = ledger.openKernel(sessionId).verifyChain(sessionId);
        const receipt = yield* deliverPrompt(sessionId, "m2");
        const after = ledger.openKernel(sessionId).verifyChain(sessionId);
        return { listed, scannedClosed, before, receipt, after };
      }).pipe(Effect.provide(host())),
    ),
  );
  expect(second.listed).toEqual([sessionId]);
  expect(second.scannedClosed).toBe(true);
  expect(second.before.kind).toBe("intact");
  expect(second.receipt.existed).toBe(false);
  expect(second.after.kind).toBe("intact");
  const lengthBefore = second.before.kind === "intact" ? second.before.length : -1;
  expect(second.after.kind === "intact" && second.after.length).toBeGreaterThan(lengthBefore);
  const ids = readChain(join(sessionsDir, `${sessionId}.sqlite`), sessionId).map((row) => row.id);
  expect(ids).toContain("m1");
  expect(ids).toContain("m2");
  expect(sessionFileClosed(catalogPath)).toBe(true);
});

test("memory mode: a passivated activation's successor continues the chain on the same shared store (#1345 M3b)", async () => {
  const sessionId = "memory-passivation-session";
  // The live registration's release runs at passivation: the exact signal.
  const passivated = Deferred.makeUnsafe<void>();
  let activations = 0;
  const ports: LedgerConfig["ports"] = {
    ...fixedPorts(),
    onLive: () => {
      activations += 1;
      return () => {
        Deferred.doneUnsafe(passivated, Effect.void);
      };
    },
  };
  const idleMs = 1_000;
  const layer = openLedger(
    config({
      ports,
      cluster: { storagePath: ":memory:", entityIdleMs: idleMs },
      drain: { ...drain, idleMs },
    }),
  ).pipe(Layer.provide(bunCrypto), Layer.provideMerge(TestClock.layer()));
  const seen = await runAgent(
    Effect.scoped(
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        yield* materialize(sessionId);
        const first = yield* settleOnClock(deliverPrompt(sessionId, "m1"), "first deliver");
        const activationsAfterFirst = activations;
        const lengthAfterFirst = ledger.openKernel(sessionId).verifyChain(sessionId);
        // Idle past entityIdleMs: only the reaper, on the test clock, passivates.
        yield* stepClockUntil(Deferred.isDone(passivated), "passivation");
        const second = yield* settleOnClock(deliverPrompt(sessionId, "m2"), "second deliver");
        const kernel = ledger.openKernel(sessionId);
        return {
          first,
          second,
          activationsAfterFirst,
          activations,
          lengthAfterFirst,
          verdict: kernel.verifyChain(sessionId),
          inputs: kernel.inputMessages(sessionId).length,
        };
      }).pipe(Effect.provide(layer)),
    ),
  );
  expect(seen.first.existed).toBe(false);
  expect(seen.second.existed).toBe(false);
  expect(seen.activationsAfterFirst).toBe(1);
  expect(seen.activations).toBe(2);
  expect(seen.lengthAfterFirst.kind).toBe("intact");
  expect(seen.verdict.kind).toBe("intact");
  const lengthBefore = seen.lengthAfterFirst.kind === "intact" ? seen.lengthAfterFirst.length : -1;
  expect(seen.verdict.kind === "intact" && seen.verdict.length).toBeGreaterThan(lengthBefore);
  expect(seen.inputs).toBe(2);
});

function passivatingFileLedger(name: string) {
  const { catalogPath, sessionsDir } = home(name);
  const idleMs = 1_000;
  return openLedger(
    config({
      catalog: { path: catalogPath },
      sessions: { dir: sessionsDir },
      cluster: { storagePath: catalogPath, entityIdleMs: idleMs },
      drain: { ...drain, idleMs },
    }),
  ).pipe(Layer.provide(bunCrypto), Layer.provideMerge(TestClock.layer()));
}

/** Delivers one prompt, then steps the clock until passivation closes the memoized store. */
const deliverAndPassivate = (sessionId: string, key: string) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const closed = Deferred.makeUnsafe<void>();
    const memo = ledger.sessionStore(sessionId);
    const originalClose = memo.close.bind(memo);
    spyOn(memo, "close").mockImplementation(() => {
      originalClose();
      Deferred.doneUnsafe(closed, Effect.void);
    });
    yield* settleOnClock(deliverPrompt(sessionId, key), `${key} deliver`);
    yield* stepClockUntil(Deferred.isDone(closed), `${key} passivation`);
  });

test("file mode: five passivation cycles with late plane-resolved readers hold no store past passivation", async () => {
  const sessionId = "passivated";
  const stores = trackSessionStores();
  const seen = await runAgent(Effect.scoped(
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      yield* materialize(sessionId);
      const cycles: { passivated: number; resolved: number; verdict: string }[] = [];
      for (let cycle = 0; cycle < 5; cycle += 1) {
        yield* deliverAndPassivate(sessionId, `m${cycle}`);
        const passivated = stores.live();
        const verdict = ledger.openKernel(sessionId).verifyChain(sessionId).kind;
        cycles.push({ passivated, resolved: stores.live(), verdict });
      }
      ledger.releaseSession(sessionId);
      return { cycles, released: stores.live(), opened: stores.opened() };
    }).pipe(Effect.provide(passivatingFileLedger("passivation-cycles"))),
  )).finally(stores.restore);
  // Each cycle opens the entity's own handle, closes it with the memo, and reopens one memo for the late reader.
  expect(seen.cycles).toEqual(
    Array.from({ length: 5 }, () => ({ passivated: 0, resolved: 1, verdict: "intact" })),
  );
  expect({ released: seen.released, opened: seen.opened }).toEqual({ released: 0, opened: 11 });
});

test("file mode: a kernel held across a passivation fails on use", async () => {
  const sessionId = "held-across";
  const outcome = await runAgent(Effect.scoped(
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      yield* materialize(sessionId);
      const held = ledger.openKernel(sessionId);
      yield* deliverAndPassivate(sessionId, "first");
      expect(() => held.verifyChain(sessionId)).toThrow(RangeError);
      expect(() => held.verifyChain(sessionId)).toThrow("Cannot use a closed database");
      return { fresh: ledger.openKernel(sessionId).verifyChain(sessionId).kind };
    }).pipe(Effect.provide(passivatingFileLedger("held-across"))),
  ));
  expect(outcome.fresh).toBe("intact");
});

test("late binding: an activation holds on the slot's ready gate and runs the delivered turn exactly once after bind", async () => {
  const sessionId = "late-session";
  const ready = Deferred.makeUnsafe<void>();
  // Settled the moment an activation reaches the gate: the exact "held" signal.
  const held = Deferred.makeUnsafe<void>();
  let turns = 0;
  const inner = makeTurnPort(resolvedRunner("ok"));
  const ports: LedgerConfig["ports"] = {
    ...fixedPorts((input) => {
      turns += 1;
      return inner(input);
    }),
    ready: Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(ready))),
  };
  const layer = openLedger(config({ ports })).pipe(Layer.provide(bunCrypto));
  const outcome = await runAgent(
    Effect.scoped(
      Effect.gen(function* () {
        yield* materialize(sessionId);
        const pending = yield* Effect.forkChild(deliverPrompt(sessionId, "m1"), {
          startImmediately: true,
        });
        yield* Deferred.await(held);
        const turnsWhileHeld = turns;
        yield* Deferred.done(ready, Exit.void);
        const receipt = yield* Fiber.join(pending);
        return { receipt, turnsWhileHeld, turns };
      }).pipe(Effect.provide(layer)),
    ),
  );
  expect(outcome.turnsWhileHeld).toBe(0);
  expect(outcome.turns).toBe(1);
  expect(outcome.receipt.existed).toBe(false);
});

test("opening failures are typed OpenRefused and release what was already acquired", async () => {
  const blocked = join(root, "blocked");
  writeFileSync(blocked, "not a directory");
  const catalogRefusal = await runAgent(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Ledger;
      }).pipe(
        Effect.provide(
          openLedger(config({ catalog: { path: join(blocked, "catalog.sqlite") } })).pipe(
            Layer.provide(bunCrypto),
          ),
        ),
        Effect.flip,
      ),
    ),
  );
  expect(catalogRefusal).toBeInstanceOf(OpenRefused);
  expect(catalogRefusal.code).toBe("catalog");
  expect(catalogRefusal.path).toBe(join(blocked, "catalog.sqlite"));
  expect(catalogRefusal.message).toBe(
    `ledger open refused (catalog): ${join(blocked, "catalog.sqlite")}`,
  );
  expect(catalogRefusal.cause).toBeInstanceOf(Error);

  const { catalogPath } = home("sessions-refused");
  const sessionsRefusal = await runAgent(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Ledger;
      }).pipe(
        Effect.provide(
          openLedger(config({ catalog: { path: catalogPath }, sessions: { dir: blocked } })).pipe(
            Layer.provide(bunCrypto),
          ),
        ),
        Effect.flip,
      ),
    ),
  );
  expect(sessionsRefusal).toBeInstanceOf(OpenRefused);
  expect(sessionsRefusal.code).toBe("sessions");
  expect(sessionsRefusal.path).toBe(blocked);
  expect(sessionsRefusal.message).toBe(`ledger open refused (sessions): ${blocked}`);
  expect(sessionsRefusal.cause).toBeInstanceOf(Error);
  expect(existsSync(catalogPath)).toBe(true);
  expect(sessionFileClosed(catalogPath)).toBe(true);
});
