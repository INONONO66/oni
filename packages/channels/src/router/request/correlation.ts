import type { SessionTransition } from "@oni/protocol";

interface Candidate {
  readonly key: `request:${string}`;
  readonly request: SessionTransition.Request;
}
export type RequestResolution =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "match"; candidate: Candidate }>
  | Readonly<{ kind: "ambiguous"; candidates: readonly Candidate[] }>;

/** Physical precedence only. Terminal requests remain visible to kernel admission. */
export function findRequestCandidates(
  requests: readonly SessionTransition.Request[],
  correlation: SessionTransition.Correlation | undefined,
): RequestResolution {
  if (correlation === undefined) return { kind: "none" };
  const levels: SessionTransition.Correlation[] = [];
  for (const replyToMessageId of new Set([
    ...(correlation.replyToMessageId === undefined ? [] : [correlation.replyToMessageId]),
    ...(correlation.chain ?? []),
  ]))
    levels.push({ replyToMessageId });
  if (correlation.threadId) levels.push({ threadId: correlation.threadId });
  if (correlation.tokenHash) levels.push({ tokenHash: correlation.tokenHash });
  if (correlation.externalConversationId)
    levels.push({ externalConversationId: correlation.externalConversationId });
  else if (correlation.endpointId && correlation.channelId)
    levels.push({ endpointId: correlation.endpointId, channelId: correlation.channelId });
  for (const query of levels) {
    const matches = requests.filter(
      (request) =>
        Object.entries(query).every(
          ([key, value]) =>
            request.correlation[key as keyof SessionTransition.Correlation] === value,
        ) &&
        (request.correlation.channelId === undefined ||
          request.correlation.channelId === correlation.channelId) &&
        (request.expectedResponders.length > 1 ||
          request.correlation.endpointId === undefined ||
          request.correlation.endpointId === correlation.endpointId),
    );
    const candidates = [
      ...new Map(
        matches.map((request) => [
          request.requestId,
          { key: `request:${request.requestId}` as const, request },
        ]),
      ).values(),
    ].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const [candidate] = candidates;
    if (candidate && candidates.length === 1) return { kind: "match", candidate };
    if (candidates.length > 1) return { kind: "ambiguous", candidates };
  }
  return { kind: "none" };
}
