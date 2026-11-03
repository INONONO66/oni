import { createTelegramAccountClient, TelegramAccountError } from "agent-messenger/telegram";
import type {
  TelegramAccountClient,
  TelegramAccountErrorCode,
  TelegramAccountMessage,
  TelegramAccountState,
  TelegramHistoryPage,
  TelegramLoginAction,
  TelegramSendContent,
} from "agent-messenger/telegram";
import type { TelegramAccountCredentials } from "./account-contract.js";
import { z } from "zod";
import { accountSession } from "./account-custody.js";

export type { TelegramAccountClient };
export type { TelegramAccountMessage };
export type { TelegramAccountState };
export type TelegramAccountHistoryPage = TelegramHistoryPage;
export type TelegramAccountLoginAction = TelegramLoginAction;
export type TelegramAccountSendContent = TelegramSendContent;
export type { TelegramAccountErrorCode };
export { TelegramAccountError };

export function telegramAccountSdk(): TelegramAccountSdk {
  return { client: createTelegramAccountClient };
}

export interface TelegramAccountSdk {
  client(): TelegramAccountClient;
}

export interface TelegramAccountLoginInput {
  readonly credentials: TelegramAccountCredentials;
  readonly dataDir: string;
  readonly prompt: (action: Exclude<TelegramAccountLoginAction, "ready">) => Promise<string>;
}

/** The input already holds the API credential; the result contains no secret. */
export type TelegramAccountLogin = (
  input: TelegramAccountLoginInput,
) => Promise<{ readonly userId: string }>;

const LoginState = z.object({
  state: z.enum(["phone", "code", "password", "email", "email_code", "ready"]),
  userId: z.string().optional(),
});

export async function telegramAccountLogin(
  input: TelegramAccountLoginInput,
  sdk: TelegramAccountSdk = telegramAccountSdk(),
): Promise<{ readonly userId: string }> {
  const session = await accountSession(input.dataDir);
  let client: TelegramAccountClient | undefined;
  try {
    client = sdk.client();
    let result = LoginState.safeParse(await client.start({
      apiId: Number(input.credentials.apiId),
      apiHash: input.credentials.apiHash,
      databaseDir: session.databaseDir,
      filesDir: session.filesDir,
    }));
    for (;;) {
      if (!result.success) throw new TelegramAccountError("unsupported login state", "login_action_required");
      if (result.data.state === "ready") {
        if (!result.data.userId?.trim()) throw new TelegramAccountError("ready without an account", "session_lost");
        return { userId: result.data.userId };
      }
      const value = await input.prompt(result.data.state);
      if (!value.trim()) throw new TelegramAccountError("login step empty", "login_action_required");
      switch (result.data.state) {
        case "phone": result = LoginState.safeParse(await client.authenticate({ phone: value })); break;
        case "code": result = LoginState.safeParse(await client.authenticate({ code: value })); break;
        case "password": result = LoginState.safeParse(await client.authenticate({ password: value })); break;
        case "email": result = LoginState.safeParse(await client.authenticate({ email: value })); break;
        case "email_code": result = LoginState.safeParse(await client.authenticate({ emailCode: value })); break;
      }
    }
  } finally {
    // An unconfirmed native close keeps custody: its failure propagates and the lock stays held.
    await client?.close();
    await session.release();
  }
}
