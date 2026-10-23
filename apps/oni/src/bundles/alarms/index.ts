import { type Bundle, Core } from "@oni/agent";
import { Alarm, Cron, Journal, type PlainObject, PlainObjectSchema } from "@oni/protocol";
import { Effect } from "effect";
import { MonitorRefused, type MonitorPorts, type WatchState } from "./monitor/ports";
import { CRON_SOURCE, CRON_TICK, CronPayload } from "./cron/index";
import type { SessionReadModel } from "../../composition/cluster-runtime";

/**
 * The app's alarm plane (#1254): every lifecycle fact is one `alarm{arm}` /
 * `alarm{fired}` chain row from the core writers, folded on read — no epochs,
 * no process memory. The app never commits an arm row itself (H3): the live
 * registry below hands `Bundle.alarmCapability` each activation's budgeted
 * entity arm verb — the ONE committing arm path — and refuses `not_live`
 * when no activation is registered.
 */

/** The app consumes the core's single rich alarm-chain projection. */
export type AlarmChainView = Core.AlarmChainView;
export const foldAlarmChains = Core.foldAlarmChains;

/** `Core.AlarmChainReads` over the fold: what the chain guard consults at delivery. */
export function alarmChainReads(kernel: SessionReadModel, sessionId: string): Core.AlarmChainReads {
  const chains = foldAlarmChains(kernel, sessionId);
  const settled = new Set<string>();
  for (const chain of chains.values()) for (const id of chain.settled) settled.add(id);
  return {
    latestArm: (alarmId) => {
      const chain = chains.get(alarmId);
      return chain === undefined
        ? undefined
        : { occurrenceId: chain.latest.occurrenceId, at: chain.latest.at };
    },
    settled: (occurrenceId) => settled.has(occurrenceId),
  };
}

/**
 * #1254 H3: the live-activation arm registry — the app side of the entity's
 * ONE committing arm path. Each activation registers its budgeted arm verb
 * through `SessionEntityPorts.onLive` (after fence adoption, released at
 * passivation); the capability's app-side verbs delegate through `arm`. A
 * session with no live activation refuses `not_live` — the app never commits
 * an arm row of its own.
 */
/** One activation's registered verbs: the committing arm plus its turn-token check. */
interface LiveActivationArm {
  readonly arm: Core.ArmVerb;
  /** #1254 r2 H3: true iff the live activation owns the caller's turn token. */
  readonly ownsTurn: (turnId: string) => boolean;
}

export interface LiveArmRegistry {
  /** Bound as `SessionEntityPorts.onLive`; returns the passivation release. */
  readonly onLive: (sessionId: string, verbs: LiveActivationArm) => () => void;
  /**
   * The arm verb `Bundle.alarmCapability` composes: bound at creation to the
   * activation that is live when the verb is minted (#1254 r3 H1). A turn
   * token alone cannot distinguish recovery — a successor activation keeps
   * the recovered `open.turnId` — so execution refuses `stale_activation`
   * when the authorizing activation is no longer the live one; a continuation
   * is NEVER re-resolved to a successor. A session with no live activation
   * refuses `not_live`; the live activation additionally refuses `stale_turn`
   * for a turn token it does not own (#1254 r2 H3).
   */
  readonly arm: (sessionId: string, turnId: string) => Bundle.ArmVerb;
}

export function createLiveArmRegistry(): LiveArmRegistry {
  const live = new Map<string, LiveActivationArm>();
  return {
    onLive: (sessionId, verbs) => {
      live.set(sessionId, verbs);
      return () => {
        if (live.get(sessionId) === verbs) live.delete(sessionId);
      };
    },
    arm: (sessionId, turnId) => {
      // #1254 r3 H1: capture the authorizing activation when the tool-facing
      // verb is created; execution never re-resolves to a successor.
      const authorized = live.get(sessionId);
      return (input) =>
        Effect.suspend(() => {
          const entry = live.get(sessionId);
          if (entry === undefined) return Effect.fail(new Core.ArmRefused({ code: "not_live" }));
          if (entry !== authorized)
            return Effect.fail(new Core.ArmRefused({ code: "stale_activation" }));
          if (!entry.ownsTurn(turnId))
            return Effect.fail(new Core.ArmRefused({ code: "stale_turn" }));
          return entry.arm(input);
        });
    },
  };
}

const RETIRED_STATUS: Record<string, WatchState["status"]> = {
  cancel: "cancelled",
  install: "cancelled",
  /** #1254 r2 H2: create-compensation retire after a refused companion arm. */
  create: "cancelled",
  exhausted: "exhausted",
  fired: "fired",
  timeout: "fired",
};

export function watchStateOf(chain: AlarmChainView, sessionId: string): WatchState {
  const retiredReason =
    typeof chain.latest.payload.reason === "string" ? chain.latest.payload.reason : undefined;
  const notifications =
    typeof chain.latest.payload.notifications === "number"
      ? chain.latest.payload.notifications
      : chain.delivered;
  return {
    id: chain.alarmId,
    sessionId,
    kind: chain.latest.sourceKey === CRON_SOURCE ? "cron" : "watch",
    status:
      chain.latest.at !== null
        ? "armed"
        : (RETIRED_STATUS[retiredReason ?? "fired"] ?? "fired"),
    fireAt: chain.latest.at,
    notifications,
    occurrenceId: chain.latest.occurrenceId,
    createdAt: chain.firstTs,
    updatedAt: chain.lastTs,
  };
}

interface AlarmMonitorDeps {
  readonly capability: Bundle.AlarmCapabilityDefinition;
  readonly readSession: (sessionId: string) => SessionReadModel;
  readonly clock: () => number;
  readonly entropy: () => string;
  readonly run: <A>(effect: Effect.Effect<A, Error>, signal: AbortSignal) => Promise<A>;
}

