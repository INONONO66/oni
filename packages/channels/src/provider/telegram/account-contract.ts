import type { Channel } from "@oni/protocol";
import { z } from "zod";
import type { AttachmentFetchWithStream } from "../../types.js";
import type { AccountIdentity, ChannelProvider, ProviderDeliveryRoute } from "../contract.js";
import type { ProviderHistoryRoute } from "../history.js";
import type { TelegramAccountSdk } from "./account-sdk.js";
import type { TelegramSdk } from "./sdk.js";

/** String-valued credentials fit the existing channel declaration and vault wire. */
export const TelegramAccountCredentials = z.object({
  apiId: z.string().regex(/^[1-9]\d{0,9}$/).refine((value) => Number(value) <= 2_147_483_647),
  apiHash: z.string().regex(/^[a-fA-F0-9]{32}$/),
}).strict();
export type TelegramAccountCredentials = z.infer<typeof TelegramAccountCredentials>;

/** The implementation in account.ts owns lifecycle, not an alternative router. */
export interface TelegramAccountSurface extends Channel.Surface {
  readonly deliver: ProviderDeliveryRoute;
  readonly download: AttachmentFetchWithStream;
  readonly history: ProviderHistoryRoute;
  accountIdentity(): AccountIdentity | undefined;
  stop(traceId: string): Promise<void>;
}

/** Additive target signature; the current bot factory is not widened by the freeze. */
export type TelegramAccountProviderFactory = (
  botSdk?: TelegramSdk,
  accountSdk?: TelegramAccountSdk,
) => ChannelProvider<{ readonly token: string }, "telegram", TelegramAccountCredentials>;
