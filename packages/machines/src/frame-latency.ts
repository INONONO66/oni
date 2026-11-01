/** One displayed frame; `reconnectedAt` marks the first frame after a reconnection. */
export interface DisplayedFrame {
  readonly seq: number;
  readonly capturedAt: number;
  readonly displayAt: number;
  readonly reconnectedAt?: number;
}

export interface FrameLatency {
  readonly frames: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly reconnectFirstFreshFrameMs: number | null;
  readonly dropped: number;
}

/** Nearest-rank percentiles in milliseconds, with gaps in sidecar seqs counted as drops. */
export function frameLatency(frames: readonly DisplayedFrame[]): FrameLatency {
  const latencies = frames.map(({ capturedAt, displayAt }) => displayAt - capturedAt).sort((a, b) => a - b);
  const percentile = (share: number): number | null =>
    latencies[Math.ceil(latencies.length * share) - 1] ?? null;
  let dropped = 0;
  let previous: number | undefined;
  let reconnectFirstFreshFrameMs: number | null = null;
  let reconnectAt: number | undefined;
  for (const frame of frames) {
    if (previous !== undefined && frame.seq > previous + 1) dropped += frame.seq - previous - 1;
    previous = frame.seq;
    if (frame.reconnectedAt !== undefined) reconnectAt = frame.reconnectedAt;
    if (reconnectAt !== undefined && frame.capturedAt >= reconnectAt) {
      if (reconnectFirstFreshFrameMs === null) reconnectFirstFreshFrameMs = frame.displayAt - reconnectAt;
      reconnectAt = undefined;
    }
  }
  return { frames: frames.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), reconnectFirstFreshFrameMs, dropped };
}
