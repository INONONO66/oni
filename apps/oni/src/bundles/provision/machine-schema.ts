import { Machine } from "@oni/protocol";
import { z } from "zod";

const PermissionRequestRef = z.object({
  machineId: Machine.MachineId,
  agentSessionId: z.string().min(1),
  requestId: z.string().min(1),
}).strict();

const PermissionAnswered = z.object({
  kind: z.enum(["recorded", "exists"]),
  status: z.enum(["allowed", "denied"]),
}).strict();

export const MachineOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("machine_add"), args: Machine.Enrollment.omit({ enrolledAt: true }) }).strict(),
  z.object({ op: z.literal("machine_grant"), args: z.object({
    machineId: Machine.MachineId,
    capabilities: z.array(Machine.CapabilityId).min(1),
  }).strict() }).strict(),
  z.object({ op: z.literal("machine_deny"), args: z.object({ machineId: Machine.MachineId }).strict() }).strict(),
  z.object({ op: z.literal("machine_remove"), args: z.object({ machineId: Machine.MachineId }).strict() }).strict(),
  z.object({ op: z.literal("machine_list"), args: z.object({}).strict() }).strict(),
  z.object({ op: z.literal("permission_allow"), args: PermissionRequestRef }).strict(),
  z.object({ op: z.literal("permission_deny"), args: PermissionRequestRef }).strict(),
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
  z.object({ op: z.literal("permission_allow"), result: z.union([
    PermissionAnswered,
    z.object({ type: z.literal("require_approval"), id: z.string() }).strict(),
  ]) }).strict(),
  z.object({ op: z.literal("permission_deny"), result: PermissionAnswered }).strict(),
]);
export type MachineResult = z.infer<typeof MachineResult>;
