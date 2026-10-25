import { expect, test } from "bun:test";
import { createDownsampler, createUpsampler } from "../src/composition/live-pcm";

function mono(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setInt16(index * 2, value, true);
  });
  return bytes;
}

function stereo(values: readonly (readonly [number, number])[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach(([left, right], index) => {
    view.setInt16(index * 4, left, true);
    view.setInt16(index * 4 + 2, right, true);
  });
  return bytes;
}

function samples(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.length / 2 }, (_, index) => view.getInt16(index * 2, true));
}

function pushSplit(
  convert: { push(chunk: Uint8Array): Uint8Array },
  bytes: Uint8Array,
  sizes: readonly number[],
): Uint8Array {
  const parts: Uint8Array[] = [];
  let sizeIndex = 0;
  for (let offset = 0; offset < bytes.length;) {
    const end = Math.min(bytes.length, offset + (sizes[sizeIndex % sizes.length] ?? 1));
    parts.push(convert.push(bytes.subarray(offset, end)));
    offset = end;
    sizeIndex++;
  }
  return Uint8Array.from(parts.flatMap((part) => Array.from(part)));
}

function sine(frequency: number, rate: number, count: number, amplitude = 12_000): number[] {
  return Array.from(
    { length: count },
    (_, index) => Math.round(amplitude * Math.sin(2 * Math.PI * frequency * index / rate)),
  );
}

function rms(values: readonly number[]): number {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
}

function db(output: readonly number[], input: readonly number[]): number {
  return 20 * Math.log10(rms(output) / rms(input));
}

test("downsampler preserves bytes across partial stereo frames and decimation phases", () => {
  const input = stereo(Array.from({ length: 301 }, (_, i) => [i * 37 - 4000, 5000 - i * 27] as const));
  const expected = createDownsampler().push(input);
  for (const boundaries of [[1], [2], [3], [1, 2, 3, 7, 5]]) {
    expect(pushSplit(createDownsampler(), input, boundaries)).toEqual(expected);
  }
  expect(expected.length).toBe(Math.floor(301 / 2) * 2);
  const convert = createDownsampler();
  expect(convert.push(input.subarray(0, 7)).length).toBe(0);
  expect(convert.push(input.subarray(7, 16)).length).toBe(4);
  expect(convert.push(input.subarray(16, 20)).length).toBe(0);
  expect(convert.push(new Uint8Array(0))).toEqual(new Uint8Array(0));
});

test("upsampler preserves bytes across odd sample boundaries and doubles frames", () => {
  const input = mono(sine(1000, 24_000, 301));
  const expected = createUpsampler().push(input);
  for (const boundaries of [[1], [2], [3], [1, 2, 3, 7, 5]]) {
    expect(pushSplit(createUpsampler(), input, boundaries)).toEqual(expected);
  }
  expect(expected.length).toBe(301 * 8);
  const convert = createUpsampler();
  expect(convert.push(input.subarray(0, 1)).length).toBe(0);
  expect(convert.push(input.subarray(1, 4)).length).toBe(16);
  expect(convert.push(new Uint8Array(0))).toEqual(new Uint8Array(0));
  const values = samples(expected);
  for (let i = 0; i < values.length; i += 2) expect(values[i]).toBe(values[i + 1]);
});

test("both filters settle to unity DC and clip int16 extremes without wrapping", () => {
  for (const level of [-32_768, 32_767]) {
    const down = samples(createDownsampler().push(stereo(Array.from({ length: 512 }, () => [level, level]))));
    const up = samples(createUpsampler().push(mono(Array.from({ length: 256 }, () => level))));
    for (const value of down.slice(128)) expect(Math.abs(value - level)).toBeLessThanOrEqual(1);
    for (const value of up.slice(256)) expect(Math.abs(value - level)).toBeLessThanOrEqual(1);
    for (const value of [...down, ...up]) {
      expect(value).toBeGreaterThanOrEqual(-32_768);
      expect(value).toBeLessThanOrEqual(32_767);
    }
  }
});

test("opposed stereo channels cancel exactly", () => {
  const wave = sine(1000, 48_000, 512);
  const output = samples(createDownsampler().push(stereo(
    wave.map((value) => [value, -value]),
  )));
  expect(output.every((value) => value === 0)).toBe(true);
});

test("downsampler keeps 1 kHz amplitude and rejects 15 kHz alias energy", () => {
  const measure = (frequency: number) => {
    const original = sine(frequency, 48_000, 8192);
    const output = samples(createDownsampler().push(stereo(original.map((value) => [value, value]))));
    return db(output.slice(256), original.slice(512).filter((_, i) => i % 2 === 0));
  };
  const passbandDb = measure(1000);
  const stopbandDb = measure(15_000);
  console.log(`PCM passband 1 kHz: ${passbandDb.toFixed(3)} dB; stopband 15 kHz: ${stopbandDb.toFixed(3)} dB`);
  expect(Math.abs(passbandDb)).toBeLessThanOrEqual(0.5);
  expect(stopbandDb).toBeLessThanOrEqual(-40);
});

test("one kilohertz round trip retains correlated waveform after group delay", () => {
  const input = sine(1000, 24_000, 4096);
  const output = samples(createDownsampler().push(createUpsampler().push(mono(input))));
  const start = 256;
  const correlations = Array.from({ length: 9 }, (_, offset) => {
    const delay = 27 + offset;
    let product = 0;
    let inputPower = 0;
    let outputPower = 0;
    for (let i = start; i < input.length - 64; i++) {
      const source = input[i] ?? 0;
      const result = output[i + delay] ?? 0;
      product += source * result;
      inputPower += source * source;
      outputPower += result * result;
    }
    return product / Math.sqrt(inputPower * outputPower);
  });
  const correlation = Math.max(...correlations);
  console.log(`PCM round-trip 1 kHz correlation: ${correlation.toFixed(6)}`);
  expect(correlation).toBeGreaterThanOrEqual(0.99);
});
