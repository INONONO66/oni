/** Test policy requiring Owner approval for the B tool invocation. */
export function approvalPolicy(name: string) {
  return {
    name,
    kind: "tool" as const,
    phase: "pre" as const,
    generation: 1,
    priority: 2000,
    match: { encodingVersion: 1 as const, value: { op: "B" } },
    verdict: {
      encodingVersion: 1 as const,
      value: { type: "require_approval" as const, reason: "owner" },
    },
  };
}
