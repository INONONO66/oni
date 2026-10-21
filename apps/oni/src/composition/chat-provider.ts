import type { Core } from "@oni/agent";
type ChatAgentConfig = Core.ChatAgentConfig;

export interface ChatProviderOptions {
  readonly apiKey: string;
  readonly transport?: ChatAgentConfig["transport"];
}

export function chatProviderConfig(
  options: ChatProviderOptions,
): Pick<ChatAgentConfig, "auth" | "transport"> {
  return {
    auth: { type: "api", key: options.apiKey },
    ...(options.transport === undefined ? {} : { transport: options.transport }),
  };
}
