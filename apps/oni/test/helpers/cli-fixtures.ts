import type { ExecResult } from "../../src/cli/daemon";
import type { DoctorReport } from "../../src/cli/doctor";

export function failedSystemdStop(active: ExecResult, enabled?: ExecResult, error = "boom") {
  return (argv: readonly string[]): ExecResult => {
    if (argv[2] === "disable") return { code: 1, stdout: "", stderr: error };
    if (argv[2] === "is-active") return active;
    if (argv[2] === "is-enabled" && enabled !== undefined) return enabled;
    return { code: 0, stdout: "", stderr: "" };
  };
}

export function doctorStatuses(report: DoctorReport) {
  return new Map(report.checks.map((check) => [check.name, check.status]));
}
