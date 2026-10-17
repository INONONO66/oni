import type { OpenTurn, PendingSnapshot } from "../store/session-reads";
import { generationSnapshot, configureAction } from "../store/configure";
import { Effect } from "effect";
import { CommitRefused, type LedgerError } from "../store/errors";

import type { CommitReceipt } from "../store/services";
import { ObservationSink, type RunnerServices } from "../ports/ports";
import { canonicalDigest, Journal, type SessionGeneration, type Delivery, type LedgerAction, type LedgerSession, type PlainValue, } from "@openomni/protocol";
import { createExecutor } from "../loop/executor";
import { DEFAULT_TOOL_OUTPUT_BUDGET_BYTES } from "../ports/tool-output";
import { AgentFailure, CommitFailed, type ExecutionError, type SessionError } from "../ports/failure";
import { SessionPolicyRefusal } from "../journal/messages";
import type { ResolvedSessionRuntime, SessionRunnerResult } from "./run";
import type { ExecutionLedger } from "../loop/executor";
import type { SessionKernel } from "./entity";
import { turnIntentAction } from "../journal/turn-rows";
import { deliveryActions, inputRowKind, boundaryConsumption, consumptionSettings } from "../journal/delivery";
import { policyRefusalResult } from "../journal/commit";
import type { SessionControllerState } from "./run";
import { observeDrained } from "../observation/bus";
import { commitSessionRequest } from "./request";

import { commitFoldBatch } from "../journal/compaction";

type AdmissionError = SessionError;

interface AdmissionSnapshot {
  readonly row: LedgerSession.Row;
  readonly pending: readonly Delivery.Row[];
  readonly open?: OpenTurn;
  readonly terminal?: ReturnType<SessionKernel["latestTurnTerminal"]>;
  /** No kinds in the snapshot is a typed `missing_capability_kinds` refusal, never a default. */
  readonly capabilityKinds?: readonly string[];
}

type AdmissionDecision =
  | { readonly kind: "stop" | "start" }
  | { readonly kind: "refused"; readonly reason?: "unknown_kind" | "missing_capability_kinds" }
  | { readonly kind: "recover"; readonly open: OpenTurn }
  | { readonly kind: "resume"; readonly item: Delivery.Row }
  | { readonly kind: "consume"; readonly items: readonly Delivery.Row[] };

/** Pure routing; dispatch remains behind the ledger CAS. */
export function decideSessionAdmission(snapshot: AdmissionSnapshot): AdmissionDecision {
  const { row, pending, open, terminal } = snapshot;
  // An input whose row kind belongs to a capability absent from the composed
  // generation is rejected, not consumed; a snapshot with no registered kinds
  // is refused typed — admission never substitutes a built-in list.
  const registered = snapshot.capabilityKinds;
  if (registered === undefined) return { kind: "refused", reason: "missing_capability_kinds" };
  if (pending.some((item) => Journal.admitInputKind(registered, inputRowKind(item.kind)) !== "ok"))
    return { kind: "refused", reason: "unknown_kind" };
  if (pending.some((item) => item.sessionId !== row.id || item.status !== "pending")) return { kind: "refused" };
  if (open !== undefined && open.action.sessionId !== row.id) return { kind: "refused" };
  if (terminal !== undefined && terminal.action.sessionId !== row.id) return { kind: "refused" };
  switch (row.state) {
    case "running":
      return open === undefined ? { kind: "refused" } : { kind: "recover", open };
    case "interrupted": {
      if (open !== undefined) return { kind: "recover", open };
      const item = pending.find((input) => input.kind === "resume");
      if (item === undefined) return { kind: "stop" };
      return terminal?.effect.kind === "interrupted"
        ? { kind: "resume", item }
        : { kind: "consume", items: [item] };
    }
    case "idle":
      return open === undefined ? decideIdleDeliveries(pending) : { kind: "refused" };
  }
}

