import { Journal, PlainObjectSchema, isReservedAlarmPurpose, type LedgerAction, type PlainObject, type PlainValue } from "@oni/protocol";
import type { SessionKernel } from "./entity";

/** The last committed arm, including a retirement arm with `at: null`. */
export interface AlarmArmRow {
  readonly occurrenceId: string;
  readonly purpose: string;
  readonly at: number | null;
  readonly supersedes: string | null;
  readonly sourceKey: string;
  readonly payload: PlainObject;
  readonly ts: number;
  readonly actionId: string;
}

/** Rich alarm history consumed by app reads and by the bounded loop projection. */
export interface AlarmChainView {
  readonly alarmId: string;
  readonly latest: AlarmArmRow;
  readonly firstTs: number;
  readonly lastTs: number;
  readonly armCount: number;
  readonly delivered: number;
  readonly settled: ReadonlySet<string>;
  /** A firing of the latest occurrence closes loop wait evidence, even when stale. */
  readonly loopClosed: boolean;
}

interface MutableChain {
  alarmId: string;
  latest: AlarmArmRow;
  firstTs: number;
  lastTs: number;
  armCount: number;
  delivered: number;
  settled: Set<string>;
  loopClosed: boolean;
}

const alarmSchema = Journal.declarationFor("alarm")?.schema;

/** One canonical fold. The loop passes its turn's `(start, revision]` range. */
export function foldAlarmChains(
  kernel: Pick<SessionKernel, "historyPage">,
  sessionId: string,
  range: { readonly afterRevision?: number; readonly throughRevision?: number } = {},
): ReadonlyMap<string, AlarmChainView> {
  const chains = new Map<string, MutableChain>();
  const end = range.throughRevision;
  let after = range.afterRevision ?? 0;
  for (;;) {
    if (end !== undefined && after >= end) return chains;
    const page = kernel.historyPage(sessionId, { afterRevision: after, limit: 256 });
    for (const action of page.actions) {
      if (end !== undefined && action.ordinal > end) return chains;
      if (action.kind !== "alarm") continue;
      foldAlarmRow(chains, action);
    }
    if (page.nextRevision === null) return chains;
    after = page.nextRevision;
  }
}

function record(value: PlainValue): PlainObject | undefined {
  const parsed = PlainObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function foldAlarmRow(chains: Map<string, MutableChain>, action: LedgerAction.Node): void {
  if (!alarmSchema?.safeParse({ intent: action.intent, effect: action.effect }).success) return;
  const intent = record(action.intent.value);
  if (intent === undefined || typeof intent.alarmId !== "string") return;
  if (intent.op === "arm") {
    const effect = record(action.effect.value);
    const payload = PlainObjectSchema.safeParse(intent.payload);
    if (
      typeof intent.purpose !== "string" ||
      (typeof intent.at !== "number" && intent.at !== null) ||
      (typeof intent.supersedes !== "string" && intent.supersedes !== null) ||
      typeof intent.sourceKey !== "string" || !payload.success ||
      typeof effect?.occurrenceId !== "string"
    ) return;
    const latest: AlarmArmRow = {
      occurrenceId: effect.occurrenceId,
      purpose: intent.purpose,
      at: intent.at,
      supersedes: intent.supersedes,
      sourceKey: intent.sourceKey,
      payload: payload.data,
      ts: action.ts,
      actionId: action.id,
    };
    const chain = chains.get(intent.alarmId);
    if (chain === undefined) {
      chains.set(intent.alarmId, {
        alarmId: intent.alarmId, latest, firstTs: action.ts, lastTs: action.ts,
        armCount: 1, delivered: 0, settled: new Set(), loopClosed: false,
      });
    } else {
      chain.latest = latest;
      chain.lastTs = Math.max(chain.lastTs, action.ts);
      chain.armCount += 1;
      chain.loopClosed = false;
    }
    return;
  }
  if (intent.op !== "fired" || typeof intent.occurrenceId !== "string") return;
  const chain = chains.get(intent.alarmId);
  if (chain === undefined) return;
  chain.lastTs = Math.max(chain.lastTs, action.ts);
  if (intent.occurrenceId === chain.latest.occurrenceId) chain.loopClosed = true;
  if (intent.outcome === "stale") return;
  if (intent.outcome !== "delivered" && intent.outcome !== "exhausted") return;
  chain.settled.add(intent.occurrenceId);
  if (intent.outcome === "delivered") chain.delivered += 1;
}

/** The loop's existing open-set semantics over the current arm action IDs. */
export function openAlarmIds(chains: ReadonlyMap<string, AlarmChainView>): string[] {
  return [...chains.values()]
    .filter((chain) => chain.latest.at !== null && !chain.loopClosed && !isReservedAlarmPurpose(chain.latest.purpose))
    .map((chain) => chain.latest.actionId);
}
