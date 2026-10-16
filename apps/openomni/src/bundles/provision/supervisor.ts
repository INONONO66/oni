import type { ChannelDeliveryRoute, ProviderTypingRoute } from "@openomni/channels";
import { ThrownError } from "../../thrown";
import { Actor } from "@openomni/protocol";
import type { BuiltChannel, ChannelComponent, DeclaredChannelStatus } from "../../channels";

/**
 * One runtime owner for external-channel lifecycle
 * (docs/provisioning-and-providers.md §5): boot reconcile and tool-driven
 * mutation are the same `reconcile()` call — declarations change, affected
 * stages bounce (stop → swap → start, §8.7), untouched stages keep running.
 * A stage that keeps failing to start trips a per-instance circuit breaker
 * into `paused_by_breaker`; only a manual `resume` (channel_enable) re-arms
 * it (§5). The supervisor mounts fail-closed: a row whose start throws is
 * fully unwound — grant, route, and webhook — never left half-wired.
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
  /**
   * The tier this row's trusted-channel grant materializes (#931): the
   * declaration's `grant.defaultTier` when the Owner named one, otherwise the
   * mount tier. Mounting never synthesizes authority on its own.
   */
  readonly defaultTier: Actor.TrustTier;
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
  | "paused_by_breaker";

export interface ChannelRuntimeStatus {
  readonly id: string;
  readonly surface: string;
  readonly state: ChannelRuntimeState;
  readonly detail?: string;
}

export interface SupervisorDeps {
  readonly desired: () => DesiredChannels;
  readonly build: (component: ChannelComponent) => BuiltChannel;
  /**
   * Registers the platform's trusted grant at a tier, naming whether an
   * Owner instance reads under it (#1569 lane 6); returns its revoker.
   */
  readonly grant: (surfaceId: string, defaultTier: Actor.TrustTier, ownerIntake?: boolean) => () => void;
  readonly deliveryRoutes: Map<string, ChannelDeliveryRoute>;
  readonly typingRoutes: Map<string, ProviderTypingRoute>;
  readonly webhookHandlers: Map<string, (request: Request) => Promise<Response>>;
  /** #1569 lane 7: the `<platform>:owner` surfaces whose declaration lets the reply door answer through the account. */
  readonly autoReplies?: Set<string>;
  readonly traceId: () => string;
  /** Consecutive start failures before the breaker pauses the instance. */
  readonly breakerThreshold?: number;
}

interface MountedRow {
  readonly key: string;
  readonly surfaceId: string;
  readonly stop: () => Promise<void>;
}

/** The one grant row of a platform and the reading instances holding it. */
interface PlatformGrant {
  readonly readers: Map<string, { readonly tier: Actor.TrustTier; readonly owner: boolean }>;
  /** `<tier>:<ownerIntake>` the row is registered at; re-registered when it changes. */
  registered: string | undefined;
  revoke: () => void;
}

/** The tier enum runs from the most trusted down; a larger rank is a lesser tier. */
function tierRank(tier: Actor.TrustTier): number {
  return Actor.TrustTier.options.indexOf(tier);
}

export interface ChannelSupervisor {
  /** THE reconcile path: diff declarations against running stages and bounce only the changed. */
  reconcile(): Promise<ChannelRuntimeStatus[]>;
  /** Re-arms a breaker-paused instance; the next reconcile tries it again. */
  resume(instanceId: string): boolean;
  /** Last reconcile's verdict per instance plus what is mounted right now. */
  status(): ChannelRuntimeStatus[];
  /** Channel truth comes only from declared instances. */
  source(): "declared";
  /** Reverse-order teardown of every running stage (composer disposer). */
  stopAll(): Promise<void>;
}

const DEFAULT_BREAKER_THRESHOLD = 3;

