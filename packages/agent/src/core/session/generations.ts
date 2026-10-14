import { generationSnapshot, configureAction } from "../store/configure";
import { Effect, Context, Exit, Layer, Scope, Semaphore } from "effect";
import { type SessionError, CommitFailed, AgentFailure, GenerationUnavailable, GenerationUnsettled } from "../ports/failure";
import { createRawSlots } from "../loop/executor";
import { GenerationRawSlots } from "../loop/executor";

import type { SessionKernel } from "./entity";
import { type LedgerSession, type SessionGeneration, canonicalDigest, PlainValueSchema } from "@openomni/protocol";
import { GenerationOwnership, type CapturedGeneration, type GenerationServices } from "../ports/ports";
import { commitFoldBatch } from "../journal/compaction";
import type { ResolvedSessionRuntime, SessionControllerState, SessionSystem } from "./runtime";

export function createSessionConfiguration(
  kernel: SessionKernel,
  sessionId: string,
  runtime: ResolvedSessionRuntime,
  state: SessionControllerState,
  owner: string,
  clock: () => number,
  entropy: () => string,
  ports: {
    readonly hibernate: (current: LedgerSession.Row) => Effect.Effect<void, SessionError>;
  },
) {
  function configure(
    operation: SessionGeneration.ConfigureIntent["operation"],
    nextTools: readonly SessionGeneration.Tool[],
    nextSystem: SessionSystem,
  ): Effect.Effect<SessionGeneration.ConfigureReceipt, SessionError> {
    return Effect.gen(function* () {
      const before = kernel.latestGenerationFor(sessionId);
      const generation = before.generation + 1;
      const accepted = yield* runtime.authorizeConfigure({
        sessionId, role: kernel.row(sessionId).role, operation, generation,
      });
      if (!accepted) return yield* new AgentFailure({ operation: "session.configure", cause: "denied" });
      const current = kernel.row(sessionId);
      const previous = kernel.latestGenerationFor(sessionId);
      if (previous.generation !== before.generation)
        return yield* new AgentFailure({ operation: "session.configure", cause: "stale" });
      const snapshot = generationSnapshot({
        generation, revertTo: previous.generation, tools: nextTools,
        system: nextSystem, policyGeneration: previous.policyGeneration,
        bundles: previous.bundles,
        // An app-level configure keeps the adopted manifest — dropping the hash
        // would force a spurious compose adoption at next turn start.
        ...(previous.manifestHash === undefined ? {} : { manifestHash: previous.manifestHash }),
      });
      const configured = configureAction({
        id: entropy(), sessionId, parentId: kernel.latestAction(sessionId)?.id ?? null,
        operation, snapshot, at: clock(),
      });
      const commit = commitFoldBatch(kernel, {
        sessionId, owner, fence: state.fence, now: clock(), expectedRevision: current.revision,
        actions: [configured], state: current.state,
        generation: { toolsGeneration: snapshot.generation, systemHash: snapshot.systemHash, policyGeneration: snapshot.policyGeneration },
      }, runtime.compaction).pipe(Effect.mapError((error) => new CommitFailed({ error })));
      const committed = yield* runtime.generations.configure({ sessionId, generation }, snapshot, commit);
      yield* ports.hibernate(committed.row);
      return { generation: snapshot.generation, revertTo: snapshot.revertTo };
    });
  }

  return { configure };
}

export interface GenerationBundle {
  readonly id: SessionGeneration.Id;
  readonly snapshot: SessionGeneration.Snapshot;
  readonly layer: Layer.Layer<GenerationServices, SessionError>;
  /** Infallible synchronous gate flip, only after durable selection commits. */
  readonly activate: Effect.Effect<void>;
}

interface Entry {
  readonly bundle: GenerationBundle;
  readonly context: Context.Context<GenerationServices>;
  readonly scope: Scope.Closeable;
  readonly owners: ReturnType<typeof createRawSlots>;
  readonly hash: string;
  retired: boolean;
  closed: boolean;
}

