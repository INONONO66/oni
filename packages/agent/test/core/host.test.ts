import { afterAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Crypto, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { SessionEntity } from "../../src/core/entity";
import { Ledger, type LedgerConfig, OpenRefused, openLedger } from "../../src/core/host";
import { TEST_APPROVAL_POLICY } from "../helpers/approval-policy";
import {
  clusterMessages,
  makeTurnPort,
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

const bunCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => new Uint8Array(await crypto.subtle.digest(algorithm, data))),
  }),
);

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
    yield* ledger.openKernel(sessionId).materialize({
      id: sessionId,
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 1,
      actionId: `${sessionId}:materialize`,
      at: Date.now(),
    });
    ledger.catalog.indexSession({
      id: sessionId,
      parentId: null,
      role: "resident",
      createdAt: Date.now(),
    });
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

test("memory mode: the entity and the plane share one in-memory store per session", async () => {
  const sessionId = "memory-session";
  const layer = openLedger(config({})).pipe(Layer.provide(bunCrypto));
  const seen = await runAgent(
    Effect.scoped(
      Effect.gen(function* () {
        yield* materialize(sessionId);
        const receipt = yield* deliverPrompt(sessionId, "m1");
        const ledger = yield* Ledger;
        expect(ledger.handles.openSession(sessionId)).toBe(ledger.sessionStore(sessionId));
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
  expect(existsSync(catalogPath)).toBe(true);
  expect(sessionFileClosed(catalogPath)).toBe(true);
});
