/**
 * W5.2 L2.4 — test cluster runtime hosting the REAL Session entity (plan §3
 * L2.1 `src/cluster/session-entity.ts`) on a SingleRunner: sql message/runner
 * storage plus the ledger catalog schema in one catalog file, per-session
 * ledger files under `sessionsDir`. Every Effect here is executed through the
 * allowlisted `runAgent` helper so the runner-site ratchet does not grow.
 *
 * The wire contract is `src/core/messages.ts` (#1253): exactly four RPCs.
 * `Deliver` payloads are `{ kind, body, source, idempotencyKey }` (body/source
 * = canonical JSON) acked with `DeliverReceipt { seq, existed }`; `Resolve`
 * settles one request; `Alarm` carries one `AlarmOccurrence` (DeliverAt =
 * fireAt) acked `delivered | stale`; `Read` serves one model page.
 *
 * The composition seam is `SessionEntityContext` (`SessionEntityEnv`): this
 * file supplies the catalog handle, the per-session store opener and a
 * minimal REAL turn port — chain-committed turn intent/resume + delivery
 * records around a pluggable `TestTurnRunner`, then the chain-committed
 * terminal — so entity tests exercise the durable protocol without the full
 * executor (which reaches the entity plane in wave 3).
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway cluster home: sessions dir plus catalog file under one temp root. */
export function clusterTempDir(prefix: string): {
  readonly dir: string;
  readonly sessionsDir: string;
  readonly catalogFile: string;
} {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  return { dir, sessionsDir, catalogFile: join(dir, "catalog.sqlite") };
}

import { Database } from "bun:sqlite";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { L0Write } from "../../src/core/store/session-file";
import * as SessionHandleStore from "../../src/core/store/fence";
import type { Delivery, ObservationSink } from "@openomni/protocol";
import { Context, Crypto, Duration, Effect, Layer, type Scope } from "effect";
import { SingleRunner } from "effect/cluster";
import { openCatalogStore } from "../../src/core/store/catalog";
import { openSessionStore } from "../../src/core/store/session-file";
import { SessionEntity, SessionEntityContext, createSessionEntityLayer, type SessionEntityEnv, } from "../../src/core/entity";
import type { AlarmCapability, AlarmDrainConfig } from "../../src/core/alarm";

/** Integration-helper composition root: cluster fixtures run on the real wall clock. */
const wallClock = () => Date.now();
import type { SessionEntityPorts, SessionEntityTurnInput, } from "../../src/core/run";
import type { SessionError } from "../../src/core/failure";
import { deliveryActions, turnIntentAction, turnResumeAction, turnTerminalAction, } from "../../src/core/commit";
import { runAgent } from "./executor";
import { TEST_APPROVAL_POLICY } from "../helpers/approval-policy";

