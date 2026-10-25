import { delivery, turnIntent } from "../store/session-reads";
import { Effect } from "effect";
import { RunnerOutputMissing, InboundAuthorityViolation } from "../ports/failure";
import type { ExecutionApprovals } from "../loop/executor";

import type { SessionKernel } from "./entity";
import { foldAlarmChains, openAlarmIds } from "./alarm-read";
import { Delivery, AlarmOp, type LedgerAction, BusEvent, Tool, type PlainValue } from "@oni/protocol";
import type { ChatAgentConfig } from "../ports/types";
import { z } from "zod";
import type { SessionRunnerResult, SessionRuntime } from "./runtime";

export function sessionStopEvidence(
  kernel: Pick<SessionKernel, "row" | "actionById" | "historyPage">,
  sessionId: string,
  turnId: string,
  approvals: () => ExecutionApprovals | undefined,
  openIntent?: SessionRuntime["openIntent"],
): ChatAgentConfig["stopEvidence"] {
  let ordinal = kernel.row(sessionId).revision;
  const start = kernel.actionById(turnId)?.ordinal ?? ordinal;
  return () => Effect.gen(function* () {
    const revision = kernel.row(sessionId).revision;
    let progress = false;
    let blocked = false;
    while (ordinal < revision) {
      const page = kernel.historyPage(sessionId, { afterRevision: ordinal, limit: 256 });
      for (const action of page.actions) {
        if (action.ordinal > revision) break;
        progress ||= effectChanged(action);
        blocked ||= effectBlocked(action);
        ordinal = action.ordinal;
      }
      if (page.nextRevision === null) break;
    }
    const obligations = yield* (openIntent?.({ sessionId, turnId, revision }) ?? Effect.succeed([]));
    const pending = approvals()?.pending() ?? [];
    return {
      progress, blocked,
      openIntent: [...obligations.map((intent) => intent.actionId), ...pending.map((approval) => approval.id)],
      alarmIds: openAlarmIds(foldAlarmChains(kernel, sessionId, { afterRevision: start, throughRevision: revision })),
    };
  });
}

function alarmOp(action: LedgerAction.Node): "arm" | "fired" | undefined {
  if (action.kind !== "alarm") return undefined;
  const intent = action.intent.value;
  if (intent === null || typeof intent !== "object" || Array.isArray(intent)) return undefined;
  const parsed = AlarmOp.safeParse(intent.op);
  return parsed.success ? parsed.data : undefined;
}

function effectBlocked(action: LedgerAction.Node): boolean {
  const effect = action.effect.value;
  const intent = action.intent.value;
  if (action.kind === "policy.decision" && intent !== null && typeof intent === "object" && !Array.isArray(intent) && intent.verdict === "deny" && (intent.hook === "tool.pre" || intent.hook === "tool.post")) return true;
  return action.kind === "tool" && effect !== null && typeof effect === "object" && !Array.isArray(effect) && (effect.terminal === "blocked_pre" || effect.terminal === "blocked_post" || effect.terminal === "failed");
}

function effectChanged(action: LedgerAction.Node): boolean {
  if (action.kind === "session.configure" || alarmOp(action) === "arm") return true;
  if (delivery(action) !== undefined) return true;
  const effect = action.effect.value;
  return effect !== null && typeof effect === "object" && !Array.isArray(effect) && effect.stateChanged === true;
}

const ExternalOrigin = z.object({ kind: z.literal("external") });

const FullAccessOrigin = ExternalOrigin.extend({ inboundTreatment: z.literal("full_access") });

const EvidenceOnlyOrigin = ExternalOrigin.extend({ inboundTreatment: z.literal("evidence_only") });

const SessionOrigin = z.object({ kind: z.literal("session"), id: z.string() });

const TrustedOrigin = z.union([SessionOrigin, Delivery.MessageOrigin, Delivery.ReplyOrigin]);

export const InboundAuthorityViolated = BusEvent.define(
  "session.inbound_authority.violation",
  z.object({
    reason: z.enum(["unknown_origin", "undeclared_treatment", "missing_origin"]),
    messageId: z.string().optional(),
  }),
  { visibility: "user_audit" },
);

export interface InboundAuthorityDecision {
  readonly authority: "act" | "evidence_only";
  readonly violation?: InboundAuthorityViolation;
}

/**
 * A kernel-minted origin acts; an external origin acts only on a verbatim
 * `full_access` record and is evidence on `evidence_only`. Anything else is
 * unknown provenance: evidence authority plus a recorded violation — never `act`.
 */
export function inboundAuthority(origin: PlainValue): InboundAuthorityDecision {
  if (TrustedOrigin.safeParse(origin).success) return { authority: "act" };
  if (ExternalOrigin.safeParse(origin).success) {
    if (FullAccessOrigin.safeParse(origin).success) return { authority: "act" };
    if (EvidenceOnlyOrigin.safeParse(origin).success) return { authority: "evidence_only" };
    return { authority: "evidence_only", violation: new InboundAuthorityViolation("undeclared_treatment") };
  }
  return { authority: "evidence_only", violation: new InboundAuthorityViolation("unknown_origin") };
}

/**
 * No prompt means a kernel-driven turn (`act`); a prompt whose action row cannot be found is a
 * typed `missing_origin` the turn FAILS on.
 */
export function promptInboundAuthority(
  promptId: string | undefined,
  origin: PlainValue | undefined,
): InboundAuthorityDecision {
  if (promptId === undefined) return { authority: "act" };
  if (origin !== undefined) return inboundAuthority(origin);
  return { authority: "evidence_only", violation: new InboundAuthorityViolation("missing_origin") };
}

const ToolTurnOrigin = z.object({ toolCall: Tool.Call, sourceTurnId: z.string() });

/** Only Core's external entry writes this marker on an action consumed by its own turn. */
export function externalToolOrigin(kernel: SessionKernel, turnId: string): Delivery.Origin | undefined {
  const intent = turnIntent(kernel.actionById(turnId));
  for (const id of intent?.deliveryIds ?? []) {
    const action = kernel.actionById(id);
    if (action?.kind === "action" && ToolTurnOrigin.safeParse(action.intent.value).success)
      return action.intent;
  }
  return undefined;
}

export function turnInboundAuthority(kernel: SessionKernel, turnId: string, promptId: string | undefined) {
  const external = externalToolOrigin(kernel, turnId);
  const origin = promptId === undefined ? undefined : kernel.actionById(promptId)?.intent;
  return external === undefined ? promptInboundAuthority(promptId, origin?.value) : inboundAuthority(external.value);
}

/** Reuse the recorded initiating treatment, never a tier chosen by an external model. */
export function toolSourceOrigin(kernel: SessionKernel, sessionId: string, turnId: string): Delivery.Origin | undefined {
  const turn = kernel.actionById(turnId);
  if (turn?.sessionId !== sessionId) return undefined;
  const intent = turnIntent(turn);
  for (const id of [...(intent?.deliveryIds ?? [])].reverse()) {
    const action = kernel.actionById(id);
    if (action?.kind === "prompt") return action.intent;
  }
  return externalToolOrigin(kernel, turnId);
}

/** A runner with no output is a typed missing-output failure, not a policy refusal. */
export function runnerOutputMissingResult(turnId: string): SessionRunnerResult {
  const cause = new RunnerOutputMissing(turnId);
  return { kind: "error", text: cause.message, cause };
}
