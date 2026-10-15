import { Effect, Semaphore } from "effect";
import { messageDecisionRules } from "./message-decision";
import { APPROVAL_POLICY } from "./policy";
import { Core } from "@openomni/agent";
type Executor = Core.Executor;
const Entropy = Core.Entropy;
const GenerationLayers = Core.GenerationLayers;
const CommitFailed = Core.CommitFailed;
const AgentFailure = Core.AgentFailure;
type ExecutionError = Core.ExecutionError;
type SessionEntryServices = Core.SessionEntryServices;
import type { LedgerAction, PlainValue } from "@openomni/protocol";
import type { createGatewayRouter } from "@openomni/channels";
import type { AppLedgerPlane } from "./cluster-runtime";
import { ComposedGeneration } from "./composed";
import { captureNow } from "./platform";

type ExecutionResult = Effect.Success<ReturnType<Executor["run"]>>;
type Run = Parameters<typeof createGatewayRouter>[0]["run"];
type NativeRun = (sender: Parameters<Run>[0], request: Parameters<Run>[1], body: (intent: LedgerAction.Receipt) => Effect.Effect<PlainValue, ExecutionError>) => Effect.Effect<ExecutionResult & { readonly matchedRuleIds: readonly string[] }, ExecutionError>;

/** The fixed perimeter session every external decision is recorded against. */
export const GATEWAY_INGRESS_SESSION = "gateway-ingress";

/** External authentication has no active model turn; its message actions have one fenced owner. */
export function createIngressExecutor(plane: AppLedgerPlane): Effect.Effect<NativeRun, ExecutionError, SessionEntryServices | ComposedGeneration> {
  return Effect.gen(function* () {
    const id = GATEWAY_INGRESS_SESSION;
    const services = yield* Effect.context<SessionEntryServices>();
    const generations = yield* GenerationLayers;
    const clock = yield* captureNow;
    const { id: nextId } = yield* Entropy;
    const composed = yield* ComposedGeneration;
    const kernel = plane.openKernel(id);
    // #1346: the perimeter session is created through the one core creation
    // door (genesis row + catalog index in one write); an existing session
    // from an earlier boot is the idempotent outcome, while an orphan index
    // row with no genesis file fails boot typed (#1346 M3).
    yield* Core.createSession(plane, {
      id, parentId: null, role: "resident",
      genesis: {
        tools: [], bundles: composed.current().generation.bundles, system: { preset: "", blocks: [] },
        policyGeneration: kernel.currentPolicyGeneration(), actionId: nextId(), at: clock(),
      },
    }).pipe(
      Effect.catchIf((error) => error.reason === "duplicate", () => Effect.void),
      Effect.mapError((error) => new CommitFailed({ error })),
    );
    const serial = yield* Semaphore.make(1);
    return (_sender, request, body) => serial.withPermits(1)(Effect.scoped(Effect.gen(function* () {
      const row = kernel.row(id);
      const owner = nextId();
      const captured = yield* generations.capture({ sessionId: id, generation: row.toolsGeneration }).pipe(Effect.mapError((error) => new AgentFailure({ operation: "ingress.capture", cause: String(error) })));
      // The perimeter has no live turn and no entity activation: the core
      // adopts the fence for this request's writer and builds the gate's
      // executor over its own fenced door (#1346 M1). The app holds the
      // executor — run under the gate — never a ledger, fence or commit.
      const work = Effect.gen(function* () {
      const executor = yield* Core.adoptedExecutor(kernel, id, owner, clock, {
        approvalPolicy: APPROVAL_POLICY,
        identity: { sessionId: id, role: "resident", parentActionId: null },
      });
      return yield* executor.run(request, body).pipe(
        Effect.map((result) => ({ ...result, matchedRuleIds: messageDecisionRules(kernel, id, request) })),
      );
      });
      return yield* captured.provide(work).pipe(Effect.provide(services));
    })));
  });
}