export interface TestClusterOptions {
  readonly sessionsDir: string;
  readonly catalogFile: string;
  /** entityMaxIdleTime in ms (default 60s: passivation out of the way). */
  readonly idleMs?: number;
  /** Turn execution port; defaults to a runner resolving one text result. */
  readonly runner?: TestTurnRunner;
  /**
   * #1256 r4 H-3(a): the FULL production turn port (createSessionEntityRunTurn
   * over a resolved runtime) instead of the minimal test port — a test builds
   * it inside its scoped program and installs it through a suspension cell.
   */
  readonly runTurnPort?: SessionEntityPorts["runTurn"];
  /** Exercise the production post-boundary fork instead of running the body inline. */
  readonly detachTurns?: boolean;
  /** Crypto service for the cluster host; defaults to Bun webcrypto. */
  readonly crypto?: Layer.Layer<Crypto.Crypto>;
  /** #1254 S4: D3 drain values; defaults mirror the app's (4 / 64 / idleMs). */
  readonly drain?: Partial<AlarmDrainConfig>;
  /** #1254 S4: the composed non-reserved alarm capability (absent = none). */
  readonly alarmCapability?: AlarmCapability;
  /** #1254 S4: keep-alive toggles observed around detached turns. */
  readonly onKeepAlive?: (enabled: boolean) => void;
  /** Composition readiness gate an activation awaits before its first port call. */
  readonly ready?: Effect.Effect<void>;
  /** Fires after the entity commits one request transition. */
  readonly onRequestReady?: (sessionId: string) => void;
  /** #1254 H3: live-activation hook handing out the entity's budgeted arm verb. */
  readonly onLive?: SessionEntityPorts["onLive"];
  /** #1254 H1: post-commit arm notice (native handles follow committed rows). */
  readonly onArmed?: SessionEntityPorts["onArmed"];
  /** Injected entity clock (byte-equality fixtures); default wall clock. */
  readonly clock?: () => number;
  /**
   * #1255: the composed generation's deliver registrations; `"unbound"` omits
   * the port so a case can exercise the #1313 `seam_missing` refusal.
   * Default: core prompt/signal, stated explicitly (no production fallback).
   */
  readonly inputRegistrations?: readonly string[] | "unbound";
  /**
   * #1255: the composed generation's capability kinds for input admission;
   * `"undeclared"` omits the port so a case can exercise the #1310
   * missing-kinds refusal. Default: the built-ins.
   */
  readonly capabilityKinds?: readonly string[] | "undeclared";
  /**
   * #1254 r5 M1: post-commit observation sink injected into every session
   * store this cluster opens — the store publishes `ledger.action.committed`
   * for each chain row AFTER its transaction commits, so a test subscribes to
   * the exact committed fact instead of polling the file.
   */
  readonly observationSink?: ObservationSink;
  /** Wraps each freshly opened per-session store (fault injection). */
  readonly wrapStore?: (
    sessionId: string,
    store: ReturnType<typeof openSessionStore>,
  ) => ReturnType<typeof openSessionStore>;
  /**
   * #1254 S3: observes each activation/rescan resend AFTER its Alarm RPC
   * replied — the deterministic "the resent occurrence was consumed" signal.
   */
  readonly onAlarmResend?: (
    sessionId: string,
    occurrence: { readonly occurrenceId: string; readonly purpose: string },
    receipt: { readonly outcome: "delivered" | "stale" },
  ) => void;
  /**
   * #1254 r3 M2: wraps the entity's forked DeliverAt forward. A test can HOLD
   * a forwarded occurrence (return `Effect.void` instead of sending) and later
   * release it through the explicit `sendAlarm` door — the deterministic way
   * to order "the chain settled first, the parked occurrence arrived second"
   * without racing the real clock.
   *
   * #1254 r4 M2: the wrapper also receives `sendPersisted`, the entity
   * client's real `{discard: true}` Alarm send — the transport persistence
   * barrier (installed Effect cluster/Runners.ts awaits `storage.saveRequest`
   * before the discard notification returns). A fixture that only needs
   * "the envelope is durable" forwards through it and signals on completion
   * instead of polling the mailbox.
   */
  readonly wrapSendAlarm?: (
    send: NonNullable<SessionEntityPorts["sendAlarm"]>,
    sendPersisted: NonNullable<SessionEntityPorts["sendAlarm"]>,
  ) => NonNullable<SessionEntityPorts["sendAlarm"]>;
}

/** What the test turn port hands the pluggable runner for one admitted turn. */
export interface TestTurnInput {
  readonly turnId: string;
  readonly resumeCount: number;
  readonly items: readonly Delivery.Row[];
}

interface TestTurnResult {
  readonly kind: "result" | "interrupted";
  readonly text: string;
}

export type TestTurnRunner = (input: TestTurnInput) => Effect.Effect<TestTurnResult, SessionError>;

/** A runner that resolves immediately with one text result. */
export function resolvedRunner(text: string): TestTurnRunner {
  return () => Effect.succeed({ kind: "result", text });
}

function runTurnBody(
  input: SessionEntityTurnInput,
  body: Effect.Effect<void, SessionError>,
  detachTurns: boolean,
): Effect.Effect<void, SessionError> {
  return detachTurns ? input.detach(body) : body;
}

/**
 * A runner that reports entry (the turn intent + delivery chain commit already
 * happened) and then never completes, keeping the envelope unacknowledged so
 * SIGKILL leaves an unprocessed mailbox row.
 */
export function blockingRunner(onEnter: (turnId: string) => void): TestTurnRunner {
  return (input) =>
    Effect.suspend(() => {
      onEnter(input.turnId);
      return Effect.never;
    });
}

