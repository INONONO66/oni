import type { Token } from "@oni/protocol";
import type { FailureClass } from "../port";

export type Phase = "pre_request" | "streaming";
export type Decision = {
  readonly action: "abort" | "surface" | "swap_credential" | "swap_model";
  readonly pin?: "refusal";
  readonly block?: "auth" | "billing" | "rate_limit" | "transient";
};

export function decide(failure: FailureClass, phase: Phase, retryAfterHintMs?: number): Decision {
  if (failure.kind === "aborted") return { action: "abort" };
  if (phase === "streaming" || failure.kind === "overflow") return { action: "surface" };
  if (failure.providerReason === "content_policy") return { action: "surface", pin: "refusal" };
  if (failure.providerReason === "billing") return { action: "swap_credential", block: "billing" };
  if (failure.kind === "terminal") {
    if (failure.status === 401 || failure.status === 403) return { action: "swap_credential", block: "auth" };
    if (failure.status === 404 || failure.detail === "unavailable") return { action: "swap_model" };
    return { action: "surface" };
  }
  if (failure.providerReason === "validation_error") return { action: "surface" };
  if (failure.providerReason === "rate_limit" || failure.providerReason === "overloaded") {
    return retryAfterHintMs !== undefined && retryAfterHintMs <= 2000
      ? { action: "surface" }
      : { action: "swap_credential", block: "rate_limit" };
  }
  return failure.reason === "timeout" || failure.instant
    ? { action: "swap_credential", block: "transient" }
    : { action: "surface" };
}

export interface RoutingFact {
  readonly candidate: string;
  readonly credential?: string;
  readonly failure?: FailureClass;
  readonly usage?: Token.ProviderUsage;
  readonly action: Decision["action"] | "try" | "selected" | "skip_circuit";
}

export interface RoutingFacts {
  readonly category: string;
  readonly requested: string;
  readonly selected?: string;
  readonly attempts: readonly RoutingFact[];
}
