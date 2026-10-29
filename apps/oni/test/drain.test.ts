import { expect, test } from "bun:test";
import { Machine } from "@oni/protocol";
import { Effect } from "effect";
import { ChannelsFailure } from "@oni/channels";
import { createDrainGate, createWorkTracker, type DrainFrame, drainAdmission } from "../src/composition/drain";
import { HostStatus } from "../src/cli/supervise-wire";
import { ONI_VERSION } from "../src/version";
import { newTraceId } from "./helpers/bus";
import { runEffect } from "./helpers/effect";
import { bounded } from "./helpers/protected-dispatch";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextFrame } from "./helpers/ws";

const suite = residentSuite();

function gateFixture() {
  let subscribed = 0;
  const work = createWorkTracker();
  const frames: DrainFrame[] = [];
  const deadlines: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  const gate = createDrainGate({
    liveTurns: work.count,
    onLiveChange: (listener) => {
      const unsubscribe = work.subscribe(listener);
      subscribed += 1;
      return () => {
        subscribed -= 1;
        unsubscribe();
      };
    },
    announce: (frame) => frames.push(frame),
    after: (ms, fire) => {
      const deadline = { ms, fire, cancelled: false };
      deadlines.push(deadline);
      return () => {
        deadline.cancelled = true;
      };
    },
    now: () => 1_700_000_000_000,
  });
  /** Holds one unit of tracked work open until the returned release runs. */
  const hold = (key: string | undefined) => {
    const done = Promise.withResolvers<void>();
    const settled = work.trackPromise(key ?? "ingress", () => done.promise);
    return { release: () => done.resolve(), settled };
  };
  return { gate, work, frames, deadlines, subscriptions: () => subscribed, hold };
}

const request = (gate: ReturnType<typeof createDrainGate>) => ({ expectedInstanceId: gate.instanceId, targetVersion: "0.2.0", graceMs: 5_000 });

