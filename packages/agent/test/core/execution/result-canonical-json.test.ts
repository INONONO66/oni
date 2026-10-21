import { expect, it } from "bun:test";
import type { PlainValue } from "@oni/protocol";
import { Effect } from "effect";
import { recordingExecutor } from "../../helpers/effect-g1";
import { isolated } from "../../helpers/isolated";

const request = { kind: "tool", op: "measure", intent: { probe: 1 }, effect: { category: "query" } };

function resultValue(action: { effect: { value: PlainValue } }): PlainValue | undefined {
  const effect = action.effect.value;
  if (typeof effect !== "object" || effect === null || Array.isArray(effect)) return undefined;
  return effect.result;
}

it("body results cross the durable boundary as canonical JSON: non-finite numbers become null", () => isolated(Effect.gen(function* () {
  const recording = recordingExecutor();
  const raw = { ratio: Number.POSITIVE_INFINITY, series: [1, Number.NaN, 2], nested: { gap: Number.NEGATIVE_INFINITY } };
  const result = yield* recording.executor.run(request, () => Effect.succeed(raw));
  const canonical = { ratio: null, series: [1, null, 2], nested: { gap: null } };
  expect(result).toEqual({ terminal: "executed", value: canonical });
  const committed = recording.committed.find((action) => resultValue(action) !== undefined);
  expect(committed === undefined ? undefined : resultValue(committed)).toEqual(canonical);
  expect(recording.committed.some((action) => JSON.stringify(action).includes("Infinity"))).toBe(false);
})));
