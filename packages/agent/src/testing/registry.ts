import { Effect, Scope } from "effect";
import type { LedgerSession, SessionGeneration } from "@openomni/protocol";
import { AgentFailure, AgentInvariantViolation, type SessionError } from "../core/failure";
import { BOUNDED_CONCURRENCY, type SessionEntryServices } from "../core/ports";
import * as SessionHandleStore from "../core/store/fence";
import { toolSnapshot } from "../core/commit";
import { resolveSessionRuntime, installSessionHandlePlane, type SessionRuntime, type ResolvedSessionRuntime, type SessionCreateOptions, type SessionHandle, type SessionController, type SessionControllerLifecycle, type SessionRunner, type SessionSystem, type RegistryEntry } from "../core/run";
import type { SessionKernel } from "../core/entity";
import { compactionCapability } from "../bundle";
import { createController } from "./controller";

// Harness-built runtimes get the real compaction seam by default so tests keep
// exercising pin + restore; a test that wants it OFF sets `compaction: undefined`
// explicitly, because defaulting fills only a runtime that never mentions the key.
const testingCompactionSeam = compactionCapability().verbs;

function withTestingCompaction(runtime: SessionRuntime): SessionRuntime {
  return "compaction" in runtime ? runtime : { ...runtime, compaction: testingCompactionSeam };
}

const registries = new WeakMap<SessionRuntime, SessionRegistry>();

function registryFor(runtime: SessionRuntime) {
  return Effect.gen(function* () {
    let registry = registries.get(runtime);
    if (registry === undefined) {
      const created = new SessionRegistry(yield* resolveSessionRuntime(withTestingCompaction(runtime)), yield* Effect.scope);
      registries.set(runtime, created);
      installSessionHandlePlane(runtime, {
        get: (id) => registries.get(runtime)?.get(id),
        close: () => Effect.suspend(() => {
          const closing = registries.get(runtime);
          registries.delete(runtime);
          return closing === undefined ? Effect.void : closing.close();
        }),
      });
      registry = created;
    }
    return registry;
  });
}

export function session(options: SessionCreateOptions, runtime: SessionRuntime): Effect.Effect<SessionHandle, SessionError, Scope.Scope | SessionEntryServices> {
  return registryFor(runtime).pipe(Effect.flatMap((registry) => registry.declare(options)));
}

class SessionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly installing = new Map<string, Effect.Effect<RegistryEntry, SessionError>>();
  private closed = false;

  constructor(private readonly runtime: ResolvedSessionRuntime, private readonly scope: Scope.Scope) {}
  get(id: string): SessionHandle | undefined { return this.entries.get(id)?.controller.handle; }

  declare(options: SessionCreateOptions): Effect.Effect<SessionHandle, SessionError> {
    const self = this;
    return Effect.gen(function* () {
      if (self.closed) return yield* new AgentFailure({ operation: "session.declare", cause: "closed" });
      const entropy = self.runtime.entropy;
      const id = options.id ?? entropy();
      const existing = self.entries.get(id);
      if (existing !== undefined) {
        if (existing.runner !== options.runner) return yield* new AgentFailure({ operation: "session.declare", cause: "runner_conflict" });
        return existing.controller.handle;
      }
      const tools = (options.tools ?? []).map(toolSnapshot);
      const kernel = self.runtime.openKernel(id);
      const materialized = yield* kernel.materialize({
        id, parentId: options.parentId ?? null, role: options.role, tools,
        system: { preset: options.system?.preset ?? "", blocks: options.system?.blocks ?? [] },
        policyGeneration: options.policyGeneration ?? kernel.currentPolicyGeneration(),
        bundles: options.bundles,
        actionId: entropy(), at: self.runtime.clock(),
      });
      if (!materialized.created) assertDeclaration(kernel, materialized.row, options, tools, options.system);
      return (yield* self.install(id, options.runner)).controller.handle;
    });
  }

  close(): Effect.Effect<void, SessionError> {
    return Effect.suspend(() => {
      this.closed = true;
      const entries = [...this.entries.values()];
      this.entries.clear();
      return Effect.forEach(entries, (entry) => entry.controller.handle.close(), { concurrency: BOUNDED_CONCURRENCY, discard: true });
    });
  }

  private install(id: string, runner: SessionRunner): Effect.Effect<RegistryEntry, SessionError> {
    const self = this;
    return Effect.gen(function* () {
      if (self.closed) return yield* new AgentFailure({ operation: "session.install", cause: "closed" });
      const existing = self.entries.get(id);
      if (existing !== undefined) return existing;
      let pending = self.installing.get(id);
      if (pending === undefined) {
        pending = yield* Effect.cached(Effect.gen(function* () {
          let controller: SessionController | undefined;
          const lifecycle: SessionControllerLifecycle = {
            reactivate: () => self.install(id, runner).pipe(Effect.map((entry) => entry.controller.handle)),
            release: () => {
              if (controller !== undefined && self.entries.get(id)?.controller === controller) self.entries.delete(id);
            },
          };
          const scope = yield* Scope.fork(self.scope, "sequential");
          controller = yield* createController(self.runtime.openKernel(id), id, runner, self.runtime, lifecycle, scope);
          const entry = { runner, controller };
          self.entries.set(id, entry);
          self.installing.delete(id);
          return entry;
        }));
        self.installing.set(id, pending);
      }
      return yield* pending;
    });
  }
}

function assertDeclaration(kernel: SessionKernel, row: LedgerSession.Row, options: SessionCreateOptions, tools: readonly SessionGeneration.Tool[], system: Partial<SessionSystem> | undefined): void {
  if (row.role !== options.role || row.parentId !== (options.parentId ?? null)) throw new AgentInvariantViolation(`session declaration conflicts with durable identity: ${row.id}`);
  const snapshot = kernel.latestGenerationFor(row.id);
  const expected = SessionHandleStore.generationSnapshot({
    generation: snapshot.generation, revertTo: snapshot.revertTo, tools,
    system: { preset: system?.preset ?? "", blocks: system?.blocks ?? [] },
    policyGeneration: options.policyGeneration ?? snapshot.policyGeneration,
  });
  if (snapshot.toolsHash !== expected.toolsHash || snapshot.systemHash !== expected.systemHash) throw new AgentInvariantViolation(`session declaration conflicts with durable generation: ${row.id}`);
}
