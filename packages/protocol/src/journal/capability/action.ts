/**
 * `action` (capability) — a deferred input (hook result, nudge) with the
 * `prompt` delivery rule plus `after: seq`; an action pointing before the
 * compaction head is never consumed and is closed via `turn` `consumedStale`.
 * Single writer: the entity deliver path (`packages/agent/src/core/journal/delivery.ts`)
 * on behalf of the action capability.
 */
import { z } from "zod";
import { Delivery, RowBody, declare, refineField } from "../declaration.js";

export const action = declare(
  "action",
  RowBody.superRefine(refineField("intent", "delivery", Delivery)).superRefine(
    refineField("intent", "after", z.number().int().nonnegative()),
  ),
);
