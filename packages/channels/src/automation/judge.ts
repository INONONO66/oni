import { Effect } from "effect";
import type { Ingress } from "@openomni/protocol";
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
    const preliminary = match(records, input, ports);
    const verdicts = new Map<string, { verdict: "yes" | "no" | "unknown"; reason: string }>();
    for (const row of preliminary.rows) {
      if (row.stage !== "automation" || row.reason !== "runWhen") continue;
      const record = records.find((candidate) => `automation/${candidate.id}` === row.by);
      if (record?.runWhen === undefined || judge === undefined) continue;
      const verdict = yield* judge(record.runWhen, input);
      verdicts.set(record.runWhen, { verdict, reason: `judge_${verdict}` });
    }
    return match(records, input, { ...ports, judge: (question) =>
      verdicts.get(question) ?? { verdict: "unknown", reason: "judge_unavailable" } });
  });
}