export function createChannelSupervisor(deps: SupervisorDeps): ChannelSupervisor {
  const threshold = deps.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD;
  const mounted = new Map<string, MountedRow>();
  const failures = new Map<string, number>();
  // The platform's ingress grant is one row (#1569 lane 6): the bot and the
  // Owner instance of one platform both read under it. The row is held while
  // any reading instance is mounted and revoked with the last; it is
  // re-registered whenever the readers change, at the least tier any current
  // reader declares (fail-closed, the grant store's own order) and naming
  // whether an Owner instance is among them.
  const grants = new Map<string, PlatformGrant>();
  const holdGrant = (platform: string, row: DesiredChannelRow): (() => void) => {
    const held = grants.get(platform) ?? { readers: new Map(), registered: undefined, revoke: () => undefined };
    held.readers.set(row.instanceId, { tier: row.defaultTier, owner: row.component.identity === "owner" });
    grants.set(platform, held);
    settleGrant(platform, held);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.readers.delete(row.instanceId);
      if (held.readers.size > 0) {
        settleGrant(platform, held);
        return;
      }
      grants.delete(platform);
      held.revoke();
    };
  };
  function settleGrant(platform: string, held: PlatformGrant): void {
    const readers = [...held.readers.values()];
    // Fail closed: the least trusted tier any reader declares is the platform's.
    const tier = readers.map((reader) => reader.tier).sort((a, b) => tierRank(b) - tierRank(a))[0];
    if (tier === undefined) return;
    const ownerIntake = readers.some((reader) => reader.owner);
    const wanted = `${tier}:${ownerIntake}`;
    if (held.registered === wanted) return;
    held.revoke();
    held.registered = wanted;
    held.revoke = deps.grant(platform, tier, ownerIntake);
  }
  let lastStatuses: ChannelRuntimeStatus[] = [];
  let lastSource: DesiredChannels["source"] = "declared";

  async function mountRow(row: DesiredChannelRow): Promise<void> {
    const built = deps.build(row.component);
    // Routes key by the instance surface id (`<platform>:<identity>`, #1569);
    // the ingress grant and the webhook path key by the platform the inbound
    // facts name, and only a bot instance reads inbound (lane 6 mounts the
    // Owner listener under its own posture).
    const surfaceId = built.surface.id;
    const platform = row.component.id;
    const revokeGrant = row.component.listens ? holdGrant(platform, row) : () => undefined;
    if (built.deliveryRoute !== undefined) {
      deps.deliveryRoutes.set(surfaceId, built.deliveryRoute);
    }
    if (built.typingRoute !== undefined) {
      deps.typingRoutes.set(surfaceId, built.typingRoute);
    }
    if (built.webhookHandler !== undefined) {
      deps.webhookHandlers.set(platform, built.webhookHandler);
    }
    if (built.autoReply === true) deps.autoReplies?.add(surfaceId);
    const unwind = async (stopSurface: boolean) => {
      if (stopSurface) await built.surface.stop(deps.traceId());
      if (built.webhookHandler !== undefined) deps.webhookHandlers.delete(platform);
      deps.autoReplies?.delete(surfaceId);
      deps.deliveryRoutes.delete(surfaceId);
      deps.typingRoutes.delete(surfaceId);
      revokeGrant();
    };
    const failure = await built.surface.start(deps.traceId()).then(() => undefined, ThrownError.parse);
    if (failure !== undefined) {
      // Fail-closed: a stage that did not start owns nothing.
      await unwind(false);
      throw failure;
    }
    mounted.set(row.instanceId, {
      key: row.key,
      surfaceId,
      stop: () => unwind(true),
    });
  }

  async function startRow(row: DesiredChannelRow, statuses: ChannelRuntimeStatus[]): Promise<void> {
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
    const failure = await mountRow(row).then(() => undefined, ThrownError.parse);
    if (failure === undefined) {
      failures.delete(row.instanceId);
      // A mounted stage reports the surface it mounted under (`<platform>:<identity>`, #1569), first time and after.
      statuses.push({
        id: row.instanceId,
        surface: mounted.get(row.instanceId)?.surfaceId ?? row.component.id,
        state: "mounted",
      });
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

  async function reconcile(): Promise<ChannelRuntimeStatus[]> {
    const desired = deps.desired();
    lastSource = desired.source;
    const want = new Map(desired.rows.map((row) => [row.instanceId, row]));

    // Phase 1 — stop: removed or changed stages release everything they own
    // BEFORE their replacement starts (§8.7 stop → swap → start).
    for (const [instanceId, row] of [...mounted]) {
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
      const running = mounted.get(row.instanceId);
      if (running !== undefined) {
        statuses.push({ id: row.instanceId, surface: running.surfaceId, state: "mounted" });
        continue;
      }
      await startRow(row, statuses);
    }
    lastStatuses = statuses;
    return statuses;
  }

  return {
    reconcile,
    resume(instanceId: string): boolean {
      return failures.delete(instanceId);
    },
    status(): ChannelRuntimeStatus[] {
      return [...lastStatuses];
    },
    source(): "declared" {
      return lastSource;
    },
    stopAll: async (): Promise<void> => {
      for (const [instanceId, row] of [...mounted].reverse()) {
        await row.stop();
        mounted.delete(instanceId);
      }
      lastStatuses = [];
    },
  };
}
