import { APPROVAL_POLICY } from "../../src/bundles/approval-policy/index";
import { Effect } from "effect";
import { Bundle, Core } from "@openomni/agent";
const createDispatcher = Bundle.createDispatcher;
const createExecutor = Core.createExecutor;
import type {
  AnyToolDefinition,
  ObservationSink,
  PlainValue,
  SessionTransition,
} from "@openomni/protocol";
import { compiledPolicy } from "../../../../packages/agent/test/helpers/compiled-policy";
import { bounded } from "../../../../packages/agent/test/helpers/request-ledger";
import { requestLedger } from "../../../../packages/agent/test/helpers/effect-g1";
import { createRequestDomainRevisions } from "../../src/composition/request-domain-revisions";
import type { AppLedgerPlane, SessionKernel } from "../../src/composition/cluster-runtime";
import { testPlane } from "./ledger";
import { PROVISION_POLICY_ROWS } from "../../src/bundles/provision/provision";
import { executorLayer, catalogLayer } from "../../../../packages/agent/test/helpers/service-layers";
import { runEffect, runSyncEffect } from "./effect";
import { provisionPort } from "./provision-port";

export { bounded };
export function protectedDispatch(
  definition: AnyToolDefinition,
  input: Record<string, PlainValue>,
  observations: ObservationSink = { publish: () => undefined },
  options: {
    readonly plane?: AppLedgerPlane;
    readonly kernel?: SessionKernel;
  } = {},
) {
  const opened = Promise.withResolvers<SessionTransition.Request>();
  const clockRef = { now: 100 };
  const plane = options.plane ?? testPlane();
  const sessionId = crypto.randomUUID();
  const kernel: SessionKernel = options.kernel ?? plane.openKernel(sessionId);
  const recording = runSyncEffect(requestLedger({
    id: sessionId,
    clock: () => clockRef.now,
    domainRevisions: createRequestDomainRevisions({ ...plane.stores, automations: provisionPort(plane).automations }),
    kernel,
    onRequest(request) {
      if (request.state === "open") opened.resolve(request);
    },
  }));
  const controller = new AbortController();
  const executor = runSyncEffect(createExecutor({
    ...recording,
    approvalPolicy: APPROVAL_POLICY,
    authorizeApproval: () => Effect.succeed({
      kind: "owner" as const,
      principalId: "owner",
      evidenceId: "authenticated",
    }),
  }).pipe(Effect.provide(executorLayer({ ...recording, observations, policy: compiledPolicy(PROVISION_POLICY_ROWS.map((row) => ({ ...row, generation: 1 }))) }))));
  const dispatcher = runSyncEffect(createDispatcher({ executor }).pipe(Effect.provide(catalogLayer([definition]))));
  const execution = dispatcher.execute(
    { id: "original-call", tool: definition.name, input },
    { sessionId: recording.identity.sessionId, turnId: recording.identity.turnId ?? "turn", signal: controller.signal },
  );
  const outcome = runEffect(Effect.result(execution));
  const running = outcome.then((result) => {
    if (result._tag === "Failure") throw result.failure;
    return result.success;
  });
  return {
    outcome,
    plane,
    // TS2742 guard: name the kernel through the app's portable alias.
    kernel: kernel as SessionKernel,
    ...recording,
    executor,
    running,
    opened: opened.promise,
    async answer(decision: "approve" | "refuse" = "approve") {
      await bounded(opened.promise);
      const pending = executor.approvals?.pending()[0];
      if (pending === undefined) throw new Error("missing protected invocation");
      if (executor.approvals === undefined) throw new Error("missing approval port");
      const answer = await runEffect(Effect.result(executor.approvals.answer({ request: pending, decision, credential: "owner-token" })));
      if (answer._tag === "Failure") throw answer.failure;
      return bounded(running);
    },
    setClock(at: number) {
      clockRef.now = at;
    },
    async close() {
      controller.abort();
      await bounded(Promise.allSettled([running]));
    },
  };
}
