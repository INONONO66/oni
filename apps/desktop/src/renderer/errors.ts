/**
 * The renderer's named failures (#1244). The desktop app is not an Effect
 * package, so expected-but-unactionable conditions and violated invariants
 * are thrown as instances of these classes; callers and tests discriminate
 * on the class, never on message prose.
 */

/** No usable gateway transport: not configured yet, or its socket never opened. */
export class GatewayUnavailableError extends Error {
  override readonly name = "GatewayUnavailableError";
}

/** The gateway transport was asked for a capability it does not implement. */
export class TransportCapabilityError extends Error {
  override readonly name = "TransportCapabilityError";
}

/** A renderer invariant broke (missing boot element, unhandled reducer effect): a programmer error. */
export class RendererInvariantError extends Error {
  override readonly name = "RendererInvariantError";
}
