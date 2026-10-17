import { expect, test } from "bun:test";
import { Bundle, type Core } from "@openomni/agent";
import { Effect } from "effect";
import { createWatchPlane } from "../src/composition/watch-plane";
import type { WatchSources } from "../src/composition/watch-sources";
import { CHILD_WATCH, type ChildWatch } from "../src/bundles/child-activity/index";
import { runEffect } from "./helpers/effect";
import { spec } from "./helpers/child-activity";

function fixture() {
  const restored: ChildWatch[] = [];
  const installed: ChildWatch[] = [];
  const closed: string[] = [];
  const arms: Parameters<Core.ArmVerb>[0][] = [];
  const plane = createWatchPlane();
  const sources: WatchSources = {
    install: async () => undefined,
    installChild: async (child) => { installed.push(child); },
    restoreChild: (child) => { restored.push(child); },
    refresh: () => false,
    observe: () => true,
    close: async (id) => { closed.push(id); },
    closeAll: async () => undefined,
  };
  plane.bind(sources);
  const release = plane.arms.onLive(spec.sessionId, {
    ownsTurn: () => true,
    arm: (input) => Effect.sync(() => {
      arms.push(input);
      return { alarmId: input.alarmId ?? "", occurrenceId: "child-occurrence", armSeq: 1 };
    }),
  });
  const fired = {
    occurrenceId: "child-occurrence", alarmId: `${spec.id}:watch`, armSeq: 1,
    sourceKey: `watch:${spec.id}`, purpose: CHILD_WATCH,
    payload: JSON.stringify({ watchId: spec.id, child: spec }), fireAt: 100,
  };
  const context: Core.AlarmWakeContext = {
    sessionId: spec.sessionId, now: 100,
    reads: { latestArm: () => ({ occurrenceId: fired.occurrenceId, at: 100 }), settled: () => false },
    arm: () => Effect.succeed({ alarmId: fired.alarmId, occurrenceId: "retired", armSeq: 2 }),
    prompt: () => Effect.succeed({ seq: 1 }),
  };
  return { plane, sources, arms, installed, closed, restored, release, fired, context };
}

test("child cadence persists its source spec and restores without awaiting reentrant intake", async () => {
  const fx = fixture();
  await runEffect(fx.plane.installChild(spec));
  expect(fx.installed).toEqual([spec]);
  expect(fx.arms[0]).toMatchObject({ purpose: CHILD_WATCH, payload: { watchId: spec.id, child: spec } });
  const capability = await runEffect(fx.plane.capabilityFor(["child-activity"]));
  expect(await runEffect(capability.wake(fx.fired, fx.context))).toEqual({ outcome: "quiet", at: 1100 });
  expect(fx.restored).toEqual([spec]);
  fx.plane.onArmed({
    sessionId: spec.sessionId, purpose: CHILD_WATCH, alarmId: fx.fired.alarmId,
    occurrenceId: fx.fired.occurrenceId, armSeq: 1, at: 100, sourceKey: fx.fired.sourceKey,
    supersedes: null,
    payload: { watchId: spec.id, child: spec },
  });
  await runEffect(fx.plane.retirePath(spec.sessionId, spec.id));
  expect(fx.arms[1]).toMatchObject({ purpose: CHILD_WATCH, at: null, supersedes: "child-occurrence" });
  fx.release();
});

test("child cadence rejects a crossed session and refuses missing adapter ports", async () => {
  const fx = fixture();
  const capability = await runEffect(fx.plane.capabilityFor(["child-activity"]));
  await expect(runEffect(capability.wake(fx.fired, { ...fx.context, sessionId: "other-parent" }))).rejects.toMatchObject({ reason: "payload" });
  delete fx.sources.restoreChild;
  await expect(runEffect(capability.wake(fx.fired, fx.context))).rejects.toMatchObject({ reason: "source_missing" });
  delete fx.sources.installChild;
  await expect(runEffect(fx.plane.installChild(spec))).rejects.toEqual(new Bundle.WatchRefused({ reason: "source_missing" }));
  await expect(runEffect(fx.plane.installChild(spec, false))).rejects.toEqual(new Bundle.WatchRefused({ reason: "disabled" }));
  fx.release();
});

test("installation exposes source failure and unavailable activation without a private writer", async () => {
  const fx = fixture();
  fx.sources.installChild = () => Promise.reject(new Error("detached"));
  await expect(runEffect(fx.plane.installChild(spec))).rejects.toMatchObject({ reason: "Error: detached" });
  expect(fx.closed).toEqual([]);
  fx.sources.installChild = async (child) => { fx.installed.push(child); };
  fx.release();
  // A refused arm rolls the just-installed source back through the same close path a retired chain takes.
  await expect(runEffect(fx.plane.installChild(spec))).rejects.toMatchObject({ reason: "not_live" });
  expect(fx.installed).toEqual([spec]);
  expect(fx.closed).toEqual([spec.id]);
  expect(fx.arms).toEqual([]);
});

test("a child cadence retires its own purpose when restoration leaves no source", async () => {
  const fx = fixture();
  fx.sources.observe = () => false;
  const capability = await runEffect(fx.plane.capabilityFor(["child-activity"]));
  const retired: Parameters<Core.ArmVerb>[0][] = [];
  const result = await runEffect(capability.wake(fx.fired, {
    ...fx.context,
    arm: (input) => Effect.sync(() => {
      retired.push(input);
      return { alarmId: fx.fired.alarmId, occurrenceId: "retired", armSeq: 2 };
    }),
  }));
  expect(result).toBe("exhausted");
  expect(retired).toMatchObject([{ purpose: CHILD_WATCH, at: null }]);
  fx.release();
});
