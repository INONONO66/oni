import { expect, test } from "bun:test";
import { DateTime, PrimaryKey, Schema } from "effect";
import { DeliverAt } from "effect/cluster";
import { AlarmRpc } from "../../src/core/messages";

// Alarm occurrences are durable not-before clocks — the sharding
// scheduler reads DeliverAt off the decoded payload, so the instant must
// round-trip exactly, and the occurrence id is the cluster primary key the
// redelivery dedupe rides on. The occurrence carries its minter
// inputs (alarmId, armSeq, sourceKey) and an open purpose string.
test("an alarm occurrence delivers exactly at its durable not-before instant", () => {
  const occurrence = Schema.decodeUnknownSync(AlarmRpc.payloadSchema)({
    occurrenceId: "occ-digest-1",
    purpose: "deadline",
    alarmId: "req-1:deadline",
    armSeq: 7,
    sourceKey: "deadline",
    payload: JSON.stringify({ requestId: "req-1" }),
    fireAt: 5_000,
  });
  expect(DateTime.toEpochMillis(occurrence[DeliverAt.symbol]())).toBe(5_000);
  expect(occurrence[PrimaryKey.symbol]()).toBe("occ-digest-1");
});