/** The options handle send helpers resolve for on-demand session provisioning. */
class TestClusterEnv extends Context.Service<TestClusterEnv, TestClusterOptions>()(
  "@openomni/agent-test/TestClusterEnv",
) {}

/** Bun webcrypto-backed Crypto service (platform-bun is not a workspace dep). */
const BunTestCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => new Uint8Array(await crypto.subtle.digest(algorithm, data))),
  }),
);

/**
 * Minimal real turn port over the activation kernel: commits the turn
 * intent/resume plus the delivery records (state -> running), runs the
 * pluggable runner, then commits the terminal (state -> idle/interrupted).
 * Every commit rides the activation's catalog fence.
 */
export function makeTurnPort(
  runner: TestTurnRunner,
  detachTurns = false,
  now: () => number = () => Date.now(),
): SessionEntityPorts["runTurn"] {
  return (input: SessionEntityTurnInput) =>
    Effect.gen(function* () {
      const { kernel, authority, decision, snapshot } = input;
      const { sessionId, owner, fence } = authority;
      const commit = (
        actions: Parameters<typeof kernel.commit>[0]["actions"],
        state: "running" | "idle" | "interrupted",
      ) =>
        kernel.commit({
          sessionId,
          owner,
          fence,
          now: now(),
          expectedRevision: kernel.row(sessionId).revision,
          actions,
          state,
        });
      const seal = (
        turnId: string,
        resultId: string,
        parentId: string,
        resumeCount: number,
        result: TestTurnResult,
      ) =>
        commit(
          [
            turnTerminalAction({
              id: resultId,
              parentId,
              sessionId,
              turnId,
              result,
              resumeCount,
              boundaryActionId: null,
              at: now(),
            }),
          ],
          result.kind === "result" ? "idle" : "interrupted",
        );

      if (decision.kind === "recover") {
        const open = decision.open;
        const body = Effect.gen(function* () {
          const result = yield* runner({
            turnId: open.turnId,
            resumeCount: open.resumeCount,
            items: [],
          });
          yield* seal(open.turnId, open.resultId, open.turnId, open.resumeCount, result);
        });
        yield* runTurnBody(input, body, detachTurns);
        return;
      }

      if (decision.kind === "resume") {
        const terminal = snapshot.terminal;
        if (terminal === undefined) return yield* Effect.die("resume decision without a terminal");
        const turnId = terminal.effect.turnId;
        const resumeCount = terminal.effect.resumeCount + 1;
        const item = decision.item;
        const resumeId = `${item.id}:resume`;
        const resultId = `${resumeId}:result`;
        yield* commit(
          [
            turnResumeAction({
              id: resumeId,
              parentId: turnId,
              sessionId,
              turnId,
              resultId,
              generation: kernel.latestGenerationFor(sessionId),
              resumeCount,
              boundaryActionId: null,
              at: now(),
            }),
            ...deliveryActions(
              [item],
              { kind: "turn", turnId },
              "before_llm",
              resumeId,
            ),
          ],
          "running",
        );
        const body = Effect.gen(function* () {
          const result = yield* runner({ turnId, resumeCount, items: [item] });
          yield* seal(turnId, resultId, resumeId, resumeCount, result);
        });
        yield* runTurnBody(input, body, detachTurns);
        return;
      }

      // start: the head of the pending backlog is the admitted prompt.
      const item = snapshot.pending[0];
      if (item === undefined) return yield* Effect.die("start decision without a pending item");
      const turnId = `${item.id}:turn`;
      const resultId = `${turnId}:result`;
      yield* commit(
        [
          turnIntentAction({
            id: turnId,
            parentId: kernel.latestAction(sessionId)?.id ?? null,
            sessionId,
            resultId,
            deliveryIds: [item.id],
            generation: kernel.latestGenerationFor(sessionId),
            resumeCount: 0,
            boundaryActionId: null,
            at: now(),
          }),
          ...deliveryActions(
            [item],
            { kind: "turn", turnId },
            "before_llm",
            turnId,
          ),
        ],
        "running",
      );
      const body = Effect.gen(function* () {
        const result = yield* runner({ turnId, resumeCount: 0, items: [item] });
        yield* seal(turnId, resultId, turnId, 0, result);
      });
      yield* runTurnBody(input, body, detachTurns);
    }).pipe(Effect.orDie);
}

