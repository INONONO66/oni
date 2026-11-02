import type { AccountIdentity, ChannelDeliveryRoute, OwnerWithdrawal, ProviderHistoryRoute, ProviderTypingRoute, ProviderVoiceRoute } from "@oni/channels";
import { ThrownError } from "../../thrown";
import type { BuiltChannel, ChannelComponent, DeclaredChannelStatus } from "../../channels";

/**
 * One runtime owner for external-channel lifecycle
 * (docs/provisioning-and-providers.md §5): boot reconcile and tool-driven
 * mutation are the same `reconcile()` call — declarations change, affected
 * stages bounce (stop → swap → start, §8.7), untouched stages keep running.
 * A stage that keeps failing to start trips a per-instance circuit breaker
 * into `paused_by_breaker`; only a manual `resume` (channel_enable) re-arms
 * it (§5). The supervisor mounts fail-closed: a row whose start throws is
 * fully unwound — route and webhook — never left half-wired.
 */

// Promise band (#1423): the channels driver `surface.start` Promise contract forces this file
// onto Promises; `.then(() => undefined, ThrownError.parse)` narrows rejections to a typed Error.
// Effect takes over in the driver runner; no durable write or alarm-chain decision belongs here.

/** One row the current declarations say should be running. */
export interface DesiredChannelRow {
  readonly instanceId: string;
  /** Bounce key: revision + rotation epoch — any difference restarts the stage. */
  readonly key: string;
  readonly component: ChannelComponent;
}

export interface DesiredChannels {
  readonly source: "declared";
  readonly rows: readonly DesiredChannelRow[];
  /** Declarations that could not produce a row, verbatim from the profile. */
  readonly statuses: readonly DeclaredChannelStatus[];
}

type ChannelRuntimeState =
  | DeclaredChannelStatus["state"]
  | "mounted"
  | "start_failed"
  | "paused_by_breaker"
  | "withdrawn";

export interface ChannelRuntimeStatus {
  readonly id: string;
  readonly surface: string;
  readonly state: ChannelRuntimeState;
  readonly detail?: string;
}

export interface SupervisorDeps {
  readonly desired: () => DesiredChannels;
  readonly build: (component: ChannelComponent) => BuiltChannel;
  /** #1600: an Owner instance named its account; the app binds it to the Owner Person. */
  readonly bindAccount?: (platform: string, account: AccountIdentity) => void;
  readonly deliveryRoutes: Map<string, ChannelDeliveryRoute>;
  readonly typingRoutes: Map<string, ProviderTypingRoute>;
  readonly voiceRoutes?: Map<string, ProviderVoiceRoute>;
  readonly historyRoutes?: Map<string, ProviderHistoryRoute>;
  readonly webhookHandlers: Map<string, (request: Request) => Promise<Response>>;
  /** Owner instance ids whose declaration lets the reply door answer through the account. */
  readonly autoReplies?: Set<string>;
  readonly traceId: () => string;
  /** Consecutive start failures before the breaker pauses the instance. */
  readonly breakerThreshold?: number;
}

interface MountedRow {
  readonly key: string;
  readonly surfaceId: string;
  readonly stop: () => Promise<void>;
  /** The latched cause a started account runtime withdrew readiness for. */
  readonly withdrawn: () => OwnerWithdrawal | undefined;
}

function mountedStatus(instanceId: string, row: MountedRow): ChannelRuntimeStatus {
  const withdrawn = row.withdrawn();
  return withdrawn === undefined
    ? { id: instanceId, surface: row.surfaceId, state: "mounted" }
    : { id: instanceId, surface: row.surfaceId, state: "withdrawn", detail: withdrawn };
}

function registerRoute<T>(
  routes: Map<string, T> | undefined,
  surface: string,
  route: T | undefined,
): () => void {
  if (route !== undefined) routes?.set(surface, route);
  return () => {
    if (route !== undefined && routes?.get(surface) === route) routes.delete(surface);
  };
}

class ChannelSurfaceBusy extends Error {
  readonly code = "session_in_use";
  constructor() {
    super("session_in_use");
  }
}

