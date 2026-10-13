import { createHash } from "node:crypto";
import { Ingress } from "@openomni/protocol";
import { z } from "zod";
import { compiledPattern } from "./regex.js";

interface Verdict {
  readonly verdict: "yes" | "no" | "unknown";
  readonly reason: string;
}

export const PendingGroup = z.object({
  automationId: z.string(), key: z.string(), openedAt: z.number(),
  windowSeconds: Ingress.WindowSeconds, trigger: Ingress.Trigger,
  inputs: z.array(Ingress.Input).min(1).max(64),
  runWhen: Ingress.TriggerContext.shape.matched.shape.runWhen,
});
export type PendingGroup = z.infer<typeof PendingGroup>;

export const Route = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prompt"), target: z.string(), origin: Ingress.Input,
    automationId: z.string().optional(), instructions: z.string().optional(), newSession: z.boolean().optional() }),
  z.object({ kind: z.literal("action"), target: z.string(), source: z.literal("ingress"),
    handlerRef: z.string(), body: Ingress.TriggerContext,
    automationId: z.string().optional(), instructions: z.string().optional(), newSession: z.boolean().optional() }),
]);
type Route = z.infer<typeof Route>;

export interface MatchDecision {
  readonly route?: Route;
  readonly rows: readonly Ingress.RoutingDecisionPayload[];
  readonly pending: readonly PendingGroup[];
}

export interface MatchPorts {
  readonly now: number;
  readonly conversation?: string;
  readonly pending?: readonly PendingGroup[];
  readonly seen?: boolean;
  readonly matchedToday?: (id: string) => number;
  readonly judge?: (question: string, input: Ingress.Input) => Verdict;
}

function triggerMatches(trigger: Ingress.Trigger, input: Ingress.Input): boolean {
  switch (trigger.type) {
    case "message": return trigger.surface === input.surface && trigger.event === input.event;
    case "webhook": return input.event === "webhook" && trigger.secretRef === input.channelId;
    case "github": return input.event === "github" && trigger.event === input.channelId;
    case "schedule": return input.event === "schedule" && trigger.cron === input.channelId;
    case "on_demand": return false;
  }
}

function conditionMatches(conditions: Ingress.Conditions, input: Ingress.Input): {
  readonly matched: boolean; readonly factsUsed: string[]; readonly reason: string;
} {
  const factsUsed: string[] = [];
  const checks: readonly [string, boolean][] = [
    ["includeBots", conditions.includeBots !== false || !input.author.isBot],
    ["channels", conditions.channels === undefined || (input.channelId !== undefined && conditions.channels.includes(input.channelId))],
    ["users", conditions.users === undefined || conditions.users.includes(input.author.externalId)],
    ["threads", conditions.threads === undefined || (input.threadId !== undefined && conditions.threads.includes(input.threadId))],
    ["contains", conditions.contains === undefined || conditions.contains.some((text) => input.body.includes(text))],
    ["excludes", conditions.excludes === undefined || conditions.excludes.every((text) => !input.body.includes(text))],
    ["regex", conditions.regex === undefined || conditions.regex.some((pattern) => compiledPattern(pattern).test(input.body))],
    ["dm", conditions.dm === undefined || conditions.dm === input.dm],
    ["mentionOnly", conditions.mentionOnly === undefined || !conditions.mentionOnly || input.mentionsBot],
  ];
  for (const [fact, passed] of checks) {
    if (fact in conditions) factsUsed.push(fact);
    if (!passed) return { matched: false, factsUsed, reason: fact };
  }
  return { matched: true, factsUsed, reason: "matched" };
}

type Candidate =
  | { readonly kind: "skip" }
  | { readonly kind: "filtered"; readonly reason: string; readonly factsUsed: string[];
      readonly runWhen?: Verdict }
  | { readonly kind: "match"; readonly trigger: Ingress.Trigger;
      readonly factsUsed: string[]; readonly runWhen?: Verdict };