function decideIdleDeliveries(pending: readonly Delivery.Row[]): AdmissionDecision {
  if (pending.length === 0) return { kind: "stop" };
  // An `action` input heads a turn like a prompt: boundary consumption is the
  // ONE owner of its fate (live delivers, stale closes via `turn.consumed.stale`).
  // Noop-consuming it here would drop a late hook result without the closure fact.
  const firstInput = pending.findIndex((item) => item.kind === "prompt" || item.kind === "action");
  if (firstInput === 0) return { kind: "start" };
  return { kind: "consume", items: firstInput > 0 ? pending.slice(0, firstInput) : pending };
}

export interface SessionTurnPorts<E> {
  readonly awaitRetainedRunner: () => Effect.Effect<void, E>;
  readonly runTurn: (input: {
    readonly turnId: string;
    readonly resultId: string;
    readonly parentActionId: string;
    readonly boundaryActionId: string | null;
    readonly resumeCount: number;
    readonly generation: SessionGeneration.Snapshot;
    readonly resume: boolean;
    readonly pending?: PendingSnapshot;
  }) => Effect.Effect<SessionRunnerResult, E>;
  readonly seal: (
    open: OpenTurn,
    result: SessionRunnerResult,
  ) => Effect.Effect<void, E>;
}

export function createSessionAdmission(
  kernel: SessionKernel,
  sessionId: string,
  runtime: ResolvedSessionRuntime,
  state: SessionControllerState,
  owner: string,
  clock: () => number,
  entropy: () => string,
  ports: SessionTurnPorts<AdmissionError>,
) {
  const { awaitRetainedRunner, runTurn, seal } = ports;

  function commitSession(input: {
    readonly expectedRevision: number;
    readonly actions: readonly LedgerAction.Append[];
    readonly state: LedgerSession.State;
    readonly generation?: LedgerSession.GenerationPointers;
  }): Effect.Effect<CommitReceipt, LedgerError> {
    return commitFoldBatch(kernel, {
      sessionId,
      owner,
      fence: state.fence,
      now: clock(),
      expectedRevision: input.expectedRevision,
      actions: [...input.actions],
      state: input.state,
      ...(input.generation === undefined ? {} : { generation: input.generation }),
    }, runtime.compaction);
  }

  /**
   * A composed generation differing from the adopted `manifestHash` appends one compose configure
   * before capture; rotation happens strictly between turns.
   */
  function adoptComposedManifest(): Effect.Effect<void, AdmissionError> {
    return Effect.gen(function* () {
      const composed = runtime.composed?.current();
      if (composed === undefined) return;
      const previous = kernel.latestGenerationFor(sessionId);
      if (previous.manifestHash === composed.hash) return;
      const generation = previous.generation + 1;
      const snapshot = generationSnapshot({
        generation,
        revertTo: previous.generation,
        tools: composed.tools,
        system: { preset: previous.systemPreset, blocks: previous.systemBlocks },
        policyGeneration: previous.policyGeneration,
        bundles: composed.bundles,
        manifestHash: composed.hash,
      });
      const configured = configureAction({
        id: entropy(),
        sessionId,
        parentId: kernel.latestAction(sessionId)?.id ?? null,
        operation: "compose",
        snapshot,
        disabled: composed.disabled,
        at: clock(),
      });
      const commit = commitSession({
        expectedRevision: kernel.row(sessionId).revision,
        actions: [configured],
        state: kernel.row(sessionId).state,
        generation: {
          toolsGeneration: snapshot.generation,
          systemHash: snapshot.systemHash,
          policyGeneration: snapshot.policyGeneration,
        },
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
      yield* runtime.generations.configure({ sessionId, generation }, snapshot, commit);
    });
  }

  function startTurn(): Effect.Effect<SessionRunnerResult | undefined, AdmissionError> {
    return Effect.scoped(Effect.gen(function* () {
      yield* awaitRetainedRunner();
      yield* adoptComposedManifest();
      const generation = kernel.latestGenerationFor(sessionId);
      const captured = yield* runtime.generations.capture({ sessionId, generation: generation.generation });
      const observations = yield* captured.provide(ObservationSink);
      // Turn end: steer and followUp rows are both eligible, each capped by its
      // width; the stale split lives INSIDE boundaryConsumption.
      const backlog = kernel.pendingMessagesSince(sessionId);
      const { consumed: pending, stale } = boundaryConsumption(
        backlog.rows,
        "turn_end",
        consumptionSettings(kernel, sessionId),
        kernel.compactionHead(sessionId),
      );
      const evaluatedPrompts = yield* captured.provide(evaluatePromptPolicies(pending)).pipe(Effect.provide(runtime.services));
      if (evaluatedPrompts.refusal !== undefined) {
        yield* consumePolicyBlockedDeliveries(pending);
        return policyRefusalResult(evaluatedPrompts.refusal.reason);
      }
      // A prompt.pre rewrite's output is what the turn delivers and the model reads.
      const delivered = pending.map((item) => {
        const body = evaluatedPrompts.contents.get(item.id);
        return body === undefined ? item : { ...item, content: body };
      });
      const resultId = entropy();
      const turnId = entropy();
      const parentActionId = kernel.latestAction(sessionId)?.id ?? null;
      const deliveries = deliveryActions(
        delivered,
        { kind: "turn", turnId },
        "before_llm",
        parentActionId,
      );
      const envelope = turnIntentAction({
        id: turnId,
        parentId: deliveries.at(-1)?.id ?? parentActionId,
        sessionId,
        resultId,
        deliveryIds: pending.map((item) => item.id),
        consumedStale: stale.map((item) => item.id),
        generation,
        resumeCount: 0,
        boundaryActionId: parentActionId,
        at: clock(),
      });
      yield* commitSession({
        expectedRevision: kernel.row(sessionId).revision,
        actions: [...deliveries, envelope],
        state: "running",
      });
      observeDrained(delivered, turnId, "before_llm", clock(), observations, entropy);
      if (pending.some((item) => item.kind === "interrupt" || item.kind === "cancel")) {
        const action = kernel.actionById(turnId);
        if (action === undefined) return yield* new AgentFailure({ operation: "session.turn", cause: `missing_turn:${turnId}` });
        yield* seal({
          turnId,
          resultId,
          resumeCount: 0,
          boundaryActionId: parentActionId,
          toolsGeneration: generation.generation,
          toolsHash: generation.toolsHash,
          systemHash: generation.systemHash,
          policyGeneration: generation.policyGeneration,
          action,
        }, { kind: "interrupted" });
        return { kind: "interrupted" as const };
      }
      return yield* runTurn({
        turnId,
        resultId,
        parentActionId: envelope.id,
        boundaryActionId: parentActionId,
        resumeCount: 0,
        generation,
        resume: false,
        pending: backlog,
      });
    }));
  }

  function evaluatePromptPolicies(
    items: readonly Delivery.Row[],
  ): Effect.Effect<
    { readonly refusal: SessionPolicyRefusal | undefined; readonly contents: ReadonlyMap<string, string> },
    ExecutionError,
    RunnerServices
  > {
    return Effect.gen(function* () {
      const ledger = createExecutionLedger();
      let refusal: SessionPolicyRefusal | undefined;
      // The boundary delivers the prompt.pre rewritten body, not the original.
      const contents = new Map<string, string>();
      for (const item of items) {
        if (item.kind !== "prompt") continue;
        const recorded: PlainValue = { deliveryId: item.id, status: "recorded" };
        const executor = yield* createExecutor({
          ledger,
          approvalPolicy: runtime.approvalPolicy,
          identity: { sessionId, role: kernel.row(sessionId).role, parentActionId: item.id },
        });
        const outcome = yield* executor.runExisting({
          kind: "prompt",
          op: "delivery",
          intent: { deliveryId: item.id, body: item.content, origin: item.origin.value, createdAt: item.createdAt, ordinal: item.ordinal },
          effect: { status: "recorded" },
        }, (pre) =>
          Effect.sync(() => {
            const value = pre.value;
            if (value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.body === "string" && value.body !== item.content)
              contents.set(item.id, value.body);
            return recorded;
          }));
        if (refusal !== undefined) continue;
        if (outcome.terminal !== "executed") refusal = new SessionPolicyRefusal(outcome.reason);
        else if (canonicalDigest(outcome.value) !== canonicalDigest(recorded)) refusal = new SessionPolicyRefusal("invalid_output");
      }
      return { refusal, contents };
    });
  }

  /** Blocked items leave the pending fold through committed no-op deliveries. */
  function consumePolicyBlockedDeliveries(items: readonly Delivery.Row[]): Effect.Effect<void, ExecutionError> {
    return Effect.suspend(() => {
      const current = kernel.row(sessionId);
      return commitSession({
        expectedRevision: current.revision,
        actions: deliveryActions(
          items,
          { kind: "pending" },
          "before_llm",
          kernel.latestAction(sessionId)?.id ?? null,
        ),
        state: current.state,
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })), Effect.asVoid);
    });
  }

  function createExecutionLedger(turnId?: string): ExecutionLedger {
    const executionFence = state.fence;
    return {
      // The generation's tool output budget and the session file's output store,
      // threaded to the executor/dispatcher.
      toolOutputBudgetBytes: () =>
        consumptionSettings(kernel, sessionId).toolOutputBudgetBytes ?? DEFAULT_TOOL_OUTPUT_BUDGET_BYTES,
      putToolOutput: (write) => kernel.putToolOutput(write),
      toolOutput: (outputId) => kernel.toolOutput(outputId),
      actionById: kernel.actionById,
      requestById: kernel.requestById,
      resultFor: (id) => kernel.resultFor(sessionId, id),
      openOperationsPage: (id, cursor) => kernel.openOperationsPage(sessionId, id, cursor),
      operationChildrenPage: (id, cursor) => kernel.operationChildrenPage(sessionId, id, cursor),
      guardedOperationsPage: (id, cursor) => kernel.guardedOperationsPage(sessionId, id, cursor),
      validateRequest(request) {
        const row = kernel.row(sessionId);
        return row.fenceOwner === owner && row.fence === executionFence &&
          row.toolsGeneration === request.toolsGeneration &&
          row.systemHash === request.systemHash && row.policyGeneration === request.generation &&
          (runtime.requestDomainRevisions === undefined || canonicalDigest({ ...runtime.requestDomainRevisions(request) }) === canonicalDigest(request.domainRevisions));
      },
      transition(payload, inputId, at) {
        return Effect.gen(function* () {
          const current = kernel.row(sessionId);
          if (current.fence !== executionFence || (turnId !== undefined && kernel.turnTerminalFor(sessionId, turnId) !== undefined))
            return yield* new AgentFailure({ operation: "session.request.transition", cause: "stale" });
          return yield* commitSessionRequest(kernel, sessionId, { owner, fence: executionFence }, payload, inputId, at, runtime);
        });
      },
      commit(action) {
        return Effect.gen(function* () {
          const current = kernel.row(sessionId);
          const sealed = turnId !== undefined && kernel.turnTerminalFor(sessionId, turnId) !== undefined;
          if (current.fence !== executionFence || sealed || state.terminalFrozen) return yield* new CommitRefused({
            sessionId, reason: "fence", expectedRevision: current.revision,
            currentRevision: current.revision, fence: executionFence, currentFence: current.fence,
          });
          const committed = yield* commitSession({ expectedRevision: current.revision, actions: [action], state: current.state });
          const receipt = committed.receipts[0];
          if (receipt === undefined) return yield* new AgentFailure({ operation: "session.commit", cause: "missing_receipt" });
          return receipt;
        });
      },
    };
  }

  function consumeNoopDeliveries(items: readonly Delivery.Row[]): Effect.Effect<void, AdmissionError> {
    return Effect.gen(function* () {
      const current = kernel.row(sessionId);
      const noops = deliveryActions(
        items,
        { kind: "pending" },
        "before_llm",
        kernel.latestAction(sessionId)?.id ?? null,
      );
      yield* commitSession({ expectedRevision: current.revision, actions: noops, state: current.state });
    });
  }

  return { startTurn, evaluatePromptPolicies, consumePolicyBlockedDeliveries, commitSession, createExecutionLedger, consumeNoopDeliveries };
}
