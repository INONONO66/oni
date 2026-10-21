import { Effect } from "effect";
import type { Ingress } from "@oni/protocol";
import type { ChannelError } from "../errors.js";
import { match, type MatchDecision, type MatchPorts } from "./matcher.js";

/** Resolve only structurally eligible questions before the pure final match. */
export function judgeAndMatch(
  records: readonly Ingress.Automation[],
  input: Ingress.Input,
  ports: Omit<MatchPorts, "judge">,
  judge?: (question: string, event: Ingress.Input) => Effect.Effect<"yes" | "no" | "unknown", ChannelError>,
): Effect.Effect<MatchDecision, ChannelError> {
  return Effect.gen(function* () {
    let result = match([], input, ports);
    for (const record of records) {
      let next = match([record], input, ports);
      if (next.rows.some((row) => row.reason === "runWhen") &&
          record.runWhen !== undefined && judge !== undefined) {
        const verdict = yield* judge(record.runWhen, input);
        next = match([record], input, {
          ...ports, judge: () => ({ verdict, reason: `judge_${verdict}` }),
        });
      }
      if (next.rows.length > 0) result = next;
      if (next.rows.some((row) => row.stage === "automation" && row.decision !== "filtered"))
        return next;
    }
    return result;
  });
}
