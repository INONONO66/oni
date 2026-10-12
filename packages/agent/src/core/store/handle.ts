/**
 * The Core-public face of the session handle store (#1346): pure action
 * builders, fold projections and the kernel TYPE. The write doors —
 * `createSessionKernel`, `MaterializeInput`, `ConfigureAuthority` — stay
 * internal to core: external writers create sessions through
 * `Core.createSession` and commit through the Session entity's RPCs, while
 * `Core.openLedgerPlane(...).openKernel(id)` remains the one typed handle.
 */
export {
  configureAction,
  delivery,
  generationSnapshot,
  materializationSeed,
  openTurns,
  turnIntent,
  turnTerminal,
  type OpenTurn,
  type SessionKernel,
} from "./fence";
