import { canonicalJson, type DecisionFact, type Machine, type Storage } from "@oni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import type { PermissionAnswerOutcome, PermissionPort } from "../seams";

/**
 * The app refuses an unanswered request before the machine client's own
 * `hook::DECIDE` bound (120 s), so the cli hook always receives a host answer.
 */
export const AGENT_PERMISSION_DEADLINE_MS = 100_000;

/** The host's backstop sits past the app deadline: it fires only when this port itself hangs. */
export const AGENT_PERMISSION_HOST_DEADLINE_MS = AGENT_PERMISSION_DEADLINE_MS + 10_000;

const FACT_TYPE = "agent_permission.decided";

const Answer = z.object({ status: z.enum(["allowed", "denied"]) }).strict();

interface DeliverInput {
  readonly kind: "action";
  readonly body: string;
  readonly source: string;
  readonly idempotencyKey: string;
}

export interface AgentPermissionDeps {
  /** The kernel session whose cli turn runs the agent session; undefined once that child is gone. */
  readonly owner: (agentSessionId: string) => string | undefined;
  readonly deliver: (sessionId: string, input: DeliverInput) => Effect.Effect<void, Error>;
  readonly decisions: (sessionId: string) => Pick<Storage.DecisionFactSubAdapter, "head" | "record">;
  readonly incident: (message: string, error: Error) => void;
  readonly now: () => number;
  readonly deadlineMs?: number;
}

export interface AgentPermissionPort extends PermissionPort {
  readonly decide: (
    machineId: Machine.MachineId,
    request: Machine.AgentPermissionRequest,
  ) => Effect.Effect<Machine.AgentPermissionDecision>;
}

const requestKey = (machineId: string, agentSessionId: string, requestId: string): string =>
  `agent-permission:${machineId}:${agentSessionId}:${requestId}`;

function refusal(request: Machine.AgentPermissionRequest, reason: "denied" | "timeout"): Machine.AgentPermissionDecision {
  return { status: "refused", sessionId: request.sessionId, requestId: request.requestId, reason };
}

const statusOf = (fact: DecisionFact.Recorded): "allowed" | "denied" => {
  const answer = Answer.safeParse(fact.data);
  return answer.success ? answer.data.status : "denied";
};

function decisionOf(request: Machine.AgentPermissionRequest, fact: DecisionFact.Recorded): Machine.AgentPermissionDecision {
  return statusOf(fact) === "allowed"
    ? { status: "allowed", sessionId: request.sessionId, requestId: request.requestId }
    : refusal(request, "denied");
}

/**
 * The machine host's `decideAgentPermission` port (#1665): the owning session
 * decides out of band, so nothing here starts a turn or holds the session fence.
 */
export function createAgentPermissionPort(deps: AgentPermissionDeps): AgentPermissionPort {
  const deadlineMs = deps.deadlineMs ?? AGENT_PERMISSION_DEADLINE_MS;
  const waiters = new Map<string, Set<(fact: DecisionFact.Recorded) => void>>();
  const slotOf = (owner: string, key: string) => `${owner}\n${key}`;

  function awaitAnswer(owner: string, key: string): Effect.Effect<DecisionFact.Recorded | undefined> {
    return Effect.callback<DecisionFact.Recorded>((resume) => {
      const slot = slotOf(owner, key);
      const drop = () => {
        const set = waiters.get(slot);
        set?.delete(wake);
        if (set?.size === 0) waiters.delete(slot);
      };
      const wake = (fact: DecisionFact.Recorded) => {
        drop();
        resume(Effect.succeed(fact));
      };
      const set = waiters.get(slot) ?? new Set();
      set.add(wake);
      waiters.set(slot, set);
      // An answer recorded between the caller's head read and this registration woke nobody.
      const recorded = deps.decisions(owner).head(key);
      if (recorded !== undefined) wake(recorded);
      return Effect.sync(drop);
    }).pipe(
      Effect.timeoutOption(deadlineMs),
      Effect.map((outcome) => (outcome._tag === "Some" ? outcome.value : undefined)),
    );
  }

  const decide: AgentPermissionPort["decide"] = (machineId, request) => Effect.suspend(() => {
    const owner = deps.owner(request.sessionId);
    if (owner === undefined) return Effect.succeed(refusal(request, "denied"));
    const key = requestKey(machineId, request.sessionId, request.requestId);
    const recorded = deps.decisions(owner).head(key);
    if (recorded !== undefined) return Effect.succeed(decisionOf(request, recorded));
    // The row's field names are the `provision` permission_allow/permission_deny argument names.
    const row = {
      kind: "agent_permission",
      machineId,
      agentSessionId: request.sessionId,
      requestId: request.requestId,
      tool: request.tool,
      description: request.description,
      deadlineMs,
    };
    return deps.deliver(owner, {
      kind: "action",
      body: canonicalJson({ content: [{ kind: "text", text: canonicalJson(row) }] }),
      source: canonicalJson({ kind: "agent_permission", machineId }),
      idempotencyKey: key,
    }).pipe(
      Effect.andThen(awaitAnswer(owner, key)),
      Effect.map((fact) => (fact === undefined ? refusal(request, "timeout") : decisionOf(request, fact))),
      Effect.catch((error) => {
        deps.incident(`agent permission request ${key} was not delivered to ${owner}`, error);
        return Effect.succeed(refusal(request, "denied"));
      }),
    );
  });

  const answer: PermissionPort["answer"] = (input): PermissionAnswerOutcome => {
    if (deps.owner(input.agentSessionId) !== input.sessionId) return { kind: "not_owner" };
    const key = requestKey(input.machineId, input.agentSessionId, input.requestId);
    const outcome = deps.decisions(input.sessionId).record({
      key,
      type: FACT_TYPE,
      data: { status: input.status },
      timeCreated: deps.now(),
    });
    if (outcome.kind === "exists") return { kind: "exists", status: statusOf(outcome.fact) };
    for (const wake of [...(waiters.get(slotOf(input.sessionId, key)) ?? [])]) wake(outcome.fact);
    return { kind: "recorded", status: input.status };
  };

  return { decide, answer };
}
