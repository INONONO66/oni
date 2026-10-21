import { Effect } from "effect";
import type { Delivery } from "@oni/protocol";

export function recordingDelivery(commits: Delivery.Commit[]) {
  return {
    commit: (row: Delivery.Commit) => Effect.sync(() => {
      commits.push(row);
      return { ...row, status: "pending" as const, consumedBy: null, consumedAt: null, ordinal: 1 };
    }),
  };
}
