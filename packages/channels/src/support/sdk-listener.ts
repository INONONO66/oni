import { Operational } from "@oni/protocol";
import { ChannelsFailure } from "../errors";
import { newTraceId } from "./trace";
import type { PublishPort } from "../types";

/**
 * Consecutive failures (closes and refused reopens) without a reconnect
 * before custody reports a surface unreachable: one Operational Error per
 * streak — driver trouble must reach the Owner, never stay an unbounded
 * silent retry loop. The SDK's own bounded backoff keeps running underneath;
 * custody never stops a listener that may still recover, because nothing
 * remounts a stopped surface. A poller whose every failed cycle is a close
 * and whose SDK never re-emits `connected` alarms once per process.
 */
export const RECONNECT_ATTEMPT_BOUND = 10;

/**
 * The three lifecycle events every agent-messenger listener emits. A
 * platform's own event map extends this shape structurally, so one custody
 * wrapper serves Slack, Discord and Telegram.
 */
export interface SdkListenerEventMap {
  connected: readonly object[];
  disconnected: [];
  error: [error: Error];
}

type Lifecycle = keyof SdkListenerEventMap;

/** The lifecycle slice of an SDK listener; a platform's full event map stays with its surface. */
export interface SdkListener<Map extends SdkListenerEventMap> {
  on<K extends Lifecycle>(event: K, listener: (...args: Map[K]) => void): void;
  start(): Promise<void>;
  stop(): void;
}

export interface ListenerCustodyOptions<Map extends SdkListenerEventMap> {
  /** Names the surface in observations (`slack socket`, `discord gateway`). */
  readonly label: string;
  readonly publish: PublishPort;
  readonly now: () => number;
  readonly id: () => string;
  /** Runs on every `connected` (first hello/READY and every resume) with the SDK's info. */
  readonly onConnected?: (...info: Map["connected"]) => void;
  /**
   * Consecutive failures (closes and reopen errors) without a reconnect
   * before the surface is reported unreachable. The SDK keeps its own bounded
   * backoff running; the report is loud, once per streak.
   */
  readonly failureBound?: number;
  /**
   * Whether a close before the first `connected` fails this start. True for
   * an SDK whose `start()` resolves before hello and never rejects (Slack);
   * false for one whose `start()` itself stays pending across a recoverable
   * pre-ready close and rejects on its own timeout (Discord).
   */
  readonly failOnCloseBeforeConnected?: boolean;
  /**
   * Errors after which the SDK listener has stopped itself for good (a
   * revoked token, a terminal disconnect, a non-recoverable close code). The
   * SDK emits only `error` for these and never `disconnected`, so without this
   * predicate the surface would look alive while receiving nothing.
   */
  readonly terminal?: (error: Error) => boolean;
  /**
   * An error before the first `connected` the SDK recovers from on its own
   * by opening another transport (Instagram's hybrid listener emits its
   * realtime failure, then starts polling, whose `connected` settles this
   * start). Observed as a Warn; start keeps waiting. Without the predicate
   * every error before `connected` fails the start.
   */
  readonly recoverableBeforeConnected?: (error: Error) => boolean;
}

export interface ListenerCustody {
  /** Starts the listener; settles on the first `connected`, rejects on an error (or close) before it. */
  start(): Promise<void>;
  stop(): void;
  /** True once the listener is stopped: by a terminal error or by `stop()`. */
  readonly dead: boolean;
}

export function stopBotListener(
  custody: ListenerCustody | null,
  observation: {
    readonly publish: PublishPort;
    readonly traceId: string;
    readonly now: () => number;
    readonly message: string;
  },
): void {
  custody?.stop();
  observation.publish(Operational.Events.Info, {
    traceId: observation.traceId,
    time: observation.now(),
    component: "server",
    msg: observation.message,
  });
}

