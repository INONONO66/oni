import { expect, test } from "bun:test";
import { Effect, Logger, References } from "effect";
import { logRestoredHistory } from "../src/core/recovery";
import { actionPayloadBytes } from "../src/core/store/action-hash";
import { RestoreRefused, restoreSessionHistory } from "../src/inspect/history";
import { isolatedRun, runTestSync } from "./helpers/isolated";
import { paddingActions } from "./helpers/reconstruction-fixture";

test("#1347 a typed activation restore refusal logs its warning and measured work", () => isolatedRun((ledger) => {
  const id = "bounded-restore-log";
  const kernel = ledger.kernel;
  const maxTailBytes = 10_000;
  runTestSync(kernel.materialize({
    id, role: "resident", parentId: null, policyGeneration: 1, tools: [],
    system: { preset: "", blocks: [] },
    settings: { steering: "all", followUp: "all", checkpoint: { everyActions: 256, maxTailBytes } },
    actionId: `${id}:configure`, at: 100,
  }));
  for (const action of paddingActions(id, `${id}:configure`, 600, "legacy")) {
    expect(ledger.session.actions.append(action, kernel.row(id).revision)).toBeDefined();
  }
  const pageBytes = (afterRevision: number) =>
    kernel.historyPage(id, { afterRevision, limit: 256 }).actions.reduce((total, action) => total + actionPayloadBytes(action), 0);
  expect(pageBytes(0)).toBeLessThanOrEqual(maxTailBytes);
  expect(pageBytes(0) + pageBytes(256)).toBeGreaterThan(maxTailBytes);
  const now = () => 5;
  const refused = runTestSync(Effect.flip(restoreSessionHistory(kernel, id, { now })));
  expect(RestoreRefused.isInstance(refused)).toBe(true);
  expect(refused.data.telemetry).toEqual({ rows: 512, bytes: pageBytes(0) + pageBytes(256), pages: 2, ms: 0 });
  const warnings: { message: string; annotations: Record<string, string | number> }[] = [];
  const collector = Logger.make((options) => {
    if (options.logLevel !== "Warn") return;
    const annotations: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(options.fiber.getRef(References.CurrentLogAnnotations))) {
      if (typeof value === "string" || typeof value === "number") annotations[key] = value;
    }
    for (const message of Array.isArray(options.message) ? options.message : [options.message]) {
      if (typeof message === "string") warnings.push({ message, annotations });
    }
  });
  runTestSync(logRestoredHistory(kernel, id, now).pipe(Effect.provide(Logger.layer([collector]))));
  expect(warnings).toEqual([{
    message: `session restore refused (budget): ${id}`,
    annotations: {
      restoreRows: 512,
      restoreBytes: pageBytes(0) + pageBytes(256),
      restorePages: 2,
      restoreMs: 0,
    },
  }]);
}));
