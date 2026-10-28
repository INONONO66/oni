import { Machine } from "@oni/protocol";
import { z } from "zod";

export const MachineOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("machine_add"), args: Machine.Enrollment.omit({ enrolledAt: true }) }).strict(),
  z.object({ op: z.literal("machine_grant"), args: z.object({
    machineId: Machine.MachineId,
    capabilities: z.array(Machine.CapabilityId).min(1),
  }).strict() }).strict(),
  z.object({ op: z.literal("machine_deny"), args: z.object({ machineId: Machine.MachineId }).strict() }).strict(),
  z.object({ op: z.literal("machine_remove"), args: z.object({ machineId: Machine.MachineId }).strict() }).strict(),
  z.object({ op: z.literal("machine_list"), args: z.object({}).strict() }).strict(),
]);
export type MachineOperation = z.infer<typeof MachineOperation>;

export const MachineResult = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("machine_add"),
    result: z.union([
      z.object({ enrollment: Machine.Enrollment }).strict(),
      z.object({ type: z.literal("require_approval"), id: Machine.MachineId }).strict(),
    ]),
  }).strict(),
  z.object({ op: z.literal("machine_remove"), result: z.object({ machineId: Machine.MachineId }).strict() }).strict(),
  z.object({ op: z.literal("machine_grant"), result: z.union([
    z.object({ enrollment: Machine.Enrollment }).strict(),
    z.object({ type: z.literal("require_approval"), id: Machine.MachineId }).strict(),
  ]) }).strict(),
  z.object({ op: z.literal("machine_deny"), result: z.union([
    z.object({ machineId: Machine.MachineId }).strict(),
    z.object({ type: z.literal("require_approval"), id: Machine.MachineId }).strict(),
  ]) }).strict(),
  z.object({ op: z.literal("machine_list"), result: z.object({ rows: z.array(Machine.Info) }).strict() }).strict(),
]);
export type MachineResult = z.infer<typeof MachineResult>;
