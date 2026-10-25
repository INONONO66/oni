const TAPS = 63;
const CUTOFF = 10_000 / 48_000;

// 63-tap Blackman-windowed sinc, normalized for unit DC gain at 48 kHz.
const coefficients = (() => {
  const values = new Float64Array(TAPS);
  const center = (TAPS - 1) / 2;
  let sum = 0;
  for (let i = 0; i < TAPS; i++) {
    const distance = i - center;
    const sinc = distance === 0
      ? 2 * CUTOFF
      : Math.sin(2 * Math.PI * CUTOFF * distance) / (Math.PI * distance);
    const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (TAPS - 1))
      + 0.08 * Math.cos(4 * Math.PI * i / (TAPS - 1));
    values[i] = sinc * window;
    sum += sinc * window;
  }
  for (let i = 0; i < TAPS; i++) values[i] = (values[i] ?? 0) / sum;
  return values;
})();

function sample(value: number): number {
  const rounded = Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
  return Math.max(-32_768, Math.min(32_767, rounded));
}

function aligned(pending: Uint8Array, chunk: Uint8Array, frameBytes: number): {
  readonly frames: DataView;
  readonly rest: Uint8Array;
} {
  const bytes = new Uint8Array(pending.length + chunk.length);
  bytes.set(pending);
  bytes.set(chunk, pending.length);
  const complete = bytes.length - bytes.length % frameBytes;
  return {
    frames: new DataView(bytes.buffer, 0, complete),
    rest: bytes.slice(complete),
  };
}

export function createDownsampler(): { push(chunk: Uint8Array): Uint8Array } {
  const history = new Float64Array(TAPS);
  let position = 0;
  let phase = 0;
  let pending: Uint8Array = new Uint8Array(0);

  return {
    push(chunk) {
      if (chunk.length === 0) return new Uint8Array(0);
      const { frames, rest } = aligned(pending, chunk, 4);
      pending = rest;
      const output = new Uint8Array(Math.ceil(frames.byteLength / 8) * 2);
      const view = new DataView(output.buffer);
      let written = 0;
      for (let offset = 0; offset < frames.byteLength; offset += 4) {
        const left = frames.getInt16(offset, true);
        const right = frames.getInt16(offset + 2, true);
        history[position] = sample((left + right) / 2);
        position = (position + 1) % TAPS;
        phase ^= 1;
        if (phase === 0) {
          let value = 0;
          for (let tap = 0; tap < TAPS; tap++) {
            value += (coefficients[tap] ?? 0) * (history[(position + TAPS - 1 - tap) % TAPS] ?? 0);
          }
          view.setInt16(written, sample(value), true);
          written += 2;
        }
      }
      return output.subarray(0, written);
    },
  };
}

export function createUpsampler(): { push(chunk: Uint8Array): Uint8Array } {
  const history = new Float64Array(TAPS);
  let position = 0;
  let pending: Uint8Array = new Uint8Array(0);

  return {
    push(chunk) {
      if (chunk.length === 0) return new Uint8Array(0);
      const { frames, rest } = aligned(pending, chunk, 2);
      pending = rest;
      const output = new Uint8Array(frames.byteLength * 4);
      const view = new DataView(output.buffer);
      for (let offset = 0; offset < frames.byteLength; offset += 2) {
        history[position] = frames.getInt16(offset, true);
        position = (position + 1) % TAPS;
        for (let phase = 0; phase < 2; phase++) {
          let value = 0;
          for (let tap = phase; tap < TAPS; tap += 2) {
            value += 2 * (coefficients[tap] ?? 0)
              * (history[(position + TAPS - 1 - (tap - phase) / 2) % TAPS] ?? 0);
          }
          const outputOffset = offset * 4 + phase * 4;
          const pcm = sample(value);
          view.setInt16(outputOffset, pcm, true);
          view.setInt16(outputOffset + 2, pcm, true);
        }
      }
      return output;
    },
  };
}
