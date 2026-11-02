export interface Circuit {
  readonly consecutiveOpens: number;
  readonly openUntil: number;
  readonly halfOpenLeased: boolean;
}

export const closed: Circuit = { consecutiveOpens: 0, openUntil: 0, halfOpenLeased: false };

export function open(
  state: Circuit,
  now: number,
  delay: { readonly hintMs?: number; readonly resetAt?: number } = {},
): Circuit {
  const consecutiveOpens = state.consecutiveOpens + 1;
  const cooldown = Math.min(60_000 * 2 ** Math.min(consecutiveOpens - 1, 5), 1_800_000);
  return {
    consecutiveOpens,
    openUntil: delay.resetAt ?? now + Math.max(cooldown, delay.hintMs ?? 0),
    halfOpenLeased: false,
  };
}

export function lease(state: Circuit, now: number): Circuit | undefined {
  if (state.halfOpenLeased || state.openUntil > now) return undefined;
  return state.consecutiveOpens === 0 ? state : { ...state, halfOpenLeased: true };
}