/** The entity port set one test cluster composes from its options. */
function entityPorts(
  options: TestClusterOptions,
  forward: NonNullable<SessionEntityPorts["sendAlarm"]>,
  forwardPersisted: NonNullable<SessionEntityPorts["sendAlarm"]>,
): SessionEntityEnv["ports"] {
  return {
    approvalPolicy: TEST_APPROVAL_POLICY,
    runTurn:
      options.runTurnPort ??
      makeTurnPort(
        options.runner ?? resolvedRunner("ok"),
        options.detachTurns,
        options.clock ?? (() => Date.now()),
      ),
    ...(options.alarmCapability === undefined
      ? {}
      : { alarmCapability: options.alarmCapability }),
    // #1313: deliver refuses an unbound inputRegistrations port, so the test
    // cluster states the core table explicitly unless a case unbinds it.
    ...(options.inputRegistrations === "unbound"
      ? {}
      : { inputRegistrations: options.inputRegistrations ?? ["prompt", "signal"] }),
    // #1310: admission refuses a snapshot with no declared kinds, so the
    // test cluster states the built-ins unless a case overrides them.
    ...(options.capabilityKinds === "undeclared"
      ? {}
      : { capabilityKinds: options.capabilityKinds ?? ["tool", "compaction"] }),
    ...(options.onKeepAlive === undefined ? {} : { onKeepAlive: options.onKeepAlive }),
    ...(options.ready === undefined ? {} : { ready: options.ready }),
    ...(options.onRequestReady === undefined ? {} : { onRequestReady: options.onRequestReady }),
    ...(options.onLive === undefined ? {} : { onLive: options.onLive }),
    ...(options.onArmed === undefined ? {} : { onArmed: options.onArmed }),
    sendAlarm:
      options.wrapSendAlarm === undefined
        ? forward
        : options.wrapSendAlarm(forward, forwardPersisted),
  };
}

/** The composition-owned entity environment, scoped to one test runtime. */
function entityEnvLayer(options: TestClusterOptions) {
  return Layer.effect(
    SessionEntityContext,
    Effect.gen(function* () {
      // #1254 S3: the activation resend door — the entity's own persisted
      // Alarm RPC, exactly the production path (occurrence id = dedupe key).
      const makeClient = yield* SessionEntity.client;
      const forward: NonNullable<SessionEntityPorts["sendAlarm"]> = (sessionId, occurrence) =>
        makeClient(sessionId)
          .Alarm(occurrence)
          .pipe(
            Effect.tap((receipt) =>
              Effect.sync(() => options.onAlarmResend?.(sessionId, occurrence, receipt)),
            ),
            Effect.asVoid,
            Effect.orDie,
          );
      // #1254 r4 M2: the persisted discard send — completes once the
      // occurrence envelope is durable, never awaiting the reply.
      const forwardPersisted: NonNullable<SessionEntityPorts["sendAlarm"]> = (
        sessionId,
        occurrence,
      ) => makeClient(sessionId).Alarm(occurrence, { discard: true }).pipe(Effect.asVoid, Effect.orDie);
      return yield* Effect.acquireRelease(
        Effect.sync(
          (): SessionEntityEnv => ({
            owner: `test-runner-${process.pid}`,
            clock: options.clock ?? (() => Date.now()),
            catalog: openCatalogStore(options.catalogFile, { now: wallClock }),
            openSession: (sessionId) => {
              const store = openSessionStore(sessionFileFor(options.sessionsDir, sessionId), {
                now: wallClock,
                ...(options.observationSink === undefined
                  ? {}
                  : { observationSink: options.observationSink }),
              });
              return options.wrapStore === undefined ? store : options.wrapStore(sessionId, store);
            },
            ports: entityPorts(options, forward, forwardPersisted),
          }),
        ),
        (env) => Effect.sync(() => env.catalog.close()),
      );
    }),
  );
}

/**
 * Single-node cluster host: SingleRunner with sql runner+message storage on
 * the catalog file. ShardingConfig is pinned explicitly (review R2 / plan D9):
 * never ambient `layerFromEnv` values in tests.
 */
