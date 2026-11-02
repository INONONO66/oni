import { createHash } from "node:crypto";
import { Machine } from "@oni/protocol";
import { Context, Effect, Option } from "effect";
import { type MachineError, MachinesFailure } from "./errors";
import { decodeMachineFailure } from "./failure";

/** The caller's session-owned output store; capture pixels are written here, never into a JSON value. */
export interface CaptureOutputStore {
  readonly put: (write: { readonly outputId: string; readonly bytes: Uint8Array; readonly mediaType: string }) => void;
  readonly get: (outputId: string) => { readonly bytes: Uint8Array } | undefined;
}

export class CaptureOutputs extends Context.Service<CaptureOutputs, CaptureOutputStore>()("@oni/machines/CaptureOutputs") {}

export type CaptureEnvelope = Extract<Machine.ScreenCaptureResult, { status: "ok" }>;

/** The envelope fields a peer capture reply carries; absent peer measurements become null. */
export function captureMetadata(reply: Extract<Machine.PeerScreenCapture, { status: "ok" }>): Omit<CaptureEnvelope, "bytes" | "sha256"> {
  return {
    status: "ok", captureId: reply.captureId, display: reply.display,
    width: reply.width, height: reply.height, format: reply.format,
    scale: reply.scale ?? null, capturedAtUs: reply.capturedAtUs ?? null,
    ...(reply.accessibilityUnavailable === undefined ? {} : { accessibilityUnavailable: reply.accessibilityUnavailable }),
  };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The IHDR dimensions of a PNG, or undefined when the bytes carry no PNG header. */
export function pngDimensions(data: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  const png = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (png.byteLength < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function bound(operation: string): Effect.Effect<CaptureOutputs["Service"], MachinesFailure> {
  return Effect.serviceOption(CaptureOutputs).pipe(Effect.flatMap((outputs) => Option.isSome(outputs)
    ? Effect.succeed(outputs.value)
    : Effect.fail(new MachinesFailure({ operation, cause: "session output store is not bound" }))));
}

/** Stores the encoded frame under `sha256:<hex>` and answers the envelope that names it. */
export function storeCapture(
  metadata: Omit<CaptureEnvelope, "bytes" | "sha256">,
  data: Uint8Array,
): Effect.Effect<CaptureEnvelope, MachineError> {
  return Effect.gen(function* () {
    const outputs = yield* bound("screen.capture.store");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const envelope = yield* Effect.try({
      try: () => Machine.ScreenCaptureResult.options[0].parse({ ...metadata, bytes: data.byteLength, sha256 }),
      catch: decodeMachineFailure("screen.capture.envelope"),
    });
    yield* Effect.try({
      try: () => outputs.put({ outputId: `sha256:${sha256}`, bytes: data, mediaType: `image/${envelope.format}` }),
      catch: decodeMachineFailure("screen.capture.store"),
    });
    return envelope;
  });
}

/** Reads back the frame an envelope names from the same session store. */
export function captureData(sha256: string): Effect.Effect<Buffer, MachinesFailure> {
  return bound("screen.capture.read").pipe(Effect.flatMap((outputs) => {
    const output = outputs.get(`sha256:${sha256}`);
    return output === undefined
      ? Effect.fail(new MachinesFailure({ operation: "screen.capture.read", cause: `missing output sha256:${sha256}` }))
      : Effect.succeed(Buffer.from(output.bytes));
  }));
}
