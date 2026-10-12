import { createHash } from "node:crypto";
import { Ingress } from "@openomni/protocol";

export interface PendingGroup {
  readonly automationId: string;
  readonly key: string;
  readonly openedAt: number;
  readonly trigger: Ingress.Trigger;
  readonly inputs: readonly Ingress.Input[];
}

type Route =
  | { readonly kind: "prompt"; readonly target: string; readonly origin: Ingress.Input }
  | { readonly kind: "action"; readonly target: string; readonly source: "ingress";
      readonly handlerRef: string; readonly body: Ingress.TriggerContext };

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
  readonly judge?: (question: string, input: Ingress.Input) => {
    readonly verdict: "yes" | "no" | "unknown";
    readonly reason: string;
  };
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
    ["regex", conditions.regex === undefined || conditions.regex.some((pattern) => new RegExp(pattern).test(input.body))],
    ["dm", conditions.dm === undefined || conditions.dm === input.dm],
    ["mentionOnly", conditions.mentionOnly === undefined || !conditions.mentionOnly || input.mentionsBot],
  ];
  for (const [fact, passed] of checks) {
    if (fact in conditions) factsUsed.push(fact);
    if (!passed) return { matched: false, factsUsed, reason: fact };
  }
  return { matched: true, factsUsed, reason: "matched" };
}

function groupKey(by: "thread" | "channel" | "author", input: Ingress.Input): string {
  switch (by) {
    case "thread": return input.threadId ?? input.channelId ?? input.surface;
    case "channel": return input.channelId ?? input.surface;
    case "author": return input.author.externalId;
  }
}

function context(record: Ingress.Automation, trigger: Ingress.Trigger, inputs: readonly Ingress.Input[],
  runWhen?: { readonly verdict: "yes" | "no" | "unknown"; readonly reason: string }): Ingress.TriggerContext {
  const latest = inputs[inputs.length - 1]!;
  return Ingress.TriggerContext.parse({
    automationId: record.id, trigger,
    matched: { conditions: record.conditions ?? {}, ...(runWhen === undefined ? {} : { runWhen }) },
    event: {
      surface: latest.surface, channelId: latest.channelId, threadId: latest.threadId,
      author: latest.author,
      messages: inputs.map((entry) => ({ eventId: entry.eventId, body: entry.body, receivedAt: entry.receivedAt })),
    },
  });
}

function ledger(input: Ingress.Input, now: number, id: string,
  decision: "matched" | "filtered" | "refused" | "deduped" | "grouped" | "superseded",
  reason: string, factsUsed: string[], runWhen?: { readonly verdict: "yes" | "no" | "unknown"; readonly reason: string }): Ingress.RoutingDecisionPayload {
  return Ingress.Events.RoutingDecision.schema.parse({
    traceId: input.eventId, time: now, inboundId: input.eventId, surface: input.surface,
    mode: "direct", stage: "automation", outcome: "record", decision, by: `automation/${id}`,
    reason, factsUsed, factsDigest: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
    ...(runWhen === undefined ? {} : { runWhen }),
  });
}

/** All time and history are values supplied by the caller; no store or clock is read here. */
export function match(records: readonly Ingress.Automation[], input: Ingress.Input, ports: MatchPorts): MatchDecision {
  const rows: Ingress.RoutingDecisionPayload[] = [];
  const pending = [...(ports.pending ?? [])];
  const row = (id: string, decision: "matched" | "filtered" | "refused" | "deduped" | "grouped" | "superseded",
    reason: string, factsUsed: string[], runWhen?: { readonly verdict: "yes" | "no" | "unknown"; readonly reason: string }) => {
    rows.push(ledger(input, ports.now, id, decision, reason, factsUsed, runWhen));
  };
  if (ports.seen) {
    row("ingress", "deduped", "event_id", ["eventId"]);
    return { rows, pending };
  }
  let route: Route | undefined;
  const converse = ports.conversation;
  if (converse !== undefined) route = { kind: "prompt", target: converse, origin: input };
  for (const record of records) {
    if (!record.enabled) continue;
    const trigger = record.triggers.find((candidate) => triggerMatches(candidate, input));
    if (trigger === undefined) continue;
    const structural = conditionMatches(record.conditions ?? {}, input);
    if (!structural.matched) {
      row(record.id, "filtered", structural.reason, structural.factsUsed);
      continue;
    }
    const verdict = record.runWhen === undefined ? undefined : ports.judge?.(record.runWhen, input);
    if (record.runWhen !== undefined && (verdict === undefined || verdict.verdict !== "yes")) {
      const result = verdict ?? { verdict: "unknown" as const, reason: "judge_unavailable" };
      row(record.id, "filtered", "runWhen", [...structural.factsUsed, "runWhen"], result);
      continue;
    }
    if (converse !== undefined) {
      row(record.id, "superseded", "conversation", structural.factsUsed, verdict);
      continue;
    }
    if (route !== undefined) {
      row(record.id, "superseded", "earlier_match", structural.factsUsed, verdict);
      continue;
    }
    if (record.limits !== undefined && (ports.matchedToday?.(record.id) ?? 0) >= record.limits.maxRunsPerDay) {
      row(record.id, "refused", "limit", [...structural.factsUsed, "limits.maxRunsPerDay"], verdict);
      continue;
    }
    const grouping = record.grouping;
    let inputs: readonly Ingress.Input[] = [input];
    if (grouping !== undefined && grouping.windowSeconds > 0) {
      const key = groupKey(grouping.by, input);
      const index = pending.findIndex((item) => item.automationId === record.id && item.key === key);
      const previous = index < 0 ? undefined : pending.splice(index, 1)[0]!;
      inputs = [...(previous?.inputs ?? []), input].slice(-64);
      if (previous === undefined || ports.now - previous.openedAt < grouping.windowSeconds * 1000) {
        pending.push({ automationId: record.id, key, openedAt: previous?.openedAt ?? ports.now, trigger, inputs });
        continue;
      }
      for (const member of inputs.slice(0, -1)) {
        rows.push(ledger(member, ports.now, record.id, "grouped", `firing:${input.eventId}`, structural.factsUsed));
      }
    }
    route = record.kind === "prompt"
      ? { kind: "prompt", target: record.target, origin: input }
      : { kind: "action", target: record.target, source: "ingress", handlerRef: `automation/${record.id}`,
          body: context(record, trigger, inputs, verdict) };
    row(record.id, "matched", "matched", structural.factsUsed, verdict);
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
    const record = records.find((candidate) => candidate.id === group.automationId);
    if (record?.grouping === undefined || now - group.openedAt < record.grouping.windowSeconds * 1000) {
      remaining.push(group);
      continue;
    }
    const latest = group.inputs[group.inputs.length - 1]!;
    const rows = group.inputs.slice(0, -1).map((member) =>
      ledger(member, now, record.id, record.enabled ? "grouped" : "filtered",
        record.enabled ? `firing:${latest.eventId}` : "disabled", ["grouping"]));
    if (record.enabled) rows.push(ledger(latest, now, record.id, "matched", "matched", ["grouping"]));
    else rows.push(ledger(latest, now, record.id, "filtered", "disabled", ["grouping"]));
    decisions.push({
      ...(record.enabled ? { route: record.kind === "prompt"
        ? { kind: "prompt" as const, target: record.target, origin: latest }
        : { kind: "action" as const, target: record.target, source: "ingress" as const,
            handlerRef: `automation/${record.id}`, body: context(record, group.trigger, group.inputs) } } : {}),
      rows, pending: [],
    });
  }
  return { decisions, pending: remaining };
}