function candidate(record: Ingress.Automation, input: Ingress.Input, judge?: MatchPorts["judge"],
  superseded = false): Candidate {
  if (!record.enabled) return { kind: "skip" };
  const trigger = record.triggers.find((item) => triggerMatches(item, input));
  if (trigger === undefined) return { kind: "skip" };
  const structural = conditionMatches(record.conditions ?? {}, input);
  if (!structural.matched) return { kind: "filtered", reason: structural.reason, factsUsed: structural.factsUsed };
  const verdict = record.runWhen === undefined || superseded ? undefined : judge?.(record.runWhen, input);
  if (!superseded && record.runWhen !== undefined && verdict?.verdict !== "yes") {
    return { kind: "filtered", reason: "runWhen", factsUsed: [...structural.factsUsed, "runWhen"],
      runWhen: verdict ?? { verdict: "unknown", reason: "judge_unavailable" } };
  }
  return { kind: "match", trigger, factsUsed: structural.factsUsed,
    ...(verdict === undefined ? {} : { runWhen: verdict }) };
}

function groupKey(by: "thread" | "channel" | "author", input: Ingress.Input): string {
  switch (by) {
    case "thread": return input.threadId ?? input.channelId ?? input.surface;
    case "channel": return input.channelId ?? input.surface;
    case "author": return input.author.externalId;
  }
}

function context(record: Ingress.Automation, trigger: Ingress.Trigger, inputs: readonly Ingress.Input[],
  runWhen?: Verdict): Ingress.TriggerContext {
  const latest = inputs.at(-1);
  return Ingress.TriggerContext.parse({
    automationId: record.id, trigger,
    matched: { conditions: record.conditions ?? {}, ...(runWhen === undefined ? {} : { runWhen }) },
    event: {
      surface: latest?.surface, channelId: latest?.channelId, threadId: latest?.threadId,
      author: latest?.author,
      messages: inputs.map((entry) => ({ eventId: entry.eventId, body: entry.body, receivedAt: entry.receivedAt })),
    },
  });
}

function ledger(input: Ingress.Input, now: number, id: string,
  decision: "matched" | "filtered" | "refused" | "deduped" | "grouped" | "superseded",
  reason: string, factsUsed: string[], runWhen?: Verdict): Ingress.RoutingDecisionPayload {
  return Ingress.Events.RoutingDecision.schema.parse({
    traceId: input.eventId, time: now, inboundId: input.eventId, surface: input.surface,
    mode: "direct", stage: "automation", outcome: "record", decision, by: `automation/${id}`,
    reason, factsUsed, factsDigest: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
    ...(runWhen === undefined ? {} : { runWhen }),
  });
}

function collectGroup(record: Ingress.Automation, trigger: Ingress.Trigger, input: Ingress.Input,
  at: number, pending: PendingGroup[], factsUsed: string[], verdict?: Verdict): {
  readonly inputs: readonly Ingress.Input[];
  readonly held: boolean;
  readonly rows: readonly Ingress.RoutingDecisionPayload[];
} {
  const grouping = record.grouping;
  if (grouping === undefined || grouping.windowSeconds === 0)
    return { inputs: [input], held: false, rows: [] };
  const key = groupKey(grouping.by, input);
  const index = pending.findIndex((item) => item.automationId === record.id && item.key === key &&
    item.inputs.length < 64 && at - item.openedAt < item.windowSeconds * 1000);
  const previous = index < 0 ? undefined : pending[index];
  if (index >= 0) pending.splice(index, 1);
  const inputs = [...(previous?.inputs ?? []), input];
  pending.push({ automationId: record.id, key, openedAt: previous?.openedAt ?? at,
    windowSeconds: grouping.windowSeconds, trigger, inputs,
    ...(verdict === undefined ? {} : { runWhen: verdict }) });
  return { inputs, held: true,
    rows: [ledger(input, at, record.id, "grouped", "grouped", factsUsed, verdict)] };
}

function limitReached(record: Ingress.Automation, ports: MatchPorts): boolean {
  return record.limits !== undefined &&
    (ports.matchedToday?.(record.id) ?? 0) >= record.limits.maxRunsPerDay;
}

