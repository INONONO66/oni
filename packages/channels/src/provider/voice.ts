/**
 * The voice route a provider exposes when it can join a voice channel. The
 * handle speaks raw PCM, never a platform's opcodes: the provider owns its
 * gateway, codec and encryption, the composing app owns the call.
 */

export type VoiceEvent =
  | { readonly type: "ready" }
  | { readonly type: "disconnected"; readonly reason: string }
  | { readonly type: "speaker_left"; readonly externalId: string }
  | { readonly type: "error"; readonly reason: string };

export interface PcmVoiceHandle {
  /** The selected speaker's audio: s16le, 48_000 Hz, interleaved stereo, 4 bytes per sample frame. */
  readonly pcmIn: AsyncIterable<Uint8Array>;
  /** Playback in the same format, ordered and bounded; rejects after `leave`. */
  readonly pcmOut: { write(pcm: Uint8Array): Promise<void> };
  readonly events: AsyncIterable<VoiceEvent>;
  leave(): Promise<void>;
}

/**
 * Joins one voice channel on the started surface. A provider that needs a
 * speaker refuses typed when the address lacks one; a workspace (guild) the
 * provider can read from the channel itself may be omitted.
 */
export type ProviderVoiceRoute = (input: {
  readonly surface: string;
  readonly channelId: string;
  readonly workspaceId?: string;
  readonly speakerExternalId?: string;
  readonly signal?: AbortSignal;
}) => Promise<PcmVoiceHandle>;
