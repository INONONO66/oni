// Testing namespace surface (#1247): test-only session harness.
export { session } from "./registry";
export { openLedgerPlane } from "../core/host";
// #1346 M6: fixtures that never boot the cluster adopt a session's fence
// through the core's one takeover fold, never a copy of its CAS.
export { adoptSessionAuthority } from "../core/run";
