import { z } from "zod";
import { Agent } from "./schema.js";

const Id = z.string().min(1);
const Correlation = z.object({ requestId: Id });

export const Request = z.discriminatedUnion("type", [
  Correlation.extend({ type: z.literal("agent_list") }).strict(),
  Correlation.extend({ type: z.literal("agent_add"), record: Agent }).strict(),
  Correlation.extend({ type: z.literal("agent_disable"), id: Id }).strict(),
]);
export type Request = z.infer<typeof Request>;

export const Response = z.discriminatedUnion("type", [
  Correlation.extend({ type: z.literal("agent_listed"), records: z.array(Agent) }).strict(),
  Correlation.extend({ type: z.literal("agent_added"), record: Agent }).strict(),
  Correlation.extend({ type: z.literal("agent_disabled"), record: Agent }).strict(),
  Correlation.extend({
    type: z.enum(["agent_list_refused", "agent_add_refused", "agent_disable_refused"]),
    reason: z.enum([
      "owner_auth_required", "invalid_record", "store_unconfigured", "store_failed",
      "not_found", "disabled", "duplicate", "seed_protected",
    ]),
    detail: z.string(),
  }).strict(),
]);
export type Response = z.infer<typeof Response>;
