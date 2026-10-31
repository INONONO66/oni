import { Machine } from "@oni/protocol";
import { z } from "zod";

const Address = z.object({ machineId: Machine.MachineId }).strict();

export const ComputerOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("computer_request"), args: Address.extend(Machine.ComputerRequest.shape).strict() }).strict(),
  z.object({ op: z.literal("computer_list"), args: z.object({}).strict() }).strict(),
  z.object({ op: z.literal("computer_end"), args: Address }).strict(),
  z.object({ op: z.literal("computer_exclude"), args: Machine.ComputerExclusion }).strict(),
  z.object({ op: z.literal("computer_keep"), args: Machine.ComputerKeep }).strict(),
]);
export type ComputerOperation = z.infer<typeof ComputerOperation>;

const ConsentResult = z.object({ type: z.literal("require_approval"), id: z.string() }).strict();
export const ComputerResult = z.discriminatedUnion("op", [
  z.object({ op: z.literal("computer_request"), result: z.union([Machine.ComputerLease, ConsentResult]) }).strict(),
  z.object({ op: z.literal("computer_list"), result: z.object({ leases: z.array(Machine.ComputerLease), exclusions: z.array(Machine.ComputerExclusion) }).strict() }).strict(),
  z.object({ op: z.literal("computer_end"), result: Machine.ComputerLease.nullable() }).strict(),
  z.object({ op: z.literal("computer_exclude"), result: z.union([Machine.ComputerExclusion, ConsentResult]) }).strict(),
  z.object({ op: z.literal("computer_keep"), result: Machine.ComputerKeep }).strict(),
]);
export type ComputerResult = z.infer<typeof ComputerResult>;