test("the instance id is a 26-character time-ordered Crockford id", () => {
  const { gate } = gateFixture();
  expect(gate.instanceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(gate.instanceId.slice(0, 10)).toBe("01HF7YAT00");
});

test("a mismatched instance refuses and leaves admission open", async () => {
  const { gate, frames } = gateFixture();
  expect(await gate.drain({ ...request(gate), expectedInstanceId: "other" })).toEqual({ ok: false, class: "instance_mismatch" });
  expect(gate.state()).toBe("open");
  expect(frames).toEqual([]);
});

test("drain closes admission and answers only after every tracked turn has released", async () => {
  const { gate, work, frames, deadlines, subscriptions, hold } = gateFixture();
  const turn = hold("session-a");
  const effectTurn = Promise.withResolvers<void>();
  const effectDone = runEffect(work.track("session-b", Effect.promise(() => effectTurn.promise)));
  let answered = false;
  const answer = gate.drain(request(gate)).finally(() => {
    answered = true;
  });
  expect(gate.state()).toBe("draining");
  expect(work.count()).toBe(2);
  expect(work.live("session-a")).toBe(true);
  expect(await gate.drain(request(gate))).toEqual({ ok: false, class: "draining" });
  expect(frames).toEqual([{ type: "draining", targetVersion: "0.2.0", graceMs: 5_000 }]);
  turn.release();
  await turn.settled;
  expect(work.live("session-a")).toBe(false);
  expect(answered).toBe(false);
  effectTurn.resolve();
  await effectDone;
  expect(await answer).toEqual({ drained: true, inFlight: 0, projectionsIdle: true });
  expect(deadlines[0]).toMatchObject({ ms: 5_000, cancelled: true });
  expect(subscriptions()).toBe(0);
  expect(gate.state()).toBe("draining");
});

test("a tracked turn stays counted until its whole body, commit included, has finished", async () => {
  const { work } = gateFixture();
  const sealed = Promise.withResolvers<void>();
  const committed = runEffect(work.track("session-a", Effect.gen(function* () {
    yield* Effect.promise(() => sealed.promise);
    // The commit step runs after the model has stopped: still inside the turn.
    return work.count();
  })));
  expect(work.count()).toBe(1);
  sealed.resolve();
  expect(await committed).toBe(1);
  expect(work.count()).toBe(0);
  const failed = runEffect(Effect.exit(work.track("session-a", Effect.fail("boom"))));
  expect((await failed)._tag).toBe("Failure");
  expect(work.live("session-a")).toBe(false);
});

test("an idle host drains at once", async () => {
  const { gate } = gateFixture();
  expect(await gate.drain(request(gate))).toEqual({ drained: true, inFlight: 0, projectionsIdle: true });
});

test("the deadline cancels an unconfirmed drain and reopens admission", async () => {
  const { gate, frames, deadlines, hold } = gateFixture();
  const turns = [hold("session-a"), hold(undefined)];
  const answer = gate.drain(request(gate));
  deadlines[0]?.fire();
  expect(await answer).toEqual({ drained: false, inFlight: 2, projectionsIdle: false });
  expect(frames.at(-1)).toEqual({ type: "drain_cancelled" });
  expect(gate.state()).toBe("open");
  for (const turn of turns) turn.release();
  await Promise.all(turns.map((turn) => turn.settled));
});

type Prepare = Parameters<typeof drainAdmission>[0];
type Prepared = Effect.Success<ReturnType<Prepare>>;

test("drain admission refuses new and idle-session work and admits continuations of live turns", async () => {
  let draining = false;
  const live = new Set(["live-session"]);
  const outcome = (prepared: Partial<Prepared>, sender: Parameters<Prepare>[0], to: Parameters<Prepare>[1]["to"]) => {
    const admit = drainAdmission(
      () => Effect.succeed({ target: "idle-session", message: { sender: "external", eventIdUnique: true }, ...prepared } as Prepared),
      { draining: () => draining, live: (id) => live.has(id) },
    );
    return runEffect(
      admit(sender, { to } as Parameters<Prepare>[1], "unused", "m-1").pipe(
        Effect.match({ onFailure: (failure) => failure, onSuccess: () => "admitted" as const }),
      ),
    );
  };
  const external = { kind: "external", surface: "ws", externalId: "connection:1" } as Parameters<Prepare>[0];
  const fromLive = { kind: "session", id: "live-session" } as Parameters<Prepare>[0];
  const toChannel: Parameters<Prepare>[1]["to"] = { kind: "origin", inReplyTo: "m-0" };
  const toSession: Parameters<Prepare>[1]["to"] = { kind: "session", id: "idle-session" };
  const refused = new ChannelsFailure({ operation: "message.admission", cause: "draining" });

  expect(await outcome({}, external, toChannel)).toBe("admitted");
  draining = true;
  expect(await outcome({}, external, toChannel)).toEqual(refused);
  expect(await outcome({ createSession: {} as Prepared["createSession"] }, external, toChannel)).toEqual(refused);
  expect(await outcome({ target: "live-session" }, external, toChannel)).toBe("admitted");
  expect(await outcome({ target: "live-session", createSession: {} as Prepared["createSession"] }, external, toChannel)).toEqual(refused);
  expect(await outcome({}, fromLive, toChannel)).toBe("admitted");
  expect(await outcome({}, fromLive, toSession)).toEqual(refused);
});

test("a booted host drains one in-flight turn: new sessions refuse draining, steering and interrupts land, then it hands off", async () => {
  const entered = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  const drained = Promise.withResolvers<void>();
  const app = await suite.boot({
    config: suite.config("oni-drain-", { wsToken: "drain-token" }),
    onDrained: () => drained.resolve(),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input) => Effect.gen(function* () {
        entered.resolve(input.trace.sessionId);
        yield* Effect.promise(() => release.promise);
        return { type: "stop" as const };
      }),
    },
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const bearer = { authorization: "Bearer drain-token" };
    expect((await fetch(`${base}/status`)).status).toBe(401);
    expect(await (await fetch(`${base}/status`, { headers: { authorization: "Bearer wrong-token" } })).json()).toEqual({ ok: false, class: "unauthenticated" });
    const reported = await (await fetch(`${base}/status`, { headers: bearer })).json();
    const status = HostStatus.parse(reported);
    expect(reported).toEqual({
      version: ONI_VERSION,
      instanceId: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      contractVersion: Machine.contractVersion,
      capabilities: { drainRestart: true },
      state: "open",
    });
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });

    const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "drain-token"]);
    socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "hold this turn" }));
    const handle = app.sessions.get(await bounded(entered.promise));
    if (handle === undefined) throw new Error("live turn missing");

    const post = (body: object) => fetch(`${base}/drain`, { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify(body) });
    const mismatch = await post({ expectedInstanceId: "someone-else", targetVersion: "9.9.9" });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({ ok: false, class: "instance_mismatch" });
    expect((await post({ expectedInstanceId: status.instanceId, targetVersion: "9.9.9", graceMs: 300_001 })).status).toBe(400);

    const announced = nextFrame(socket, (frame) => frame.type === "draining");
    const drain = post({ expectedInstanceId: status.instanceId, targetVersion: "9.9.9" });
    expect(await bounded(announced)).toEqual({ type: "draining", targetVersion: "9.9.9", graceMs: 60_000 });
    const steered = nextFrame(socket, (frame) => frame.type === "receipt");
    socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "steer the live turn" }));
    expect(await bounded(steered)).toEqual({ type: "receipt", status: "accepted" });
    const newcomer = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "drain-token"]);
    const refused = nextFrame(newcomer, (frame) => frame.type === "error");
    newcomer.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "too late" }));
    expect(await bounded(refused)).toMatchObject({ type: "error", operation: "message.admission", cause: "draining" });
    await bounded(runEffect(Effect.as(handle.interrupt(), undefined).pipe(Effect.ensuring(Effect.sync(() => release.resolve())))));
    const answer = await bounded(drain);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ drained: true, inFlight: 0, projectionsIdle: true });
    await bounded(drained.promise);
    expect(HostStatus.parse(await (await fetch(`${base}/status`, { headers: bearer })).json()).state).toBe("draining");
  } finally {
    release.resolve();
  }
});
