/**
 * The Core-public face of the session handle store: pure action builders,
 * fold projections and the kernel TYPE. `createSessionKernel` stays internal.
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
