import type {
  TelegramOwnerClient, TelegramOwnerHistoryPage, TelegramOwnerLoginAction,
  TelegramOwnerMessage, TelegramOwnerSdk, TelegramOwnerSendContent, TelegramOwnerState,
} from "../../src/provider/telegram/owner-sdk";
import { createTelegramProvider } from "../../src/provider/telegram/provider";
import { injectedOptions } from "./injected";

type State = { readonly state: TelegramOwnerLoginAction; readonly userId?: string };

export function ownerRuntime(sdk: TelegramOwnerSdk, telegramDataDir: string) {
  const arm = createTelegramProvider(undefined, sdk).owner;
  if (arm === undefined) throw new Error("missing Owner arm");
  return arm.create(
    { apiId: "123", apiHash: "a".repeat(32) },
    { intake: "all", autoReply: false }, () => undefined,
    { ...injectedOptions(), telegramDataDir },
  );
}

/** One scripted seam for login and the mounted provider; no native TDLib or credential store. */
export function fakeTelegramOwner(script: {
  readonly states?: readonly State[];
  readonly onStart?: (client: TelegramOwnerClient) => void | Promise<void>;
  readonly onSend?: (chatId: string, content: TelegramOwnerSendContent) => Promise<{
    readonly messageId: string;
    readonly botMessageId?: string;
  }>;
  readonly onHistory?: (chatId: string, before: string | undefined, limit: number) => TelegramOwnerHistoryPage;
  readonly onDownload?: (fileId: number, signal: AbortSignal) => Promise<{
    readonly chunks: AsyncIterable<Uint8Array>;
    readonly name: string;
    readonly mime: string;
    readonly size: number;
  }>;
  readonly onClose?: () => Promise<void>;
} = {}) {
  const calls: string[] = [];
  const sends: { chatId: string; content: TelegramOwnerSendContent }[] = [];
  const listeners = new Set<(message: TelegramOwnerMessage) => void>();
  const stateListeners = new Set<(state: TelegramOwnerState) => void>();
  let step = 0;
  const states = script.states ?? [{ state: "ready", userId: "owner-1" }];
  const client: TelegramOwnerClient = {
    onMessage(handler) {
      calls.push("subscribe");
      listeners.add(handler);
      return () => { calls.push("unsubscribe"); listeners.delete(handler); };
    },
    onState(handler) {
      calls.push("subscribe-state");
      stateListeners.add(handler);
      return () => { calls.push("unsubscribe-state"); stateListeners.delete(handler); };
    },
    async start(input) {
      calls.push("start");
      if (input.apiId !== 123 || input.apiHash !== "a".repeat(32)) throw new Error("credentials differed");
      await script.onStart?.(client);
      return states[step] ?? { state: "ready", userId: "owner-1" };
    },
    async authenticate(input) {
      calls.push(`authenticate:${Object.keys(input).join(",")}`);
      step++;
      return states[step] ?? { state: "ready", userId: "owner-1" };
    },
    async send(chatId, content) {
      calls.push("send");
      sends.push({ chatId, content });
      return script.onSend?.(chatId, content) ?? { messageId: "ack-1" };
    },
    async history(chatId, options) {
      calls.push("history");
      return script.onHistory?.(chatId, options.before, options.limit) ?? { messages: [] };
    },
    async download(fileId, options) {
      calls.push("download");
      if (script.onDownload === undefined) throw new Error("download not scripted");
      return script.onDownload(fileId, options.signal);
    },
    async close() { calls.push("close"); await script.onClose?.(); },
  };
  const sdk: TelegramOwnerSdk = { client: () => { calls.push("client"); return client; } };
  return {
    sdk, client, calls, sends,
    emit: (message: TelegramOwnerMessage) => { for (const listener of listeners) listener(message); },
    emitState: (state: TelegramOwnerState) => { for (const listener of stateListeners) listener(state); },
  };
}

export const ownerMessage: TelegramOwnerMessage = {
  chatId: "chat-1", messageId: "100", senderId: "sender-1",
  outgoing: false, text: "caption", dateSeconds: 123,
  dm: true, mentionedUserIds: [],
  media: [], replyToMessageId: "99",
  sender: { kind: "user", id: "sender-1", isBot: false },
};
