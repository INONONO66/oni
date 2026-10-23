import type { Auth } from "../auth";
import type { Decision } from "./decide";

export interface CredentialSlot {
  readonly provider: string;
  readonly auth: Auth.Info;
}

export interface CredentialState {
  readonly blockedUntil: number;
  readonly probing: boolean;
}

export const ready: CredentialState = { blockedUntil: 0, probing: false };

export function lease(state: CredentialState, now: number): CredentialState | undefined {
  if (state.probing || state.blockedUntil > now) return undefined;
  return state.blockedUntil === 0 ? state : { ...state, probing: true };
}

export function block(
  reason: NonNullable<Decision["block"]>,
  now: number,
  hintMs?: number,
): CredentialState {
  const delay = reason === "transient" ? 0 : hintMs ?? 60_000;
  return { blockedUntil: now + delay, probing: false };
}
