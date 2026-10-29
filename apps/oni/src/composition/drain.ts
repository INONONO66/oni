import { timingSafeEqual } from "node:crypto";
import { ChannelsFailure, type createGatewayRouter } from "@oni/channels";
import { type Gateway, Machine } from "@oni/protocol";
import { Effect } from "effect";
import { type DrainAnswer, DrainRequest, type HostStatus } from "../cli/supervise-wire";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type DrainFrame = Gateway.HostDrain;

export interface DrainSignals {
  readonly liveTurns: () => number;
  readonly onLiveChange: (listener: () => void) => () => void;
  readonly announce: (frame: DrainFrame) => void;
  readonly after: (ms: number, fire: () => void) => () => void;
  readonly now: () => number;
}

export type DrainGate = ReturnType<typeof createDrainGate>;

/**
 * Counts the host's in-flight work for a drain (#1699): every turn from its
 * start through its terminal seal and commit (keyed by session, entity and
 * process runners alike; run-scoped compaction speculation ends inside it),
 * and every admitted ingress until the router returns. Listeners run on each
 * release, so the drain gate waits on events rather than polling.
 */
export function createWorkTracker() {
  const sessions = new Map<string, number>();
  const listeners = new Set<() => void>();
  let total = 0;
  const enter = (key: string | undefined): (() => void) => {
    total += 1;
    if (key !== undefined) sessions.set(key, (sessions.get(key) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      total -= 1;
      if (key !== undefined) {
        const left = (sessions.get(key) ?? 1) - 1;
        if (left === 0) sessions.delete(key);
        else sessions.set(key, left);
      }
      for (const listener of listeners) listener();
    };
  };
  return {
    count: () => total,
    live: (sessionId: string) => sessions.has(sessionId),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    track: <A, E, R>(key: string | undefined, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        const release = enter(key);
        return work.pipe(Effect.ensuring(Effect.sync(release)));
      }),
    trackPromise: <A>(key: string, work: () => Promise<A>): Promise<A> => {
      const release = enter(key);
      return work().finally(release);
    },
  };
}

type Prepare = Parameters<typeof createGatewayRouter>[0]["prepare"];

/**
 * The one drain admission decision (#1699), at the router's common prepare
 * step every ingress, outbound dispatch and automation delivery passes:
 * while draining, work that would create a session or wake an idle one is
 * refused `draining`; steering of a session whose turn is in flight, and a
 * live turn's own outbound send, are continuations and pass.
 */
export function drainAdmission(prepare: Prepare, fence: {
  readonly draining: () => boolean;
  readonly live: (sessionId: string) => boolean;
}): Prepare {
  return (sender, send, target, messageId) =>
    prepare(sender, send, target, messageId).pipe(
      Effect.flatMap((prepared) => {
        if (!fence.draining()) return Effect.succeed(prepared);
        const continuation = prepared.createSession === undefined && (
          fence.live(prepared.target) ||
          (send.to.kind !== "session" && sender.kind === "session" && fence.live(sender.id)));
        return continuation
          ? Effect.succeed(prepared)
          : Effect.fail(new ChannelsFailure({ operation: "message.admission", cause: "draining" }));
      }),
    );
}

/**
 * The host's drain fence for a drain-restart (#1699): `drain` closes
 * admission and answers once the work tracker reports no in-flight turn or
 * admitted ingress, or reopens admission at the deadline.
 */
export function createDrainGate(signals: DrainSignals) {
  const now = signals.now();
  const instanceId = [
    ...Array.from({ length: 10 }, (_, index) => CROCKFORD[Math.floor(now / 32 ** (9 - index)) % 32]),
    ...Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => CROCKFORD[byte % 32]),
  ].join("");
  let state: HostStatus["state"] = "open";
  return {
    instanceId,
    state: () => state,
    drain: (request: DrainRequest): Promise<DrainAnswer> => {
      if (request.expectedInstanceId !== instanceId) return Promise.resolve({ ok: false, class: "instance_mismatch" });
      if (state === "draining") return Promise.resolve({ ok: false, class: "draining" });
      state = "draining";
      signals.announce({ type: "draining", targetVersion: request.targetVersion, graceMs: request.graceMs });
      return new Promise((resolve) => {
        const settle = (answer: DrainAnswer): void => {
          unsubscribe();
          cancelDeadline();
          resolve(answer);
        };
        const check = (): void => {
          if (signals.liveTurns() === 0) settle({ drained: true, inFlight: 0, projectionsIdle: true });
        };
        const unsubscribe = signals.onLiveChange(check);
        const cancelDeadline = signals.after(request.graceMs, () => {
          state = "open";
          signals.announce({ type: "drain_cancelled" });
          const inFlight = signals.liveTurns();
          settle({ drained: false, inFlight, projectionsIdle: inFlight === 0 });
        });
        check();
      });
    },
  };
}

const DRAIN_STATUS: Record<string, number> = { instance_mismatch: 409, draining: 409, invalid_request: 400 };

/**
 * `GET /status` and `POST /drain` behind the ws token as a bearer
 * credential; a tokenless host refuses both. A confirmed drain hands the
 * process to `onDrained` after its answer is written.
 */
export function hostControlRoutes(gate: DrainGate, options: {
  readonly token: string | undefined;
  readonly version: string;
  readonly onDrained: () => void;
}) {
  const expected = Buffer.from(`Bearer ${options.token ?? ""}`);
  const authorized = (request: Request): boolean => {
    const presented = Buffer.from(request.headers.get("authorization") ?? "");
    return (options.token ?? "").length > 0 && presented.length === expected.length && timingSafeEqual(presented, expected);
  };
  const drain = async (request: Request): Promise<Response> => {
    const body = DrainRequest.safeParse(await request.json().catch(() => undefined));
    if (!body.success) return Response.json({ ok: false, class: "invalid_request" }, { status: 400 });
    const answer = await gate.drain(body.data);
    if ("drained" in answer && answer.drained) setImmediate(options.onDrained);
    return Response.json(answer, { status: "class" in answer ? DRAIN_STATUS[answer.class] : 200 });
  };
  return (request: Request, pathname: string): Promise<Response> | undefined => {
    const route = `${request.method} ${pathname}`;
    if (route !== "GET /status" && route !== "POST /drain") return undefined;
    if (!authorized(request)) return Promise.resolve(Response.json({ ok: false, class: "unauthenticated" }, { status: 401 }));
    if (route === "POST /drain") return drain(request);
    const status: HostStatus = {
      version: options.version,
      instanceId: gate.instanceId,
      contractVersion: Machine.contractVersion,
      capabilities: { drainRestart: true },
      state: gate.state(),
    };
    return Promise.resolve(Response.json(status));
  };
}