/**
 * Custody over an SDK listener (#1569): the SDK owns the socket, the pings
 * and its own reconnect loop; this wrapper owns what the kernel must see.
 * `error` is subscribed before `start()` (an unhandled EventEmitter error is
 * process-fatal); start settles only on the first `connected`, an error (or,
 * where the SDK would not notice, a close) before it fails that start and
 * stops the listener, unless the SDK recovers from that error by another
 * transport (`recoverableBeforeConnected`), when start keeps waiting for the
 * fallback's `connected` — the caller owns boot retry; a terminal error after
 * that is a typed dead surface (the SDK has stopped itself; the listener is
 * stopped and an Error published); and a streak of closes or reopen errors
 * without a reconnect is reported unreachable once it passes the bound, loud
 * and once per streak, while the SDK's bounded backoff keeps trying — nothing
 * remounts a stopped surface, so custody never stops one that may still
 * recover. Every observation rides its own trace id from the injected UUID
 * source; no ambient time or entropy.
 */
export function listenerCustody<Map extends SdkListenerEventMap>(
  listener: SdkListener<Map>,
  options: ListenerCustodyOptions<Map>,
): ListenerCustody {
  const bound = options.failureBound ?? RECONNECT_ATTEMPT_BOUND;
  const failOnClose = options.failOnCloseBeforeConnected ?? true;
  const state = { settled: false, dead: false, failures: 0, reported: false };
  const observe = (
    event:
      | typeof Operational.Events.Info
      | typeof Operational.Events.Warn
      | typeof Operational.Events.Error,
    msg: string,
    context?: Record<string, string | number>,
  ) =>
    options.publish(event, {
      traceId: newTraceId(options.id),
      time: options.now(),
      component: "server",
      msg,
      ...(context === undefined ? {} : { context }),
    });
  const failure = (what: string, context?: Record<string, string | number>) => {
    state.failures += 1;
    if (state.failures < bound || state.reported) {
      observe(Operational.Events.Info, `${options.label} ${what}, sdk reconnecting`, {
        ...context,
        failures: state.failures,
      });
      return;
    }
    state.reported = true;
    observe(
      Operational.Events.Error,
      `${options.label} unreachable: ${state.failures} failures without a reconnect`,
      { ...context, failures: state.failures },
    );
  };
  let rejectReady: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    rejectReady = reject;
    listener.on("connected", (...info: Map["connected"]) => {
      if (state.dead) return;
      const recovered = state.failures > 0;
      state.failures = 0;
      state.reported = false;
      options.onConnected?.(...info);
      if (state.settled) {
        if (recovered) observe(Operational.Events.Info, `${options.label} reconnected`);
        return;
      }
      state.settled = true;
      resolve();
    });
    listener.on("error", (error: Error) => {
      if (state.dead) return;
      const context = {
        err: error.message,
        ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
      };
      if (!state.settled) {
        if (options.recoverableBeforeConnected?.(error) === true) {
          observe(Operational.Events.Warn, `${options.label} error, sdk falling back`, context);
          return;
        }
        observe(Operational.Events.Warn, `${options.label} error`, context);
        state.settled = true;
        reject(error);
        return;
      }
      if (options.terminal?.(error) === true) {
        // The SDK has stopped itself; make that a typed dead surface, not a Warn.
        state.dead = true;
        listener.stop();
        observe(Operational.Events.Error, `${options.label} dead: ${error.message}`, context);
        return;
      }
      // A reopen that fails emits only `error` (no socket was ever opened), so
      // it counts toward the streak like a close.
      observe(Operational.Events.Warn, `${options.label} error`, context);
      failure("error", context);
    });
    listener.on("disconnected", () => {
      if (state.dead) return;
      if (!state.settled) {
        if (!failOnClose) return;
        state.settled = true;
        reject(
          new ChannelsFailure({
            operation: `${options.label}.start`,
            cause: "closed before the first hello",
          }),
        );
        return;
      }
      failure("closed");
    });
  });
  // A rejection nobody awaits yet must not surface as unhandled.
  ready.catch(() => undefined);
  return {
    get dead() {
      return state.dead;
    },
    async start() {
      try {
        await listener.start();
        await ready;
      } catch (error) {
        if (!state.dead) {
          state.dead = true;
          listener.stop();
        }
        throw error;
      }
    },
    stop() {
      state.dead = true;
      listener.stop();
      // A stopped listener never says hello: a start still waiting must settle, or its caller hangs.
      if (state.settled) return;
      state.settled = true;
      rejectReady(
        new ChannelsFailure({
          operation: `${options.label}.start`,
          cause: "stopped before the first hello",
        }),
      );
    },
  };
}
