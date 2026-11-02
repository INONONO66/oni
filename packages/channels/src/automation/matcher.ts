import { createHash } from "node:crypto";
import { Ingress } from "@oni/protocol";
import { z } from "zod";

export const PendingGroup = z.object({
  ruleId: z.string(), key: z.string(), openedAt: z.number(),
  windowSeconds: Ingress.WindowSeconds, when: Ingress.Rule.shape.when,
  inputs: z.array(Ingress.Input).min(1).max(64),
  verdict: Ingress.MatchContext.shape.verdict,
});
export type PendingGroup = z.infer<typeof PendingGroup>;

const RouteFields = Ingress.Rule.shape.then.omit({ kind: true }).extend({
  ruleId: z.string(), target: z.string(), newSession: z.boolean(), conversation: z.boolean(),
});
export const Route = z.discriminatedUnion("kind", [
  RouteFields.extend({ kind: z.literal("prompt"), origin: Ingress.Input }),
  RouteFields.extend({ kind: z.literal("action"), source: z.literal("ingress"),
    handlerRef: z.string(), body: Ingress.MatchContext }),
]);
type Route = z.infer<typeof Route>;

export interface MatchDecision {
  readonly route?: Route;
  readonly rows: readonly Ingress.RoutingDecisionPayload[];
  readonly pending: readonly PendingGroup[];
}

interface MatchPorts {
  readonly now: number;
  readonly pending: readonly PendingGroup[];
  readonly matchedToday: (id: string) => number;
}

export function scheduleTickChannel(cron: string): string {
  return `cron:${cron}`;
}

function context(record: Ingress.Rule, inputs: readonly Ingress.Input[]): Ingress.MatchContext {
  const latest = inputs.at(-1);
  return Ingress.MatchContext.parse({
    ruleId: record.id, when: record.when,
    ...(record.judge === undefined ? {} : { verdict: "yes" }),
    event: {
      instance: latest?.instance, channel: latest?.channelId, thread: latest?.threadId,
      from: latest?.author.externalId,
      messages: inputs.map((entry) => ({ eventId: entry.eventId, body: entry.body, receivedAt: entry.receivedAt })),
    },
  });
}

function ledger(input: Ingress.Input, now: number, id: string,
  decision: "matched" | "filtered" | "refused" | "grouped", reason: string,
  when?: Ingress.Rule["when"], verdict?: "yes"): Ingress.RoutingDecisionPayload {
  return Ingress.Events.RoutingDecision.schema.parse({
    traceId: input.eventId, time: now, inboundId: input.eventId, surface: input.surface,
    mode: "direct", stage: "automation", outcome: "record", decision, by: `rule/${id}`,
    reason, factsUsed: when === undefined ? [] : Object.keys(when),
    factsDigest: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
    ...(verdict === undefined ? {} : { verdict }),
  });
}

function route(record: Ingress.Rule, inputs: readonly Ingress.Input[]): Route {
  const fields = { ...record.then, ruleId: record.id, newSession: record.then.target === "new", conversation: record.then.target === "conversation" };
  return record.then.kind === "prompt"
    ? Route.parse({ ...fields, kind: "prompt", origin: { ...inputs.at(-1), body: inputs.map((input) => input.body).join("\n\n") } })
    : { ...fields, kind: "action", source: "ingress", handlerRef: `rule/${record.id}`, body: context(record, inputs) };
}

/** Grouping and limits apply only after the first matching rule has been selected. */
export function routeRule(record: Ingress.Rule | undefined, input: Ingress.Input, ports: MatchPorts): MatchDecision {
  const pending = [...ports.pending];
  if (record === undefined)
    return { pending, rows: [ledger(input, ports.now, "none", "filtered", "none")] };
  const verdict = record.judge === undefined ? undefined : "yes";
  const limit = record.then.maxRunsPerDay;
  if (limit !== undefined && ports.matchedToday(record.id) >= limit)
    return { pending, rows: [ledger(input, ports.now, record.id, "refused", "limit", record.when, verdict)] };
  const group = record.group;
  if (group !== undefined && group.windowSeconds > 0) {
    const key = JSON.stringify([input.instance, input.channelId, input.threadId ?? input.author.externalId]);
    const index = pending.findIndex((item) => item.ruleId === record.id && item.key === key &&
      item.inputs.length < 64 && ports.now - item.openedAt < item.windowSeconds * 1000);
    const previous = index < 0 ? undefined : pending[index];
    if (index >= 0) pending.splice(index, 1);
    pending.push({ ruleId: record.id, key, openedAt: previous?.openedAt ?? ports.now,
      windowSeconds: group.windowSeconds, when: record.when, inputs: [...(previous?.inputs ?? []), input], verdict });
    return { pending, rows: [ledger(input, ports.now, record.id, "grouped", "grouped", record.when, verdict)] };
  }
  return { pending, route: route(record, [input]),
    rows: [ledger(input, ports.now, record.id, "matched", "matched", record.when, verdict)] };
}

/** Close expired windows on an explicitly supplied clock advance. */
export function advanceGroups(records: readonly Ingress.Rule[], pending: readonly PendingGroup[], now: number): {
  readonly decisions: readonly MatchDecision[]; readonly pending: readonly PendingGroup[];
} {
  const decisions: MatchDecision[] = [];
  const remaining: PendingGroup[] = [];
  for (const group of pending) {
    if (group.inputs.length < 64 && now - group.openedAt < group.windowSeconds * 1000) {
      remaining.push(group);
      continue;
    }
    const record = records.find((item) => item.id === group.ruleId);
    const latest = group.inputs.at(-1);
    if (latest === undefined) continue;
    const active = record?.enabled === true;
    const inactiveReason = record === undefined ? "removed" : "disabled";
    const rows = group.inputs.slice(0, -1).map((member) =>
      ledger(member, now, group.ruleId, active ? "grouped" : "filtered",
        active ? `firing:${latest.eventId}` : inactiveReason, group.when,
        group.verdict === "yes" ? "yes" : undefined));
    rows.push(ledger(latest, now, group.ruleId, active ? "matched" : "filtered",
      active ? "matched" : inactiveReason, group.when, group.verdict === "yes" ? "yes" : undefined));
    decisions.push({ ...(record?.enabled === true ? { route: route(record, group.inputs) } : {}), rows, pending: [] });
  }
  return { decisions, pending: remaining };
}