function clusterHostLayer(options: TestClusterOptions) {
  return SingleRunner.layer({
    runnerStorage: "sql",
    shardingConfig: {
      entityMaxIdleTime: Duration.millis(options.idleMs ?? 60_000),
      entityMessagePollInterval: Duration.millis(100),
      entityReplyPollInterval: Duration.millis(100),
    },
  }).pipe(
    Layer.provide(SqliteClient.layer({ filename: options.catalogFile })),
    Layer.provide(options.crypto ?? BunTestCrypto),
  );
}

/** D3 drain values for one test cluster: the app defaults with the host idle budget. */
function testDrainConfig(options: TestClusterOptions): AlarmDrainConfig {
  return {
    alarmsBeforePrompt: 4,
    maxArmed: 64,
    idleMs: options.idleMs ?? 60_000,
    sweep: { full: false, idleDays: 7 },
    ...options.drain,
  };
}

/** The real Session entity over the single-node host (plan §1 composition). */
export function makeTestClusterRuntime(options: TestClusterOptions) {
  return createSessionEntityLayer(testDrainConfig(options)).pipe(
    Layer.provide(entityEnvLayer(options)),
    Layer.merge(Layer.succeed(TestClusterEnv, options)),
    Layer.provideMerge(clusterHostLayer(options)),
  );
}

/** Run one scoped program against a freshly built test cluster runtime. */
export function runCluster<A, E>(
  options: TestClusterOptions,
  program: Effect.Effect<
    A,
    E,
    Layer.Success<ReturnType<typeof makeTestClusterRuntime>> | Scope.Scope
  >,
): Promise<A> {
  return runAgent(Effect.scoped(program.pipe(Effect.provide(makeTestClusterRuntime(options)))));
}

/**
 * On-demand session provisioning (idle row + catalog index) with short-lived
 * store handles: entity activations refuse truly unknown sessions, so send
 * helpers materialize the target first. Memoized per session file.
 */
const provisioned = new Map<string, Promise<void>>();

function provisionSession(options: TestClusterOptions, sessionId: string): Effect.Effect<void> {
  const file = sessionFileFor(options.sessionsDir, sessionId);
  return Effect.promise(() => {
    let pending = provisioned.get(file);
    if (pending === undefined) {
      pending = runAgent(
        Effect.gen(function* () {
          const catalog = openCatalogStore(options.catalogFile, { now: wallClock });
          const store = openSessionStore(file, { now: wallClock });
          const kernel = SessionHandleStore.createSessionKernel(store, catalog);
          const exists = (() => {
            try {
              kernel.row(sessionId);
              return true;
            } catch {
              return false;
            }
          })();
          if (!exists) {
            yield* kernel.materialize({
              id: sessionId,
              parentId: null,
              role: "resident",
              tools: [],
              system: { preset: "", blocks: [] },
              policyGeneration: 1,
              actionId: `${sessionId}:materialize`,
              at: Date.now(),
            });
          }
          catalog.indexSession({
            id: sessionId,
            parentId: null,
            role: "resident",
            createdAt: Date.now(),
          });
          store.close();
          catalog.close();
        }),
      );
      provisioned.set(file, pending);
    }
    return pending;
  });
}

/** Canonical JSON of a protocol `Delivery.MessageOrigin` value (messages.ts C1). */
function testOrigin(sessionId: string, messageId: string): string {
  const origin: Delivery.MessageOrigin = {
    kind: "message",
    messageId,
    senderSessionId: sessionId,
    sourceActionId: messageId,
  };
  return JSON.stringify(origin);
}

/** One prompt through the `deliver` door; `messageId` is the idempotency key. */
export const sendPrompt = (sessionId: string, messageId: string, content: string) =>
  sendDeliver(sessionId, { kind: "prompt", idempotencyKey: messageId, content });

/** One resume signal through the `deliver` door. */
export const sendResume = (sessionId: string, messageId: string, content: string) =>
  sendDeliver(sessionId, { kind: "signal", idempotencyKey: messageId, content, control: "resume" });

/** One request-deadline alarm occurrence (DeliverAt = deadlineAt). */
export const sendDeadline = (sessionId: string, requestId: string, deadlineAt: number) =>
  sendAlarm(sessionId, {
    occurrenceId: `${requestId}:deadline`,
    purpose: "deadline",
    alarmId: `${requestId}:deadline`,
    armSeq: 1,
    sourceKey: "deadline",
    payload: JSON.stringify({ requestId }),
    fireAt: deadlineAt,
  });

