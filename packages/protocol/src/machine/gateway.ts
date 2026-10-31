import { z } from "zod";
import { EpochMs } from "../time.js";
import { AttachGeneration, CapabilityId, Enrollment, Load, Peer, Resources } from "./schema.js";
import { HumanInput, Session, TransportFacts } from "./facts.js";
import { Screen } from "./probe.js";

/** The host's attached-machine projection, shared by provision and the gateway. */
export const Info = Enrollment.extend({
  tags: z.array(z.string()),
  capabilities: z.array(CapabilityId),
  pendingCapabilities: z.array(CapabilityId),
  os: z.string(),
  arch: z.string(),
  resources: Resources.optional(),
  generation: AttachGeneration.optional(),
  peer: Peer.optional(),
  live: z.object({
    reportedAt: EpochMs, load: Load, screen: Screen.optional(),
    humanInput: HumanInput.optional(),
    session: Session.optional(), transport: TransportFacts.optional(), stale: z.boolean(),
  }).strict().optional(),
});
export type Info = z.infer<typeof Info>;

export const Request = z.object({
  type: z.literal("machine_list"),
  requestId: z.string().min(1),
}).strict();
export type Request = z.infer<typeof Request>;

export const Response = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("machine_listed"),
    requestId: z.string().min(1),
    rows: z.array(Info),
  }).strict(),
  z.object({
    type: z.literal("machine_list_refused"),
    requestId: z.string().min(1),
    reason: z.enum(["unavailable", "invalid_request"]),
    detail: z.string(),
  }).strict(),
]);
export type Response = z.infer<typeof Response>;
