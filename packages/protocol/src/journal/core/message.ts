/**
 * `message` — an outbound obligation toward a channel or session
 * (`to: channel|session`, `direction: out`) and its delivery acknowledgement;
 * the former `outbound` kind is this kind's session-directed shape.
 * Single writer: the session outbound constructor
 * (`packages/agent/src/core/session/outbound.ts`); handlers call it.
 */
import { z } from "zod";
import { RowBody, declare, refineField } from "../declaration.js";

export const message = declare(
  "message",
  RowBody.superRefine(refineField("intent", "to", z.enum(["channel", "session"]))).superRefine(
    refineField("intent", "direction", z.literal("out")),
  ),
);
