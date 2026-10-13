import type { ApiFailure } from "../error";

type Delay = { ms: number; directive: boolean };

/** Explicit directives outrank inferred reset buckets; `now` is injected so header-relative waits are reproducible. */
export function headerDelay(error: ApiFailure | undefined, now: () => number): Delay | undefined {
  const raw = error?.responseHeaders;
  if (raw === undefined) return undefined;
  // Fetch normalizes header names to lowercase, but fixtures and proxies may not.
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) headers[name.toLowerCase()] = value;
  const directive = directiveDelay(headers, now);
  return directive === undefined ? resetDelay(headers, now) : { ms: directive, directive: true };
}

function directiveDelay(headers: Record<string, string>, now: () => number): number | undefined {
  const milliseconds = Number.parseFloat(headers["retry-after-ms"] ?? "");
  return Number.isNaN(milliseconds) ? retryAfterDelay(headers["retry-after"], now) : milliseconds;
}

function retryAfterDelay(value: string | undefined, now: () => number): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseFloat(value);
  return Number.isNaN(seconds) ? futureTimestamp(value, now) : Math.ceil(seconds * 1000);
}

function futureTimestamp(value: string, now: () => number): number | undefined {
  const ms = Date.parse(value) - now();
  return ms > 0 ? Math.ceil(ms) : undefined;
}

function resetDelay(headers: Record<string, string>, now: () => number): Delay | undefined {
  const resets = Object.entries(headers)
    .filter(([name]) => /^(anthropic-ratelimit|x-ratelimit)-.*reset/.test(name))
    .map(([, value]) => parseResetValue(value, now))
    .filter((reset) => reset !== undefined);
  return resets.length === 0 ? undefined : { ms: Math.min(...resets), directive: false };
}

function parseResetValue(value: string, now: () => number): number | undefined {
  const duration = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/.exec(value.trim());
  if (duration && duration[0] !== "") return durationMilliseconds(duration);
  // Bare numbers are not timestamps (Date.parse would accept them as years).
  return /[-T:]/.test(value) ? futureTimestamp(value, now) : undefined;
}

const DURATION_UNIT_MS = [3_600_000, 60_000, 1000, 1] as const;

function durationMilliseconds(match: RegExpExecArray): number {
  return DURATION_UNIT_MS.reduce(
    (total, unit, index) => total + Math.ceil(Number(match[index + 1] ?? "0") * unit),
    0,
  );
}
