import type { Channel } from "@oni/protocol";
import { Dedupe } from "../support/dedupe";
import { DeliveryReconciliation } from "../support/deliver";

export abstract class BotState {
  protected readonly dedupe: Dedupe;
  protected readonly outbound = new DeliveryReconciliation();
  protected handler: Channel.MessageHandler | null = null;

  protected constructor(now: () => number) {
    this.dedupe = new Dedupe(now);
  }

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }
}

export function botClient<Client extends { login(credentials: { token: string }): Promise<object> }>(
  sdk: { client(): Client },
  token: string,
): { bot: Client; ready: Promise<void> } {
  const bot = sdk.client();
  return { bot, ready: bot.login({ token }).then(() => undefined) };
}
