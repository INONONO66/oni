import type { Policy } from "@oni/protocol";

interface ChannelAuthnDecision {
  /** The one timing the channel authn seam evaluates at (perimeter admission). */
  readonly timing: "run.start";
  readonly name: string;
  readonly policyId: string;
  readonly verdict: Policy.PolicyDecision["verdict"];
  readonly reason: string;
  readonly durationMs: number;
}

export type ChannelAuthnDecisionObserver = (decision: ChannelAuthnDecision) => void | Promise<void>;
