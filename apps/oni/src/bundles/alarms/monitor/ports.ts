import { Core } from "@oni/agent";
const currentInvocation = Core.currentInvocation;
const executionPoint = Core.executionPoint;
const ToolRefused = Core.ToolRefused;
type LedgerError = Core.LedgerError;
import { Alarm, Cron, type PlainValue, type ToolExecutionContext } from "@oni/protocol";
import { z } from "zod";
type SessionKernel = Core.SessionReadModel;

/**
 * The monitor tool's Effect-free surface (boundary law R1): schemas, the
 * ports interface, and the pure pre-arm policy gates. The Effect-bearing
 * alarm plane (chain folds, arm commits, capability wiring) lives in
 * `src/bundles/alarms/index.ts`: a watch is one alarm chain and its
 * state is a fold of the chain's arm/fired rows (#1254).
 */
export const WatchState = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    kind: z.enum(["watch", "cron"]),
    status: z.enum(["armed", "cancelled", "fired", "exhausted"]),
    /** The latest arm's schedule; `null` is the retired chain. */
    fireAt: z.number().finite().nonnegative().nullable(),
    notifications: z.number().int().nonnegative(),
    /** The chain's current occurrence — the durable dedupe identity. */
    occurrenceId: z.string().min(1),
    createdAt: z.number().finite().nonnegative(),
    updatedAt: z.number().finite().nonnegative(),
  })
  .strict();
export type WatchState = z.infer<typeof WatchState>;

/** Create input: identity plus the sealed source; lifecycle fields are plane-owned. */
type WatchCreate =
  | {
      readonly sessionId: string;
      /** #1254 r2 H3: the calling turn's token — the live-arm authority check rides it. */
      readonly turnId: string;
      readonly id: string;
      readonly kind: "watch";
      readonly spec: Alarm.WatchSpec;
    }
  | {
      readonly sessionId: string;
      readonly turnId: string;
      readonly id: string;
      readonly kind: "cron";
      readonly expr: string;
      readonly tz: string;
      readonly description: string;
    };

export interface MonitorPorts {
  readonly create: (input: WatchCreate, signal: AbortSignal) => Promise<WatchState>;
  readonly cancel: (
    id: string,
    sessionId: string,
    turnId: string,
    at: number,
    signal: AbortSignal,
  ) => Promise<WatchState>;
  readonly rearm: (
    id: string,
    sessionId: string,
    turnId: string,
    at: number,
    signal: AbortSignal,
  ) => Promise<WatchState>;
  readonly clock: () => number;
  readonly entropy: () => string;
  /** Handle-scoped chain reads for the arming session (W5.2 F1). */
  readonly openKernel: (sessionId: string) => SessionKernel;
}

export class MonitorRefused extends ToolRefused {
  readonly _tag = "MonitorRefused";

  constructor(readonly failure: LedgerError | Error) {
    super("monitor", failure.message);
  }
}

/**
 * The shared pre-arm gate: the registered `tool.pre` point (#1251) in the
 * generation's composed table, never an independent policy.
 */
function evaluateGate(ports: MonitorPorts, context: ToolExecutionContext, value: PlainValue) {
  const kernel = ports.openKernel(context.sessionId);
  const { policy } = currentInvocation();
  if (executionPoint("tool", "pre", policy.pointTable) === undefined)
    throw new ToolRefused("monitor", "tool.pre point unregistered");
  return policy.evaluate({
    kind: "tool",
    phase: "pre",
    op: "monitor",
    role: kernel.row(context.sessionId).role,
    sessionId: context.sessionId,
    value,
  });
}

export async function armWatch(
  ports: MonitorPorts,
  source: Omit<Alarm.Watch, "description">,
  description: string,
  context: ToolExecutionContext,
) {
  const watch = Alarm.Watch.parse({ ...source, description });
  const kernel = ports.openKernel(context.sessionId);
  const turn = Core.turnIntent(kernel.actionById(context.turnId));
  if (turn === undefined) throw new ToolRefused("monitor", "no captured turn");
  const evaluation = evaluateGate(ports, context, watch);
  const limits = evaluation.obligations.filter(
    (obligation) => obligation.metric === "notifications",
  );
  if (evaluation.verdict === "deny" || evaluation.error !== undefined || limits.length === 0)
    throw new ToolRefused("monitor", "captured wake budget unavailable");
  return ports.create(
    {
      sessionId: context.sessionId,
      turnId: context.turnId,
      id: ports.entropy(),
      kind: "watch",
      spec: {
        watch,
        policyGeneration: turn.policyGeneration,
        notificationLimit: Math.min(...limits.map((limit) => limit.limit)),
      },
    },
    context.signal,
  );
}

export async function armCron(
  ports: MonitorPorts,
  source: { readonly expr: string; readonly tz: string },
  description: string,
  context: ToolExecutionContext,
) {
  try {
    Cron.next(source.expr, ports.clock(), source.tz);
  } catch (error) {
    throw new ToolRefused(
      "monitor",
      `invalid cron expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const evaluation = evaluateGate(ports, context, { ...source, description });
  if (evaluation.verdict === "deny" || evaluation.error !== undefined)
    throw new ToolRefused("monitor", "cron arm denied");
  return ports.create(
    {
      sessionId: context.sessionId,
      turnId: context.turnId,
      id: ports.entropy(),
      kind: "cron",
      expr: source.expr,
      tz: source.tz,
      description,
    },
    context.signal,
  );
}
