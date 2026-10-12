import { Effect, Semaphore } from "effect";
import { messageDecisionRules } from "./message-decision";
import { APPROVAL_POLICY } from "../bundles/approval-policy";
import { Core } from "@openomni/agent";
const adoptedExecutionLedger = Core.adoptedExecutionLedger;
const createExecutor = Core.createExecutor;
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

type ExecutionResult = Effect.Success<ReturnType<Effect.Success<ReturnType<typeof createExecutor>>["run"]>>;
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
    // from an earlier boot is the idempotent outcome.
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
      // The perimeter has no live turn: the core adopts the fence for this
      // request's writer and owns every revision the executor commits at.
      const ledger = yield* adoptedExecutionLedger(kernel, id, owner, clock).pipe(
        Effect.mapError((error) => new CommitFailed({ error })),
      );
      const work = Effect.gen(function* () {
      const executor = yield* createExecutor({
        approvalPolicy: APPROVAL_POLICY,
        identity: { sessionId: id, role: "resident", parentActionId: null },
        ledger,
      });
      return yield* executor.run(request, body).pipe(
        Effect.map((result) => ({ ...result, matchedRuleIds: messageDecisionRules(kernel, id, request) })),
      );
      });
      return yield* captured.provide(work).pipe(Effect.provide(services));
    })));
  });
}
