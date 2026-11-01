import type { Machine } from "@oni/protocol";

const WINDOW = 8;

export interface ClockSample {
  readonly clockOffsetMs: number;
  readonly rttMs: number;
}

/** Selects the least delayed exchange among the most recent probes. */
export function clockSample(
  reply: Machine.PingResult,
  sentAt: number,
  receivedAt: number,
): ClockSample | undefined {
  if (reply.receivedAtUs === undefined || reply.sentAtUs === undefined ||
    reply.sentAtUs < reply.receivedAtUs || receivedAt < sentAt) return undefined;
  return {
    clockOffsetMs: (sentAt + receivedAt) / 2 - (reply.receivedAtUs + reply.sentAtUs) / 2000,
    rttMs: receivedAt - sentAt,
  };
}

export class ClockSamples {
  private readonly recent: ClockSample[] = [];

  add(sample: ClockSample): void {
    this.recent.push(sample);
    if (this.recent.length > WINDOW) this.recent.shift();
  }

  best(): ClockSample | undefined {
    return this.recent.reduce<ClockSample | undefined>(
      (best, sample) => best === undefined || sample.rttMs < best.rttMs ? sample : best,
      undefined,
    );
  }
}

export function capturedAt(capturedAtUs: number, offsetMs: number): number {
  return capturedAtUs / 1000 + offsetMs;
}
