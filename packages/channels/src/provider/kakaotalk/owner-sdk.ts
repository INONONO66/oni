import {
  classifyKakaoChat,
  KAKAO_MESSAGE_TYPE,
  KakaoTalkClient,
  KakaoTalkError,
  KakaoTalkListener,
  loginFlow,
} from "agent-messenger/kakaotalk";
import type { KakaoTalkListenerEventMap, KakaoTalkPushMessageEvent } from "agent-messenger/kakaotalk";

/**
 * The slice of the agent-messenger KakaoTalk SDK the Owner instance speaks
 * (#1569 lane 7): the account session (an OAuth token for a registered
 * device, in memory), the LOCO push listener, chat lookups for the DM /
 * group distinction, sends and typing. The SDK's `connect()` keeps the
 * LOCO sync state (no secret) under `AGENT_MESSENGER_CONFIG_DIR`; nothing
 * else of the SDK's store is used. The SDK classes satisfy these shapes
 * structurally; tests pass scripted fakes.
 */
export interface KakaoTalkOwnerApi {
  login(credentials: {
    oauthToken: string;
    userId: string;
    deviceUuid?: string;
    deviceType?: KakaoTalkDeviceType;
  }): Promise<object>;
  /** The account's own profile: its nickname is what a mention of the Owner names. */
  getProfile(): Promise<{ user_id: string; nickname: string }>;
  /** One chat's shape: `active_members` of two is a direct chat with one person. */
  getChat(chatId: string): Promise<{ type: number | string; active_members: number }>;
  sendMessage(chatId: string, text: string): Promise<{ success: boolean; status_code: number; log_id: string }>;
  sendPhoto(chatId: string, photo: Uint8Array, filename?: string): Promise<{ success: boolean; status_code: number; log_id: string }>;
  sendVideo(chatId: string, video: Uint8Array, filename?: string): Promise<{ success: boolean; status_code: number; log_id: string }>;
  sendAudio(chatId: string, audio: Uint8Array, filename?: string): Promise<{ success: boolean; status_code: number; log_id: string }>;
  sendFile(chatId: string, file: Uint8Array, filename: string, mimeType?: string): Promise<{ success: boolean; status_code: number; log_id: string }>;
  sendTyping(chatId: string): Promise<{ success: boolean }>;
  /** Closes the LOCO session; the listener's stop does not. */
  close(): void;
}

export type KakaoTalkDeviceType = "pc" | "tablet";

/** One pushed message as the SDK reports it. */
export type KakaoTalkMessage = KakaoTalkPushMessageEvent;

/** The SDK's push event map, re-exported so the surface never imports the SDK itself. */
export type KakaoTalkOwnerEventMap = KakaoTalkListenerEventMap;

export interface KakaoTalkOwnerEvents {
  on<K extends keyof KakaoTalkListenerEventMap>(
    event: K,
    listener: (...args: KakaoTalkListenerEventMap[K]) => void,
  ): this;
  start(): Promise<void>;
  stop(): void;
}

/** Construction seams: the real SDK in production, scripted fakes in tests. */
export interface KakaoTalkOwnerSdk {
  client(): KakaoTalkOwnerApi;
  listener(client: KakaoTalkOwnerApi): KakaoTalkOwnerEvents;
}

export function kakaoTalkOwnerSdk(): KakaoTalkOwnerSdk {
  return {
    client: () => new KakaoTalkClient(),
    // The listener only ever receives the client this same factory built.
    listener: (client) => new KakaoTalkListener(client as KakaoTalkClient),
  };
}

/** The SDK's own chat classification: a direct chat is the account plus one person. */
export function kakaoChatKind(chat: { type: number | string; active_members: number }): "dm" | "group" | "open" | "unknown" {
  return classifyKakaoChat(chat);
}

const MEDIA_KIND_OF_TYPE: ReadonlyMap<number, "image" | "video" | "audio" | "file"> = new Map([
  [KAKAO_MESSAGE_TYPE.PHOTO, "image"],
  [KAKAO_MESSAGE_TYPE.VIDEO, "video"],
  [KAKAO_MESSAGE_TYPE.AUDIO, "audio"],
  [KAKAO_MESSAGE_TYPE.FILE, "file"],
]);

/** The attachment kind a pushed message's LOCO type carries, if it carries one. */
export function kakaoMediaKind(messageType: number): "image" | "video" | "audio" | "file" | undefined {
  return MEDIA_KIND_OF_TYPE.get(messageType);
}

/** The SDK's error class: `code` names the refusal (`missing_token`, `not_authenticated`, `send_message_failed`, …). */
export { KakaoTalkError as KakaoTalkOwnerError };

/**
 * The Owner's own sign-in (#1569 lane 5b): email and password, then the
 * passcode the SDK shows through `onPasscode` and the Owner enters in the
 * KakaoTalk app registers this device; the OAuth token, user id and device
 * uuid the flow returns are the account session. Nothing is stored here.
 */
export interface KakaoTalkOwnerLoginInput {
  readonly email: string;
  readonly password: string;
  readonly deviceType?: KakaoTalkDeviceType;
  readonly onPasscode: (code: string) => void;
}

export async function kakaoTalkOwnerLogin(
  input: KakaoTalkOwnerLoginInput,
  flow: typeof loginFlow = loginFlow,
): Promise<{ oauthToken: string; userId: string; deviceUuid: string; deviceType: KakaoTalkDeviceType }> {
  const result = await flow({
    email: input.email,
    password: input.password,
    deviceType: input.deviceType ?? "tablet",
    onPasscodeDisplay: input.onPasscode,
  });
  const credentials = result.credentials;
  // The SDK's own verdict: a failed passcode request still carries empty credentials.
  if (!result.authenticated || credentials === undefined)
    throw new KakaoTalkError(
      result.message ?? "Login did not register this device",
      result.error ?? result.next_action ?? "login_incomplete",
    );
  return {
    oauthToken: credentials.access_token,
    userId: credentials.user_id,
    deviceUuid: credentials.device_uuid,
    deviceType: credentials.device_type,
  };
}
