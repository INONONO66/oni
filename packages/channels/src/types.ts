import type { Channel, BusEvent, Outbound } from "@oni/protocol";
import type { Effect } from "effect";

/**
 * Observation port: channel code reports Operational telemetry through this
 * injected function instead of importing the session Bus directly. The
 * composition root (bootstrap/channels.ts) binds it to Bus.publish; tests bind a
 * collector or noop. #499 promotes this to the Channel protocol contract.
 */
export type PublishPort = BusEvent.Sink["publish"];

/**
 * The bytes behind one outbound media part, with the name and mime the
 * platform upload names them by.
 */
export interface MediaBytes {
  readonly bytes: Uint8Array;
  readonly name: string;
  readonly mime: string;
}

/**
 * Resolves an image or file part's `ref` (a path on the attached machine or
 * an https URL) to its bytes at delivery time. The composition root owns
 * this: drivers never read a filesystem or fetch beyond their platform API.
 */
export type MediaResolver = (part: Outbound.Part & { kind: "image" | "file" }) => Promise<MediaBytes>;

/**
 * The composition root's bounds on one authenticated download: the most
 * bytes it will store and the signal that abandons the platform call.
 */
export interface AttachmentBounds {
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}

/**
 * Fetches one inbound attachment's bytes by the reference the driver's
 * normalizer put on the message, through the platform's own authenticated
 * download, refusing with a typed error once the bytes exceed the bounds; a
 * driver whose references are public URLs offers none.
 */
export type AttachmentFetch = (ref: string, bounds: AttachmentBounds) => Promise<MediaBytes>;

/**
 * Raw platform payload → Channel.InboundMessage.
 * MUST NOT: call platform API, manage state, or have side effects.
 * Pure transformation function — same input always produces same output.
 */
export interface InboundNormalizer<TPayload> {
  normalize(payload: TPayload): Channel.InboundMessage | null;
}

/**
 * Executes one channel Effect program on the app runtime and settles with its
 * typed outcome. Channel code composes Effect programs (schedules, fibers,
 * deadlines) but never owns a runner — the composition root injects this port
 * (production: the app's managed runtime; tests: the package test runner, with
 * TestClock when the program sleeps).
 */
export type EffectRunner = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
