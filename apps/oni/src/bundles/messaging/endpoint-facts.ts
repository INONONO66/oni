/**
 * The initiator's resolved endpoint as two `route.decided` facts. The fact
 * prefixes are persisted vocabulary (byte-frozen; they date from the retired
 * reply-grant materialization, #708) — a recorded decision replays equal only
 * if the same strings are derived — so the names stay while the consumer is
 * now the reply door's conversation binding (#1569).
 */

const ENDPOINT_CHANNEL_FACT_PREFIX = "reply_grant.endpoint.channel:";
const ENDPOINT_EXTERNAL_ID_FACT_PREFIX = "reply_grant.endpoint.external_id:";

export function endpointFacts(endpoint: Readonly<{ channel: string; externalId: string }>) {
  return [
    `${ENDPOINT_CHANNEL_FACT_PREFIX}${encodeURIComponent(endpoint.channel)}`,
    `${ENDPOINT_EXTERNAL_ID_FACT_PREFIX}${encodeURIComponent(endpoint.externalId)}`,
  ] as const;
}

export function endpointFromFacts(
  facts: readonly string[],
): Readonly<{ channel: string; externalId: string }> | undefined {
  const channels = facts.filter((fact) => fact.startsWith(ENDPOINT_CHANNEL_FACT_PREFIX));
  const externalIds = facts.filter((fact) => fact.startsWith(ENDPOINT_EXTERNAL_ID_FACT_PREFIX));
  if (channels.length !== 1 || externalIds.length !== 1) return undefined;
  try {
    const channel = decodeURIComponent(
      channels[0]?.slice(ENDPOINT_CHANNEL_FACT_PREFIX.length) ?? "",
    );
    const externalId = decodeURIComponent(
      externalIds[0]?.slice(ENDPOINT_EXTERNAL_ID_FACT_PREFIX.length) ?? "",
    );
    if (channel === "" || externalId === "") return undefined;
    return { channel, externalId };
  } catch {
    return undefined;
  }
}
