import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createArmedAlarmPorts } from "../src/core/store/session-file/alarms";
import { LedgerInvariant } from "../src/core/store/errors";

/**
 * The armed-alarm read derives armSeq from the arm row id; an index row whose
 * joined arm id carries no `:arm:<seq>` suffix is an invariant breach, never
 * a silently defaulted sequence.
 */
test("armedAlarms refuses an arm row id without an armSeq suffix", () => {
  const db = new Database(":memory:");
  try {
    db.run("CREATE TABLE armed_alarms (alarm_id TEXT, occurrence_id TEXT, fire_at INTEGER, strikes INTEGER)");
    db.run("CREATE TABLE action (id TEXT, kind TEXT, intent TEXT, effect TEXT)");
    db.run("INSERT INTO armed_alarms VALUES ('a1', 'o1', 5, 0)");
    db.run(`INSERT INTO action VALUES ('s1:a1:bad', 'alarm', '{"op":"arm","purpose":"p","sourceKey":"k"}', '{"occurrenceId":"o1"}')`);
    const armed = createArmedAlarmPorts(db);
    expect(() => armed.armedAlarms()).toThrow(LedgerInvariant);
    expect(() => armed.armedAlarms()).toThrow("arm row id does not carry an armSeq: s1:a1:bad");
  } finally {
    db.close();
  }
});
