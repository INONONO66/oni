import { canonicalJson, type PlainValue, Tool } from "@oni/protocol";
import { type Context, Deferred, Effect, Layer, Semaphore } from "effect";
import { GenerationHandlers } from "../../src/core/composition/compose";
import { KERNEL_POLICY_REGISTRY } from "../../src/core/gate/compile";
import type { PolicyBinding } from "../../src/core/gate/types";
import { projectTools, type ToolDispatchDefinition } from "../../src/core/loop/tool";
import { Entropy, GenerationLayers, ObservationSink, type SessionEntryServices } from "../../src/core/ports/ports";
import { deliver } from "../../src/core/session/entity-delivery";
import { forwardState, type ActivationHandle } from "../../src/core/session/entity-activation";
import { makeSessionGenerations } from "../../src/core/session/generations";
import { openLedgerPlane, type LedgerPlane } from "../../src/core/session/host";
import { resolveSessionRuntime, type SessionRunner } from "../../src/core/session/runtime";
import { executeExternalTool } from "../../src/core/session/tool-turn";
import { createTurnDispatcher } from "../../src/plugins/tool/dispatch";
import { TEST_APPROVAL_POLICY } from "./approval-policy";
import { allowAllPolicy } from "./compiled-policy";
import { FakeLlmLive } from "./fake-llm";
import { AgentGenerationLive } from "./generation-layer";
import { makeObservationBus } from "../../src/core/observation/bus";
import { entropySource } from "./time";

/** Real store, generation manager, activation admission and dispatcher; only the model body is supplied. */
export function toolTurnWorld(options: {
  readonly sessionId?: string;
  readonly plane?: LedgerPlane;
  readonly definitions?: readonly ToolDispatchDefinition[];
  readonly policy?: PolicyBinding;
  readonly runner?: SessionRunner;
  readonly wrap?: (runner: SessionRunner) => SessionRunner;
} = {}) {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const plane = options.plane ?? (yield* Effect.acquireRelease(
      Effect.sync(() => openLedgerPlane({ now: () => 1 })),
      (owned) => Effect.sync(() => owned.close()),
    ));
    const sessionId = options.sessionId ?? "tool-session";
    const kernel = plane.openKernel(sessionId);
    const definitions = options.definitions ?? [];
    const entropy = entropySource(sessionId);
    yield* kernel.materialize({
      id: sessionId, parentId: null, role: "resident", tools: projectTools(definitions).session,
      system: { preset: "", blocks: [] }, policyGeneration: 1, actionId: entropy.id(), at: 1,
    });
    plane.catalog.indexSession({ id: sessionId, parentId: null, role: "resident", createdAt: 1 });
    const fence = plane.catalog.rotateFence(sessionId);
    yield* kernel.adoptFence({ sessionId, owner: "activation", fence });
    const observations = (yield* makeObservationBus({ id: entropy.id, now: () => 1 })).sink;
    const snapshot = kernel.latestGenerationFor(sessionId);
    const manager = yield* makeSessionGenerations({
      id: { sessionId, generation: snapshot.generation }, snapshot, activate: Effect.void,
      layer: Layer.mergeAll(
        AgentGenerationLive({ snapshot, definitions, policy: options.policy ?? allowAllPolicy }),
        Layer.succeed(ObservationSink, observations),
        Layer.succeed(GenerationHandlers, KERNEL_POLICY_REGISTRY),
      ),
    });
    const services = yield* Layer.buildWithScope(Layer.mergeAll(
      FakeLlmLive, Entropy.layer(entropy), Layer.succeed(ObservationSink, observations),
      Layer.succeed(GenerationLayers, {
        initialize: () => Effect.void, capture: () => manager.capture(),
        configure: (_id, _snapshot, commit) => commit, settle: manager.settle, drain: manager.drain,
      }),
    ), scope);
    const runtime = yield* resolveSessionRuntime({
      openKernel: plane.openKernel, listSessions: plane.listSessions,
      approvalPolicy: TEST_APPROVAL_POLICY, authorizeConfigure: () => Effect.succeed(true),
    }).pipe(Effect.provide(services));
    const execute = (input: Parameters<SessionRunner>[0], call: Tool.Call) =>
      createTurnDispatcher(input, runtime).pipe(Effect.flatMap((dispatcher) =>
        dispatcher.execute(call, { sessionId, turnId: input.turnId, signal: input.signal }),
      ));
    let runner: SessionRunner = options.runner ?? (() => Effect.succeed({ kind: "result", text: "" }));
    const turns = yield* plane.runtime(runtime).turns.pipe(Effect.provide(services));
    const handle: ActivationHandle = {
      kernel, authority: { sessionId, owner: "activation", fence }, scope,
      env: {
        owner: "activation", clock: () => 1, catalog: plane.catalog, openSession: plane.sessionStore,
        ports: {
          approvalPolicy: TEST_APPROVAL_POLICY, capabilityKinds: ["tool", "action"],
          inputRegistrations: ["prompt", "action", "signal"],
          runTurn: turns.run((input) => runner(input), scope),
          runTool: turns.tool(execute, scope, options.wrap),
        },
      },
      drain: { alarmsBeforePrompt: 4, maxArmed: 64, idleMs: 60_000, sweep: { full: false, idleDays: 7 } },
      gate: yield* Semaphore.make(1), live: { current: undefined }, closing: { current: false },
      toolCalls: new Map(),
      forwards: forwardState(), keepAlive: () => Effect.void,
    };
    const prompt = (origin: PlainValue = { kind: "external", inboundTreatment: "full_access" }) =>
      deliver(handle, { kind: "prompt", body: '{"content":[{"kind":"text","text":"act"}]}', source: canonicalJson(origin), idempotencyKey: entropy.id() });
    const settled = Effect.suspend(() => handle.live.current === undefined
      ? Effect.void : Deferred.await(handle.live.current));
    return {
      plane, kernel, sessionId, handle, runtime,
      context: services satisfies Context.Context<SessionEntryServices>,
      execute, prompt, settled,
      run: (next: SessionRunner) => { runner = next; },
      tool: (input: { readonly sourceTurnId: string; readonly call: Tool.Call; readonly waitMs: number }) =>
        executeExternalTool(handle, { ...input, call: canonicalJson(input.call) }).pipe(
          Effect.map((result) => Tool.Result.parse(JSON.parse(result))),
        ),
    };
  });
}