export function makeSessionGenerations(initial: GenerationBundle) {
  return Effect.gen(function* () {
    const processScope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    const first = yield* acquire(initial);
    yield* initial.activate;
    const entries = new Map([[initial.id.generation, first]]);
    let current = first;
    let stopping = false;

    const close = (entry: Entry) => Effect.uninterruptible(Effect.gen(function* () {
      yield* entry.owners.awaitSettled;
      if (entry.closed) return;
      entry.closed = true;
      yield* Scope.close(entry.scope, Exit.void);
    }));
    const retire = (entry: Entry) => Effect.gen(function* () {
      if (entry.retired) return;
      entry.retired = true;
      if (entry.owners.pending() === 0) yield* close(entry);
      else yield* Effect.forkIn(close(entry), processScope);
    });
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      stopping = true;
      yield* Effect.forEach(entries.values(), close, { discard: true });
    }));

    function validate(bundle: GenerationBundle): Effect.Effect<void, SessionError> {
      return bundle.id.sessionId !== initial.id.sessionId || bundle.id.generation !== bundle.snapshot.generation
        ? Effect.fail(new AgentFailure({ operation: "generation.identity", cause: "snapshot_identity_mismatch" }))
        : Effect.void;
    }

    /** Capturable only while its snapshot matches and it still has live owners or is current. */
    function admitCapture(bundle: GenerationBundle, entry: Entry | undefined): Effect.Effect<void, SessionError> {
      if (stopping) return Effect.fail(new GenerationUnavailable({ generation: bundle.id.generation }));
      if (entry === undefined) return Effect.void;
      if (entry.hash !== snapshotHash(bundle.snapshot))
        return Effect.fail(new AgentFailure({ operation: "generation.capture", cause: "snapshot_hash_mismatch" }));
      if (entry.closed || (entry.retired && entry.owners.pending() === 0))
        return Effect.fail(new GenerationUnavailable({ generation: bundle.id.generation }));
      return Effect.void;
    }

    function capture(bundle = current.bundle): Effect.Effect<CapturedGeneration, SessionError, Scope.Scope> {
      return lock.withPermits(1)(Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        yield* validate(bundle);
        let entry = entries.get(bundle.id.generation);
        yield* admitCapture(bundle, entry);
        if (entry === undefined) {
          entry = yield* restore(acquire(bundle));
          yield* bundle.activate;
          entries.set(bundle.id.generation, entry);
        }
        const release = entry.owners.open();
        yield* Effect.addFinalizer(() => Effect.sync(release));
        const captured = entry;
        if (captured.bundle.id.generation < current.bundle.id.generation) yield* retire(captured);
        const ownership: CapturedGeneration = {
          id: captured.bundle.id,
          snapshot: captured.bundle.snapshot,
          isSelected: () => captured === current,
          retain: () => captured.owners.open(),
          provide: <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.provide(work, context),
        };
        const context = captured.context.pipe(Context.add(GenerationRawSlots, captured.owners), Context.add(GenerationOwnership, ownership));
        return ownership;
      })));
    }

    function configure<A>(bundle: GenerationBundle, commit: Effect.Effect<A, SessionError>) {
      return lock.withPermits(1)(Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        yield* validate(bundle);
        if (stopping || entries.has(bundle.id.generation))
          return yield* new GenerationUnavailable({ generation: bundle.id.generation });
        const candidate = yield* restore(acquire(bundle));
        const receipt = yield* commit.pipe(Effect.onError((cause) => Scope.close(candidate.scope, Exit.failCause(cause))));
        yield* bundle.activate;
        const previous = current;
        entries.set(bundle.id.generation, candidate);
        current = candidate;
        yield* retire(previous);
        return receipt;
      })));
    }

    /**
     * Awaits live owners without flipping `stopping`, so the fail-fast `drain` observes zero
     * owners; loops because a detached turn may briefly hand its capture to a successor entry.
     */
    const settle: Effect.Effect<void> = Effect.suspend(() => {
      const pending = [...entries.values()].filter((entry) => entry.owners.pending() > 0);
      if (pending.length === 0) return Effect.void;
      return Effect.forEach(pending, (entry) => entry.owners.awaitSettled, { discard: true }).pipe(
        Effect.andThen(Effect.suspend(() => settle)),
      );
    });
    const drain = lock.withPermits(1)(Effect.gen(function* () {
      stopping = true;
      for (const entry of entries.values()) {
        if (entry.owners.pending() > 0) return yield* new GenerationUnsettled({
          ...entry.bundle.id, owners: entry.owners.pending(),
        });
      }
      yield* Effect.forEach(entries.values(), retire, { discard: true });
    }));
    return { capture, configure, drain, settle };
  });
}

function snapshotHash(snapshot: SessionGeneration.Snapshot): string {
  return canonicalDigest(PlainValueSchema.parse(snapshot));
}

function acquire(bundle: GenerationBundle): Effect.Effect<Entry, SessionError> {
  return Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* restore(Layer.buildWithScope(bundle.layer, scope)).pipe(
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
    );
    return { bundle, context, scope, owners: createRawSlots(), hash: snapshotHash(bundle.snapshot), retired: false, closed: false };
  }));
}
