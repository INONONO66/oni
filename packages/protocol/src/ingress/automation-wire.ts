import { z } from "zod";
import { Events } from "../event/ingress.js";
import { EpochMs } from "../time.js";
import { Automation } from "./automation.js";

const Id = z.string().min(1);
const Correlation = z.object({ requestId: Id });

export const RefusalReason = z.enum([
  "not_found",
  "require_approval",
  "invalid_record",
  "store_unconfigured",
]);
export type RefusalReason = z.infer<typeof RefusalReason>;

export const LedgerFilter = z.object({
  surface: Id.optional(),
  decision: z.enum(["matched", "filtered", "refused", "deduped", "grouped", "superseded"]).optional(),
  recordId: Id.optional(),
  since: EpochMs.optional(),
  until: EpochMs.optional(),
  limit: z.number().int().positive().default(200),
}).strict();
export type LedgerFilter = z.infer<typeof LedgerFilter>;

export const Request = z.discriminatedUnion("type", [
  Correlation.extend({
    type: z.literal("automation_add"),
    record: Automation.extend({ id: Id.optional() }),
  }).strict(),
  Correlation.extend({ type: z.literal("automation_remove"), id: Id }).strict(),
  Correlation.extend({ type: z.literal("automation_enable"), id: Id }).strict(),
  Correlation.extend({ type: z.literal("automation_disable"), id: Id }).strict(),
  Correlation.extend({ type: z.literal("automation_list") }).strict(),
  Correlation.extend({ type: z.literal("automation_ledger"), ...LedgerFilter.shape }).strict(),
]);
export type Request = z.infer<typeof Request>;

export const Refused = Correlation.extend({
  type: z.enum([
    "automation_add_refused",
    "automation_remove_refused",
    "automation_enable_refused",
    "automation_disable_refused",
    "automation_list_refused",
    "automation_ledger_refused",
  ]),
  reason: RefusalReason,
  detail: z.string(),
  id: Id.optional(),
  issues: z.array(z.object({
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string(),
    code: z.string(),
  }).strict()).optional(),
}).strict();
export type Refused = z.infer<typeof Refused>;

export const Response = z.discriminatedUnion("type", [
  Correlation.extend({ type: z.literal("automation_added"), record: Automation }).strict(),
  Correlation.extend({ type: z.literal("automation_removed"), id: Id }).strict(),
  Correlation.extend({ type: z.literal("automation_enabled"), record: Automation }).strict(),
  Correlation.extend({ type: z.literal("automation_disabled"), record: Automation }).strict(),
  Correlation.extend({ type: z.literal("automation_listed"), records: z.array(Automation) }).strict(),
  Correlation.extend({ type: z.literal("automation_ledger_read"), rows: z.array(Events.RoutingDecision.schema) }).strict(),
  Refused,
]);
export type Response = z.infer<typeof Response>;
