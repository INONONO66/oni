// Testing namespace surface (#1247): test-only session harness.
export { session } from "./registry";
// #1345: the store plane without the host, for hermetic fixtures; `Core.openLedger` is the one product path.
export { openLedgerPlane } from "../core/host";
