import type { ChildLifecycleEvidence, Machine } from "@oni/protocol";
type Phase = ChildLifecycleEvidence["phase"];

export function phaseOf(record: Machine.AgentTranscriptRecord): Phase | undefined {
  switch (record.kind) {
    case "turn":
      return record.role === "assistant" ? "terminal" : "observed";
    case "tool_call":
      return "requested";
    case "tool_result":
      return "result";
    case "corrupt":
    case "truncated":
      return undefined;
  }
}
