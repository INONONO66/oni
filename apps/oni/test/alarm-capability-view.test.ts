import { expect, test } from "bun:test";
import type { Bundle } from "@oni/agent";
import { alarmCapabilityView } from "../src/composition/watch-plane";

type View = Bundle.AlarmCapabilityDefinition;

function instance(tag: string, log: string[]): View {
  const cast = <T>(value: object) => value as T;
  return {
    name: "alarm",
    points: ["alarm.fired"],
    definition: cast<View["definition"]>({ tag }),
    registry: cast<View["registry"]>({ tag }),
    purposes: cast<View["purposes"]>({ tag }),
    wake: cast<View["wake"]>((fired: object) => {
      log.push(`${tag}:wake:${JSON.stringify(fired)}`);
      return cast<ReturnType<View["wake"]>>({});
    }),
    verbs: {
      arm: cast<View["verbs"]["arm"]>((sessionId: string, turnId: string) => (input: object) => {
        log.push(`${tag}:arm:${sessionId}:${turnId}:${JSON.stringify(input)}`);
        return cast<ReturnType<ReturnType<View["verbs"]["arm"]>>>({});
      }),
      watch: cast<View["verbs"]["watch"]>((input: object) => {
        log.push(`${tag}:watch:${JSON.stringify(input)}`);
        return cast<ReturnType<View["verbs"]["watch"]>>({});
      }),
    },
  };
}

test("alarmCapabilityView reads every face from the holder's CURRENT instance, so a recompose swap is seen at once", () => {
  const log: string[] = [];
  const boot = instance("boot", log);
  const swapped = instance("swapped", log);
  const holder = { current: boot };
  const view = alarmCapabilityView(holder);
  expect(view.name).toBe("alarm");
  expect(view.points).toEqual(["alarm.fired"]);
  expect(view.definition).toBe(boot.definition);
  expect(view.registry).toBe(boot.registry);
  expect(view.purposes).toBe(boot.purposes);
  holder.current = swapped;
  expect(view.definition).toBe(swapped.definition);
  expect(view.registry).toBe(swapped.registry);
  expect(view.purposes).toBe(swapped.purposes);
  const fired = { occurrenceId: "o1" } as Parameters<View["wake"]>[0];
  const ctx = {} as Parameters<View["wake"]>[1];
  view.wake(fired, ctx);
  view.verbs.arm("s1", "t1")({ purpose: "cron.tick" } as Parameters<ReturnType<View["verbs"]["arm"]>>[0]);
  const watchInput: Pick<Parameters<View["verbs"]["watch"]>[0], "watchId"> = { watchId: "w1" };
  view.verbs.watch(watchInput as Parameters<View["verbs"]["watch"]>[0]);
  expect(log).toEqual([
    'swapped:wake:{"occurrenceId":"o1"}',
    'swapped:arm:s1:t1:{"purpose":"cron.tick"}',
    'swapped:watch:{"watchId":"w1"}',
  ]);
});
