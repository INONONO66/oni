import type { OwnerLoginWithTelegram } from "@oni/channels";
import { TelegramOwnerCredentials } from "@oni/channels";
import { CliError } from "./errors";
import type { Ask } from "./onboard";

export interface TelegramLoginEnvironment {
  readonly apiId?: string;
  readonly apiHash?: string;
  readonly dataDir: string;
  readonly isTTY: boolean;
}

const ACTIONS = {
  phone: "Phone number",
  code: "Telegram code",
  password: "Telegram password",
  email: "Email address",
  email_code: "Email code",
} as const;

export async function telegramSignIn(
  login: OwnerLoginWithTelegram["telegram"],
  environment: TelegramLoginEnvironment,
  ask: Ask,
): Promise<{ readonly credential: TelegramOwnerCredentials; readonly userId: string }> {
  if (!environment.isTTY) throw new CliError("Telegram login requires an interactive terminal");
  const apiId = environment.apiId ?? await ask("Telegram API id", { required: true });
  const apiHash = environment.apiHash ?? await ask("Telegram API hash", { required: true, secret: true });
  const parsed = TelegramOwnerCredentials.safeParse({ apiId, apiHash });
  if (!parsed.success) throw new CliError("Invalid Telegram API credentials");
  const result = await login({
    credentials: parsed.data,
    dataDir: environment.dataDir,
    prompt: (action) => ask(ACTIONS[action], { required: true, secret: true }),
  });
  return { credential: parsed.data, userId: result.userId };
}
