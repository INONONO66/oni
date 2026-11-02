import type { ApiFailure } from "./error";

type Delay = { ms: number; directive: boolean };

/** Explicit directives outrank inferred reset buckets; injected `now` keeps waits reproducible. */
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
  return integerToken(headers["retry-after-ms"]) ?? retryAfterDelay(headers["retry-after"], now);
}

/** Retry-After is delay-seconds or an IMF-fixdate; anything else (signs, fractions, hex, suffixes) is no directive. */
function retryAfterDelay(value: string | undefined, now: () => number): number | undefined {
  const seconds = integerToken(value);
  if (seconds !== undefined) return Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : undefined;
  return value !== undefined && IMF_FIXDATE.test(value) ? futureTimestamp(value, now) : undefined;
}

const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;

function integerToken(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
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
