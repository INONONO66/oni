import { CliError } from "./errors";
import type { EnvEntry } from "./env-file";

/**
 * Interactive first-run setup. Answers become `~/.oni/env` entries —
 * exactly the variables `loadConfig` already reads; onboarding introduces
 * no new configuration vocabulary.
 */
export interface AskOptions {
  readonly fallback?: string;
  readonly required?: boolean;
  /** Secret values must not echo to the terminal. */
  readonly secret?: boolean;
}

export type Ask = (question: string, options?: AskOptions) => Promise<string>;

async function askRequired(
  ask: Ask,
  question: string,
  extra?: { readonly fallback?: string; readonly secret?: boolean },
): Promise<string> {
  const fallback = extra?.fallback;
  const options: AskOptions =
    fallback === undefined
      ? { required: true, secret: extra?.secret }
      : { fallback, secret: extra?.secret };
  const answer = (await ask(question, options)).trim();
  if (answer.length > 0) return answer;
  if (fallback !== undefined) return fallback;
  throw new CliError(`${question} is required`);
}

export async function gatherOnboarding(ask: Ask): Promise<readonly EnvEntry[]> {
  const provider = await askRequired(ask, "Model provider (anthropic | openai)", {
    fallback: "anthropic",
  });
  if (provider !== "anthropic" && provider !== "openai") {
    throw new CliError(`Model provider must be "anthropic" or "openai", got "${provider}"`);
  }
  const modelId = await askRequired(ask, "Model id");
  const apiKey = await askRequired(ask, "Model API key", { secret: true });
  const port = await askRequired(ask, "WebSocket port", { fallback: "3000" });
  // Port 0 would bind an ephemeral, undiscoverable port under the daemon.
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new CliError("WebSocket port must be an integer from 1 to 65535");
  }

  const entries: EnvEntry[] = [
    { key: "ONI_MODEL_PROVIDER", value: provider },
    { key: "ONI_MODEL_ID", value: modelId },
    { key: "ONI_MODEL_API_KEY", value: apiKey },
    { key: "ONI_WS_PORT", value: port },
  ];

  // External channels are declared with provision/channel_add, never env credentials.
  return entries;
}
