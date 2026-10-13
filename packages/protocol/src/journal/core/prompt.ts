/**
 * `prompt` — a turn input of human/contact/alarm/nudge origin.
 * Single writer: the entity deliver path (`packages/agent/src/core/journal/commit.ts`);
 * capability handlers reach it only through that constructor.
 * `delivery: steer|followUp` (default `followUp`) picks consumption width.
 * Version 2 (#1315): payloads name the delivered input `deliveryId`/
 * `deliveryKind`; the version-1 reader was deleted in #1351.
 */
import { Delivery, RowBody, declare, refineField } from "../declaration.js";

export const prompt = declare(
  "prompt",
  RowBody.superRefine(refineField("intent", "delivery", Delivery)),
  2,
);
