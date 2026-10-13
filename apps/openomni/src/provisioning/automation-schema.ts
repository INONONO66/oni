import { Ingress } from "@openomni/protocol";
import { z } from "zod";

const [AddRequest, RemoveRequest] = Ingress.AutomationRequest.options;
const Id = RemoveRequest.omit({ type: true, requestId: true });
const RecordResult = z.object({ record: Ingress.Automation }).strict();
const Approval = z.object({ type: z.literal("require_approval"), id: z.string() }).strict();

export const AutomationOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("automation_add"), args: AddRequest.omit({ type: true, requestId: true }) }).strict(),
  z.object({ op: z.literal("automation_remove"), args: Id }).strict(),
  z.object({ op: z.literal("automation_enable"), args: Id }).strict(),
  z.object({ op: z.literal("automation_disable"), args: Id }).strict(),
  z.object({ op: z.literal("automation_list"), args: z.object({}).strict() }).strict(),
]);
export type AutomationOperation = z.infer<typeof AutomationOperation>;
export const AutomationResult = z.discriminatedUnion("op", [
  z.object({ op: z.literal("automation_add"), result: z.union([RecordResult, Approval]) }).strict(),
  z.object({ op: z.literal("automation_remove"), result: Id }).strict(),
  z.object({ op: z.literal("automation_enable"), result: z.union([RecordResult, Approval]) }).strict(),
  z.object({ op: z.literal("automation_disable"), result: RecordResult }).strict(),
  z.object({ op: z.literal("automation_list"), result: z.object({ records: z.array(Ingress.Automation) }).strict() }).strict(),
]);
export type AutomationResult = z.infer<typeof AutomationResult>;

export interface AutomationRefusal extends Pick<Ingress.AutomationRefused, "reason" | "id"> {
  readonly type: "error";
}
