import { z } from "zod";

/**
 * The drain-restart deploy wire (#1699): the supervisor's unix-socket lines
 * (`deploy`, `reload` and their answer) and the host's authenticated
 * `GET /status` and `POST /drain` bodies the deploy reads and posts.
 */
export const MAX_GRACE_MS = 300_000;
export const DEFAULT_GRACE_MS = 60_000;

export const FailureClass = z.enum([
  "deploy_in_progress", "supervisor_unavailable", "unauthenticated", "invalid_request", "no_staged_artifact",
  "version_mismatch", "drain_refused", "drain_timeout", "exit_timeout", "lock_held", "snapshot_failed",
  "candidate_failed", "verify_failed", "restore_refused", "io_failed", "cancelled", "recovery_failed",
]);
export type FailureClass = z.infer<typeof FailureClass>;

export const DeployStep = z.enum(["request", "version", "drain", "exit", "snapshot", "start", "verify", "restore"]);
export type DeployStep = z.infer<typeof DeployStep>;

const GraceMs = z.number().int().min(0).max(MAX_GRACE_MS);

const DeployRequest = z.object({
  op: z.literal("deploy"),
  artifact: z.string().min(1),
  targetVersion: z.string().min(1),
  graceMs: GraceMs,
  token: z.string().min(1),
}).strict();

const ReloadRequest = z.object({ op: z.literal("reload") }).strict();

export const SuperviseRequest = z.discriminatedUnion("op", [DeployRequest, ReloadRequest]);
export type SuperviseRequest = z.infer<typeof SuperviseRequest>;

export const SuperviseAnswer = z.union([
  z.object({ ok: z.literal(true), instanceId: z.string().min(1) }).strict(),
  z.object({ ok: z.literal(false), class: FailureClass, step: DeployStep }).strict(),
]);
export type SuperviseAnswer = z.infer<typeof SuperviseAnswer>;

export const HostStatus = z.object({
  version: z.string().min(1),
  instanceId: z.string().min(1),
  contractVersion: z.number().int(),
  capabilities: z.object({ drainRestart: z.literal(true) }).strict(),
  state: z.enum(["open", "draining"]),
}).strict();
export type HostStatus = z.infer<typeof HostStatus>;

export const DrainRequest = z.object({
  expectedInstanceId: z.string().min(1),
  targetVersion: z.string().min(1),
  graceMs: GraceMs.default(DEFAULT_GRACE_MS),
}).strict();
export type DrainRequest = z.infer<typeof DrainRequest>;

export const DrainAnswer = z.union([
  z.object({ drained: z.literal(true), inFlight: z.literal(0), projectionsIdle: z.literal(true) }).strict(),
  z.object({ drained: z.literal(false), inFlight: z.number().int().min(0), projectionsIdle: z.boolean() }).strict(),
  z.object({ ok: z.literal(false), class: z.enum(["instance_mismatch", "draining", "unauthenticated", "invalid_request"]) }).strict(),
]);
export type DrainAnswer = z.infer<typeof DrainAnswer>;