export interface ChannelSupervisor {
  /** THE reconcile path: diff declarations against running stages and bounce only the changed. */
  reconcile(): Promise<ChannelRuntimeStatus[]>;
  /** Re-arms a breaker-paused instance; the next reconcile tries it again. */
  resume(instanceId: string): boolean;
  /** Last reconcile's verdict per instance plus what is mounted right now. */
  status(): ChannelRuntimeStatus[];
  /** The latched withdrawal of the mounted surface, if its runtime withdrew readiness. */
  withdrawal(surfaceId: string): OwnerWithdrawal | undefined;
  /** Channel truth comes only from declared instances. */
  source(): "declared";
  /** Reverse-order teardown of every running stage (composer disposer). */
  stopAll(): Promise<void>;
}

const DEFAULT_BREAKER_THRESHOLD = 3;

export function createChannelSupervisor(deps: SupervisorDeps): ChannelSupervisor {
  const threshold = deps.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD;
  const mounted = new Map<string, MountedRow>();
  const surfaces = new Set<string>();
  const pending = new Map<string, () => Promise<void>>();
  let generation = 0;
  let reconciles: Promise<void> = Promise.resolve();
  let stopping: Promise<void> | undefined;
  const failures = new Map<string, number>();
  let lastStatuses: ChannelRuntimeStatus[] = [];
  let lastSource: DesiredChannels["source"] = "declared";
  // R09: a withdrawal revokes the ready-only history registration and is reported, never left mounted.
  function holdHistory(instanceId: string, surfaceId: string, built: BuiltChannel) {
    let revoke: (() => void) | undefined;
    let withdrawal: OwnerWithdrawal | undefined;
    let live = true;
    built.onWithdrawn?.((reason) => {
      if (!live || withdrawal !== undefined) return;
      withdrawal = reason;
      revoke?.();
      revoke = undefined;
      lastStatuses = lastStatuses.map((status) => status.id === instanceId && status.state === "mounted"
        ? { ...status, state: "withdrawn", detail: reason } : status);
    });
    return {
      register: () => {
        if (withdrawal === undefined) revoke = registerRoute(deps.historyRoutes, surfaceId, built.historyRoute);
      },
      close: () => {
        live = false;
        revoke?.();
      },
      withdrawn: () => withdrawal,
    };
  }

  async function mountRow(row: DesiredChannelRow, epoch: number): Promise<void> {
    const built = deps.build(row.component);
    // Routes key by the channel_instance row id.
    const surfaceId = built.surface.id;
    if (surfaces.has(surfaceId)) throw new ChannelSurfaceBusy();
    surfaces.add(surfaceId);
    const platform = row.component.id;
    // #1600 lane R3: a webhook declaration's handler is keyed by the instance, never shared with the platform's others.
    const webhookKey = row.component.webhookKey ?? platform;
    const history = holdHistory(row.instanceId, surfaceId, built);
    const revokers: (() => void)[] = [];
    let closing: Promise<void> | undefined;
    const stop = () => closing ??= Promise.resolve().then(() => built.surface.stop(deps.traceId()));
    const unwind = async (stopSurface: boolean) => {
      history.close();
      for (const revoke of revokers) revoke();
      if (stopSurface) await stop();
      surfaces.delete(surfaceId);
    };
    pending.set(row.instanceId, stop);
    try {
      const failure = await built.surface.start(deps.traceId()).then(() => undefined, ThrownError.parse);
      if (epoch !== generation) {
        await unwind(true);
        return;
      }
      if (failure !== undefined) {
        // The provider owns cleanup of its partial failed start.
        await unwind(false);
        throw failure;
      }
      const bound = await Promise.resolve().then(() => {
        if (epoch !== generation) return;
        const account = row.component.identity === "owner" ? built.account?.() : undefined;
        if (account !== undefined) deps.bindAccount?.(platform, account);
      }).then(() => undefined, ThrownError.parse);
      if (bound !== undefined || epoch !== generation) {
        await unwind(true);
        if (bound !== undefined) throw bound;
        return;
      }
      revokers.push(
        registerRoute(deps.deliveryRoutes, surfaceId, built.deliveryRoute === undefined ? undefined : {
          platform, identity: row.component.identity, deliver: built.deliveryRoute,
        }),
        registerRoute(deps.typingRoutes, surfaceId, built.typingRoute),
        registerRoute(deps.voiceRoutes, surfaceId, built.voiceRoute),
        registerRoute(deps.webhookHandlers, webhookKey, built.webhookHandler),
      );
      if (built.autoReply === true) {
        deps.autoReplies?.add(surfaceId);
        revokers.push(() => { deps.autoReplies?.delete(surfaceId); });
      }
      history.register();
      mounted.set(row.instanceId, {
        key: row.key, surfaceId, stop: () => unwind(true), withdrawn: history.withdrawn,
      });
    } finally {
      pending.delete(row.instanceId);
    }
  }

  async function startRow(row: DesiredChannelRow, statuses: ChannelRuntimeStatus[], epoch: number): Promise<void> {
    const failed = failures.get(row.instanceId) ?? 0;
    if (failed >= threshold) {
      statuses.push({
        id: row.instanceId,
        surface: row.component.id,
        state: "paused_by_breaker",
        detail: `${failed} consecutive start failures; channel_enable re-arms it`,
      });
      return;
    }
    const failure = await mountRow(row, epoch).then(() => undefined, ThrownError.parse);
    if (epoch !== generation) return;
    if (failure === undefined) {
      failures.delete(row.instanceId);
      // A mounted stage reports its instance surface id, first time and after.
      const running = mounted.get(row.instanceId);
      statuses.push(running === undefined
        ? { id: row.instanceId, surface: row.component.id, state: "mounted" }
        : mountedStatus(row.instanceId, running));
      return;
    }
    const count = failed + 1;
    failures.set(row.instanceId, count);
    statuses.push({
      id: row.instanceId,
      surface: row.component.id,
      state: count >= threshold ? "paused_by_breaker" : "start_failed",
      detail: failure.message,
    });
  }

  async function reconcileRows(epoch: number): Promise<ChannelRuntimeStatus[]> {
    if (epoch !== generation) return [];
    const desired = deps.desired();
    lastSource = desired.source;
    const want = new Map(desired.rows.map((row) => [row.instanceId, row]));

    // Phase 1 — stop: removed or changed stages release everything they own
    // BEFORE their replacement starts (§8.7 stop → swap → start).
    for (const [instanceId, row] of [...mounted]) {
      if (epoch !== generation) return [];
      const target = want.get(instanceId);
      if (target === undefined || target.key !== row.key) {
        await row.stop();
        mounted.delete(instanceId);
      }
    }

    // Phase 2 — start: new or bounced stages, each behind its breaker.
    const statuses: ChannelRuntimeStatus[] = desired.statuses.map((status) => ({
      id: status.id,
      surface: status.provider,
      state: status.state,
      ...(status.detail === undefined ? {} : { detail: status.detail }),
    }));
    for (const row of desired.rows) {
      if (epoch !== generation) return [];
      const running = mounted.get(row.instanceId);
      if (running !== undefined) {
        statuses.push(mountedStatus(row.instanceId, running));
        continue;
      }
      await startRow(row, statuses, epoch);
    }
    if (epoch !== generation) return [];
    lastStatuses = statuses;
    return statuses;
  }

  return {
    reconcile: () => {
      if (stopping !== undefined) return stopping.then(() => []);
      const epoch = generation;
      const result = reconciles.then(() => reconcileRows(epoch));
      reconciles = result.then(() => undefined, () => undefined);
      return result;
    },
    resume(instanceId: string): boolean {
      return failures.delete(instanceId);
    },
    status(): ChannelRuntimeStatus[] {
      return [...lastStatuses];
    },
    withdrawal(surfaceId: string): OwnerWithdrawal | undefined {
      return [...mounted.values()].find((row) => row.surfaceId === surfaceId)?.withdrawn();
    },
    source(): "declared" {
      return lastSource;
    },
    stopAll: (): Promise<void> => {
      if (stopping !== undefined) return stopping;
      generation++;
      stopping = (async () => {
        await Promise.all([...pending.values()].map((stop) => stop()));
        await reconciles;
        for (const [instanceId, row] of [...mounted].reverse()) {
          await row.stop();
          mounted.delete(instanceId);
        }
        lastStatuses = [];
      })().finally(() => { stopping = undefined; });
      return stopping;
    },
  };
}
