export interface Pin {
  readonly primary: string;
  readonly candidate: string;
  readonly credential?: string;
  readonly turn: string;
  readonly reason?: "refusal" | "billing";
}

export function order(selectors: readonly string[], pin: Pin | undefined, request: {
  readonly primary: string;
  readonly turn: string;
}): readonly string[] {
  if (pin === undefined || pin.primary !== request.primary || !selectors.includes(pin.candidate)) return selectors;
  if (pin.turn !== request.turn && pin.reason !== "billing") return selectors;
  return [pin.candidate, ...selectors.filter((selector) => selector !== pin.candidate)];
}

export function touch(previous: Pin | undefined, selected: Pin): Pin {
  return {
    ...selected,
    ...(previous?.primary === selected.primary && previous.candidate === selected.candidate
      && previous.reason !== undefined ? { reason: previous.reason } : {}),
  };
}
