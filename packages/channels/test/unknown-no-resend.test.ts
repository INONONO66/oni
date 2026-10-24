import { expect, test } from "bun:test";
import { Operational } from "@oni/protocol";
import { z } from "zod";
import { DeliveryReconciliation, deliverKeyed } from "../src/support/deliver";
import { DeliveryNotSent } from "../src/errors";
import type { PublishPort } from "../src/types";
import { FIXED_NOW, sequentialIds } from "./helpers/injected";

const WarnData = z.object({ msg: z.string(), context: z.record(z.string(), z.json()) });

function harness() {
  const warns: z.infer<typeof WarnData>[] = [];
  const publish: PublishPort = (event, data) => {
    if (event.name === Operational.Events.Warn.name) warns.push(WarnData.parse(data));
  };
  return {
    warns,
    publish,
    reconciliation: new DeliveryReconciliation(),
    options: { now: () => FIXED_NOW, id: sequentialIds() },
  };
}

/**
 * #1248: an uncertain send is terminal — unknown receipt, ONE physical
 * attempt, and ONE Owner-visible notice. A retry with the same idempotency
 * key reuses the recorded receipt instead of resending or re-warning.
 */
test("a mid-write failure is unknown: one attempt, one Owner notice, no resend", async () => {
  const h = harness();
  let sends = 0;
  const send = () => {
    sends += 1;
    return Promise.reject(new Error("socket reset mid-write"));
  };
  const first = await deliverKeyed(h.reconciliation, "key-1", send, () => false, h.publish, h.options);
  expect(first).toEqual({ value: "unknown" });
  expect(h.warns).toEqual([
    {
      msg: "delivery outcome unknown; uncertain send will not be retried",
      context: { idempotencyKey: "key-1", reason: "Error: socket reset mid-write" },
    },
  ]);
  const retry = await deliverKeyed(h.reconciliation, "key-1", send, () => false, h.publish, h.options);
  expect(retry).toEqual({ value: "unknown" });
  expect(sends).toBe(1); // never resend an uncertain send
  expect(h.warns).toHaveLength(1); // the notice is per physical attempt, not per retry
});

/** A platform accepting the send without a message id is equally uncertain. */
test("a missing platform message id is unknown with the same Owner notice", async () => {
  const h = harness();
  let sends = 0;
  const send = () => {
    sends += 1;
    return Promise.resolve({ accepted: false });
  };
  const first = await deliverKeyed(h.reconciliation, "key-2", send, () => false, h.publish, h.options);
  expect(first).toEqual({ value: "unknown" });
  expect(h.warns.map((warn) => warn.context)).toEqual([
    { idempotencyKey: "key-2", reason: "platform returned no message id" },
  ]);
  await deliverKeyed(h.reconciliation, "key-2", send, () => false, h.publish, h.options);
  expect(sends).toBe(1);
  expect(h.warns).toHaveLength(1);
});

/** Proven refusals stay not_sent: retry is allowed and no unknown notice fires. */
test("a proven not_sent refusal keeps retry open and warns nothing", async () => {
  const h = harness();
  let sends = 0;
  const send = () => {
    sends += 1;
    return Promise.reject(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
  };
  const first = await deliverKeyed(h.reconciliation, "key-3", send, () => false, h.publish, h.options);
  expect(first).toEqual({ value: "not_sent" });
  await deliverKeyed(h.reconciliation, "key-3", send, () => false, h.publish, h.options);
  expect(sends).toBe(2); // proof of no connection permits a real retry
  expect(h.warns).toEqual([]);
});

test.each(["sync", "async"] as const)("a %s preflight refusal releases its delivery key", async (mode) => {
  const h = harness();
  let sends = 0;
  const refused = new DeliveryNotSent({ operation: "preflight", cause: "no channel" });
  const send = () => {
    sends++;
    if (mode === "sync") throw refused;
    return Promise.reject(refused);
  };
  expect(await deliverKeyed(h.reconciliation, "preflight", send, () => false, h.publish, h.options))
    .toEqual({ value: "not_sent" });
  expect(await deliverKeyed(h.reconciliation, "preflight", send, () => false, h.publish, h.options))
    .toEqual({ value: "not_sent" });
  expect(sends).toBe(2);
  expect(h.warns).toEqual([]);
});