/** All time and history are values supplied by the caller; no store or clock is read here. */
export function match(records: readonly Ingress.Automation[], input: Ingress.Input, ports: MatchPorts): MatchDecision {
  const rows: Ingress.RoutingDecisionPayload[] = [];
  const pending = [...(ports.pending ?? [])];
  if (ports.seen) {
    return { rows, pending };
  }
  let route: Route | undefined = ports.conversation === undefined ? undefined
    : { kind: "prompt", target: ports.conversation, origin: input };
  for (const record of records) {
    const result = candidate(record, input, ports.judge, route !== undefined);
    if (result.kind === "skip") continue;
    if (result.kind === "filtered") {
      rows.splice(0, rows.length, ledger(input, ports.now, record.id, "filtered", result.reason,
        result.factsUsed, result.runWhen));
      continue;
    }
    if (route !== undefined) {
      rows.splice(0, rows.length, ledger(input, ports.now, record.id, "superseded",
        ports.conversation === undefined ? "earlier_match" : "conversation",
        result.factsUsed, result.runWhen));
      break;
    }
    if (limitReached(record, ports)) {
      rows.splice(0, rows.length, ledger(input, ports.now, record.id, "refused", "limit",
        [...result.factsUsed, "limits.maxRunsPerDay"], result.runWhen));
      break;
    }
    const group = collectGroup(record, result.trigger, input, ports.now, pending,
      result.factsUsed, result.runWhen);
    rows.splice(0, rows.length, ...group.rows);
    if (group.held) break;
    route = record.kind === "prompt"
      ? { kind: "prompt", target: record.target, origin: input,
          automationId: record.id, instructions: record.instructions, newSession: record.target === "new" }
      : { kind: "action", target: record.target, source: "ingress", handlerRef: `automation/${record.id}`,
          body: context(record, result.trigger, group.inputs, result.runWhen),
          automationId: record.id, instructions: record.instructions, newSession: record.target === "new" };
    rows.push(ledger(input, ports.now, record.id, "matched", "matched", result.factsUsed, result.runWhen));
    break;
  }
  return { ...(route === undefined ? {} : { route }), rows, pending };
}

/** Close expired windows on an explicitly supplied clock advance, even without a new event. */
export function advanceGroups(records: readonly Ingress.Automation[], pending: readonly PendingGroup[], now: number): {
  readonly decisions: readonly MatchDecision[]; readonly pending: readonly PendingGroup[];
} {
  const decisions: MatchDecision[] = [];
  const remaining: PendingGroup[] = [];
  for (const group of pending) {
    if (group.inputs.length < 64 && now - group.openedAt < group.windowSeconds * 1000) {
      remaining.push(group);
      continue;
    }
    const record = records.find((item) => item.id === group.automationId);
    const latest = group.inputs.at(-1);
    if (latest === undefined) continue;
    const active = record?.enabled === true;
    const inactiveReason = record === undefined ? "removed" : "disabled";
    const rows = group.inputs.slice(0, -1).map((member) =>
      ledger(member, now, group.automationId, active ? "grouped" : "filtered",
        active ? `firing:${latest.eventId}` : inactiveReason, ["grouping"], group.runWhen));
    rows.push(ledger(latest, now, group.automationId, active ? "matched" : "filtered",
      active ? "matched" : inactiveReason, ["grouping"], group.runWhen));
    const route: Route | undefined = record?.enabled !== true ? undefined
      : record.kind === "prompt"
        ? { kind: "prompt", target: record.target,
            automationId: record.id, instructions: record.instructions, newSession: record.target === "new",
            origin: { ...latest, body: group.inputs.map((input) => input.body).join("\n\n") } }
        : { kind: "action", target: record.target, source: "ingress",
            automationId: record.id, instructions: record.instructions, newSession: record.target === "new",
            handlerRef: `automation/${record.id}`, body: context(record, group.trigger, group.inputs, group.runWhen) };
    decisions.push({ ...(route === undefined ? {} : { route }), rows, pending: [] });
  }
  return { decisions, pending: remaining };
}