export function sessionFileFor(sessionsDir: string, sessionId: string): string {
  return `${sessionsDir}/${sessionId}.sqlite`;
}

export interface ChainRow {
  readonly id: string;
  readonly kind: string;
  readonly ordinal: number;
  /** Commit clock time of the action — the recorded fact's own timestamp. */
  readonly ts: number;
  readonly prev_hash: string;
  readonly action_hash: string;
}

function withReadonly<A>(file: string, read: (db: Database) => A): A {
  const db = new Database(file, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

export function readChain(file: string, sessionId: string): ChainRow[] {
  return withReadonly(file, (db) =>
    db
      .query<ChainRow, [string]>(
        "SELECT id, kind, ordinal, ts, prev_hash, action_hash FROM action WHERE session_id = ? ORDER BY ordinal ASC",
      )
      .all(sessionId),
  );
}

interface RawActionRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly session_id: string;
  readonly kind: string;
  readonly intent: string;
  readonly effect: string;
  readonly revert: string | null;
  readonly irreversible: 0 | 1;
  readonly encoding_version: number;
  readonly ts: number;
  readonly ordinal: number;
  readonly prev_hash: string;
  readonly action_hash: string;
}

/** Recompute every action_hash and prev_hash link from raw rows; returns length. */
export function verifyChain(file: string, sessionId: string): number {
  return withReadonly(file, (db) => {
    const rows = db
      .query<RawActionRow, [string]>(
        "SELECT id, parent_id, session_id, kind, intent, effect, revert, irreversible, encoding_version, ts, ordinal, prev_hash, action_hash FROM action WHERE session_id = ? ORDER BY ordinal ASC",
      )
      .all(sessionId);
    let prev: string = L0Write.GENESIS_PREV_HASH;
    rows.forEach((row, index) => {
      if (row.ordinal !== index + 1) {
        throw new Error(`chain gap at index ${index}: ordinal ${row.ordinal}`);
      }
      if (row.prev_hash !== prev) {
        throw new Error(`prev_hash link broken at ordinal ${row.ordinal}`);
      }
      const { action_hash, ...rest } = row;
      const recomputed = L0Write.computeActionHash(rest);
      if (recomputed !== action_hash) {
        throw new Error(`action_hash mismatch at ordinal ${row.ordinal}`);
      }
      prev = action_hash;
    });
    return rows.length;
  });
}

export interface ClusterMessageRow {
  readonly entity_type: string;
  readonly entity_id: string;
  readonly tag: string;
  readonly processed: number;
  readonly deliver_at: number | null;
}

export function clusterMessages(catalogFile: string, entityType: string): ClusterMessageRow[] {
  return withReadonly(catalogFile, (db) =>
    db
      .query<ClusterMessageRow, [string]>(
        "SELECT entity_type, entity_id, tag, processed, deliver_at FROM cluster_messages WHERE entity_type = ? ORDER BY rowid ASC",
      )
      .all(entityType),
  );
}

/** Catalog `session_index.fence` — rotated by every entity activation (F5). */
export function sessionFence(catalogFile: string, sessionId: string): number | undefined {
  return (
    withReadonly(catalogFile, (db) =>
      db
        .query<{ fence: number }, [string]>("SELECT fence FROM session_index WHERE id = ?")
        .get(sessionId),
    )?.fence ?? undefined
  );
}

/**
 * Bounded observation of state behind a third-party boundary (effect/cluster's
 * message tables, SQLite WAL files) that exposes no event to subscribe to.
 * The interval is an observation cadence, never a synchronizer: the test
 * passes only when the exact predicate holds, and the timeout is a failure
 * guard. For facts our own stores commit, subscribe with `completionSignal`
 * and the `observationSink` option instead of calling this.
 */
export function waitUntil(label: string, check: () => boolean, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (check()) {
      resolve();
      return;
    }
    const expiresAt = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > expiresAt) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for: ${label}`));
      }
    }, 25);
  });
}

/**
 * #1254 r5 M1: completion signals replace polling. A signal is created BEFORE
 * the seam that fires it is installed (a runner's entry callback / the store's
 * post-commit observation sink) and resolved from that exact seam, so
 * completion is subscribed, never polled.
 */
export function completionSignal(): { readonly done: Promise<void>; readonly fire: () => void } {
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return { done, fire: () => resolveDone() };
}

/** Bounded await of one signal: the cap is a failure guard, never a synchronizer. */
export function boundedAwait(label: string, done: Promise<void>, capMs = 15_000): Promise<void> {
  let cap: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    cap = setTimeout(() => reject(new Error(`timed out awaiting ${label}`)), capMs);
  });
  return Promise.race([done, guard]).finally(() => clearTimeout(cap));
}

/** True once the session file's WAL is gone: the activation finalizer closed it. */
export function sessionFileClosed(file: string): boolean {
  const wal = Bun.file(`${file}-wal`);
  return !(wal.size > 0);
}

/** Accumulate a child's stdout until `pattern` matches; bounded, no bare sleeps. */
export async function readUntil(
  stream: ReadableStream<Uint8Array>,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  const timer = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`timed out waiting for ${pattern}; got:\n${text}`)),
      timeoutMs,
    );
  });
  try {
    while (!pattern.test(text)) {
      const chunk = await Promise.race([reader.read(), timer]);
      if (chunk.done) throw new Error(`stream ended before ${pattern}; got:\n${text}`);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text;
  } finally {
    reader.releaseLock();
  }
}

// ─── #1253 four-RPC send helpers ───

/** One `deliver` through the four-RPC surface; body/source are canonical JSON. */
export const sendDeliver = (
  sessionId: string,
  input: {
    readonly kind: string;
    readonly idempotencyKey: string;
    readonly content: string;
    readonly control?: "interrupt" | "resume";
    readonly delivery?: "steer" | "followUp";
    /** #1256 H-3: the journal cursor a deferred action's payload was computed against. */
    readonly after?: number;
    /** Canonical JSON origin override (default: a message origin keyed by the idempotency key). */
    readonly source?: string;
  },
) =>
  Effect.gen(function* () {
    yield* provisionSession(yield* TestClusterEnv, sessionId);
    const makeClient = yield* SessionEntity.client;
    return yield* makeClient(sessionId).Deliver({
      kind: input.kind,
      body: JSON.stringify({
        content: input.content,
        ...(input.control === undefined ? {} : { control: input.control }),
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
        ...(input.after === undefined ? {} : { after: input.after }),
      }),
      source: input.source ?? testOrigin(sessionId, input.idempotencyKey),
      idempotencyKey: input.idempotencyKey,
    });
  });

/** One `resolve` through the four-RPC surface. */
export const sendResolve = (
  sessionId: string,
  input: {
    readonly requestId: string;
    readonly outcome: "resolved" | "cancelled";
    readonly payload: string;
    readonly inputId: string;
  },
) =>
  Effect.gen(function* () {
    yield* provisionSession(yield* TestClusterEnv, sessionId);
    const makeClient = yield* SessionEntity.client;
    return yield* makeClient(sessionId).Resolve(input);
  });

/** One `alarm` occurrence through the four-RPC surface. */
export const sendAlarm = (
  sessionId: string,
  occurrence: {
    readonly occurrenceId: string;
    readonly purpose: string;
    readonly alarmId: string;
    readonly armSeq: number;
    readonly sourceKey: string;
    readonly payload: string;
    readonly fireAt: number;
  },
) =>
  Effect.gen(function* () {
    yield* provisionSession(yield* TestClusterEnv, sessionId);
    const makeClient = yield* SessionEntity.client;
    return yield* makeClient(sessionId).Alarm(occurrence);
  });

// ─── #1253 `read` send helper ───

/** One `read` model page through the four-RPC surface. */
export const sendRead = (
  sessionId: string,
  input: {
    readonly model:
      | "history" | "decisions" | "requests" | "alarms" | "generations"
      | "tree" | "metrics" | "control" | "outbound";
    readonly cursor: number;
  },
) =>
  Effect.gen(function* () {
    yield* provisionSession(yield* TestClusterEnv, sessionId);
    const makeClient = yield* SessionEntity.client;
    return yield* makeClient(sessionId).Read(input);
  });
