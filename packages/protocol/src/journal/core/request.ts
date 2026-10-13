/**
 * `request` — a durable request and every lifecycle phase, including answers
 * (`phase: open|answered|resolved|expired`); the former `reply` kind is the
 * answered phase of this kind. Single writer: the request transition
 * constructor (`packages/agent/src/core/session/request.ts`).
 */
import { z } from "zod";
import { RowBody, declare, refineField } from "../declaration.js";

export const Phase = z.enum(["open", "answered", "resolved", "expired"]);
export type Phase = z.infer<typeof Phase>;

export const request = declare(
  "request",
  RowBody.superRefine(refineField("effect", "phase", Phase)),
);