function requireChain(deps: AlarmMonitorDeps, sessionId: string, id: string): AlarmChainView {
  const chain = foldAlarmChains(deps.readSession(sessionId), sessionId).get(id);
  if (chain === undefined) throw new MonitorRefused(new Error(`unknown watch: ${id}`));
  return chain;
}

/** The last committed arm payload that still carries the chain's spec (watch) or cron fields. */
function chainSpec(deps: AlarmMonitorDeps, sessionId: string, id: string) {
  const kernel = deps.readSession(sessionId);
  let found: PlainObject | undefined;
  let after = 0;
  for (;;) {
    const page = kernel.historyPage(sessionId, { afterRevision: after });
    for (const action of page.actions) {
      if (action.kind !== "alarm") continue;
      if (!Journal.declarationFor("alarm")?.schema.safeParse({ intent: action.intent, effect: action.effect }).success) continue;
      const intent = action.intent.value;
      if (intent === null || typeof intent !== "object" || Array.isArray(intent) || intent.op !== "arm" || intent.alarmId !== id) continue;
      const payload = PlainObjectSchema.safeParse(intent.payload);
      if (payload.success && (payload.data.spec !== undefined || payload.data.expr !== undefined))
        found = payload.data;
    }
    if (page.nextRevision === null) return found;
    after = page.nextRevision;
  }
}

export function createAlarmMonitorPorts(deps: AlarmMonitorDeps): MonitorPorts {
  const state = (sessionId: string, id: string) =>
    watchStateOf(requireChain(deps, sessionId, id), sessionId);
  const retire = (
    // #1254 r5 H1: the caller's ONE arm verb, minted before its first await —
    // retire never re-resolves authority from the registry after suspension.
    arm: Bundle.ArmVerb,
    chain: AlarmChainView,
    reason: "cancel",
    signal: AbortSignal,
  ) =>
    deps.run(
      arm({
          purpose: chain.latest.purpose,
          at: null,
          alarmId: chain.alarmId,
          supersedes: chain.latest.occurrenceId,
          sourceKey: chain.latest.sourceKey,
          payload: { reason },
        })
        .pipe(Effect.asVoid, Effect.mapError((error) => new Error(error.code))),
      signal,
    );
  return {
    clock: deps.clock,
    entropy: deps.entropy,
    readSession: deps.readSession,
    async create(input, signal) {
      if (input.kind === "cron") {
        const { expr, tz } = input;
        const at = Cron.next(expr, deps.clock(), tz);
        await deps.run(
          deps
            .capability.verbs.arm(input.sessionId, input.turnId)({
              purpose: CRON_TICK,
              at,
              alarmId: input.id,
              sourceKey: CRON_SOURCE,
              payload: { expr, tz, description: input.description },
            })
            .pipe(Effect.asVoid, Effect.mapError((error) => new Error(error.code))),
          signal,
        );
        return state(input.sessionId, input.id);
      }
      await deps.run(
        deps.capability.verbs
          .watch({
            sessionId: input.sessionId,
            turnId: input.turnId,
            watchId: input.id,
            spec: input.spec,
            now: deps.clock(),
          })
          .pipe(Effect.asVoid, Effect.mapError((error) => new Error(error.message))),
        signal,
      );
      return state(input.sessionId, input.id);
    },
    async cancel(id, sessionId, turnId, _at, signal) {
      // #1254 r5 H1: mint ONE arm verb at invocation, before any await. The
      // registry binds authority at mint time; a registry replacement between
      // the two retires (recovery keeps the durable turn id) must refuse
      // stale_activation, never mutate through the successor.
      const arm = deps.capability.verbs.arm(sessionId, turnId);
      const chain = requireChain(deps, sessionId, id);
      if (chain.latest.at !== null) await retire(arm, chain, "cancel", signal);
      const chains = foldAlarmChains(deps.readSession(sessionId), sessionId);
      const timeout = chains.get(`${id}:timeout`);
      if (timeout !== undefined && timeout.latest.at !== null)
        await retire(arm, timeout, "cancel", signal);
      return state(sessionId, id);
    },
    async rearm(id, sessionId, turnId, at, signal) {
      const chain = requireChain(deps, sessionId, id);
      if (chain.latest.at !== null) return watchStateOf(chain, sessionId);
      const payload = chainSpec(deps, sessionId, id);
      if (chain.latest.sourceKey === CRON_SOURCE) {
        const cron = CronPayload.safeParse(payload);
        if (!cron.success)
          throw new MonitorRefused(new Error(`cron chain without an expression: ${id}`));
        await deps.run(
          deps
            .capability.verbs.arm(sessionId, turnId)({
              purpose: CRON_TICK,
              at: Cron.next(cron.data.expr, at, cron.data.tz),
              alarmId: id,
              supersedes: chain.latest.occurrenceId,
              sourceKey: CRON_SOURCE,
              payload: cron.data,
            })
            .pipe(Effect.asVoid, Effect.mapError((error) => new Error(error.code))),
          signal,
        );
        return state(sessionId, id);
      }
      const spec = Alarm.WatchSpec.safeParse(payload?.spec);
      if (!spec.success)
        throw new MonitorRefused(new Error(`watch chain without a spec: ${id}`));
      await deps.run(
        deps.capability.verbs
          .watch({ sessionId, turnId, watchId: id, spec: spec.data, now: at })
          .pipe(Effect.asVoid, Effect.mapError((error) => new Error(error.message))),
        signal,
      );
      return state(sessionId, id);
    },
  };
}
