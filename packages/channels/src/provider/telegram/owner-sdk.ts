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
import type { TelegramOwnerCredentials } from "./owner-contract.js";
import { z } from "zod";
import { ownerSession } from "./owner-custody.js";

export type TelegramOwnerClient = TelegramAccountClient;
export type TelegramOwnerMessage = TelegramAccountMessage;
export type TelegramOwnerState = TelegramAccountState;
export type TelegramOwnerHistoryPage = TelegramHistoryPage;
export type TelegramOwnerLoginAction = TelegramLoginAction;
export type TelegramOwnerSendContent = TelegramSendContent;
export type TelegramOwnerErrorCode = TelegramAccountErrorCode;
export { TelegramAccountError as TelegramOwnerError };

export function telegramOwnerSdk(): TelegramOwnerSdk {
  return { client: createTelegramAccountClient };
}

export interface TelegramOwnerSdk {
  client(): TelegramOwnerClient;
}

export interface TelegramOwnerLoginInput {
  readonly credentials: TelegramOwnerCredentials;
  readonly dataDir: string;
  readonly prompt: (action: Exclude<TelegramOwnerLoginAction, "ready">) => Promise<string>;
}

/** The input already holds the API credential; the result contains no secret. */
export type TelegramOwnerLogin = (
  input: TelegramOwnerLoginInput,
) => Promise<{ readonly userId: string }>;

const LoginState = z.object({
  state: z.enum(["phone", "code", "password", "email", "email_code", "ready"]),
  userId: z.string().optional(),
});

export async function telegramOwnerLogin(
  input: TelegramOwnerLoginInput,
  sdk: TelegramOwnerSdk = telegramOwnerSdk(),
): Promise<{ readonly userId: string }> {
  const session = await ownerSession(input.dataDir);
  let client: TelegramOwnerClient | undefined;
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
