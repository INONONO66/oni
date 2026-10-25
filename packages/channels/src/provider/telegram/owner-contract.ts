import type { Channel } from "@oni/protocol";
import { z } from "zod";
import type { AttachmentFetchWithStream } from "../../types.js";
import type { AccountIdentity, ChannelProvider, ProviderDeliveryRoute } from "../contract.js";
import type { ProviderHistoryRoute } from "../history.js";
import type { TelegramOwnerSdk } from "./owner-sdk.js";
import type { TelegramSdk } from "./sdk.js";

/** String-valued credentials fit the existing channel declaration and vault wire. */
export const TelegramOwnerCredentials = z.object({
  apiId: z.string().regex(/^[1-9]\d{0,9}$/).refine((value) => Number(value) <= 2_147_483_647),
  apiHash: z.string().regex(/^[a-fA-F0-9]{32}$/),
}).strict();
export type TelegramOwnerCredentials = z.infer<typeof TelegramOwnerCredentials>;

/** The implementation in owner.ts owns lifecycle, not an alternative router. */
export interface TelegramOwnerSurface extends Channel.Surface {
  readonly id: "telegram:owner";
  readonly deliver: ProviderDeliveryRoute;
  readonly download: AttachmentFetchWithStream;
  readonly history: ProviderHistoryRoute;
  accountIdentity(): AccountIdentity | undefined;
  stop(traceId: string): Promise<void>;
}

/** Additive target signature; the current bot factory is not widened by the freeze. */
export type TelegramOwnerProviderFactory = (
  botSdk?: TelegramSdk,
  ownerSdk?: TelegramOwnerSdk,
) => ChannelProvider<{ readonly token: string }, "telegram", TelegramOwnerCredentials>;
