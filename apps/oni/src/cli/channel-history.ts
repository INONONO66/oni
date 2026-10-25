import { Channel } from "@oni/protocol";
import { CliError } from "./errors";
import { ThrownError } from "../thrown";

export interface ChannelHistoryOptions {
  readonly instanceId: string;
  readonly chatId: string;
  readonly before?: string;
  readonly limit: number;
}

export interface ChannelHistoryDeps {
  readonly id: () => string;
  readonly read: (request: Channel.HistoryRequest) => Promise<Channel.HistoryResponse>;
}

export interface ChannelHistoryIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

const USAGE = "usage: oni channel history <instance-id> <chat-id> [--before <cursor>] [--limit <1..100>]";

export function parseChannelHistoryArgs(args: readonly string[]): ChannelHistoryOptions {
  const [instanceId, chatId, ...flags] = args;
  let before: string | undefined;
  let limit = 50;
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (value === undefined || (flag !== "--before" && flag !== "--limit"))
      throw new CliError(USAGE);
    if (flag === "--before") {
      if (before !== undefined) throw new CliError(USAGE);
      before = value;
    } else {
      if (limit !== 50 || !/^(?:[1-9]|[1-9]\d|100)$/.test(value)) throw new CliError(USAGE);
      limit = Number(value);
    }
  }
  const parsed = Channel.HistoryQuery.safeParse({ chatId, before, limit });
  if (instanceId === undefined || !Channel.HistoryRequest.shape.instanceId.safeParse(instanceId).success ||
      !parsed.success) throw new CliError(USAGE);
  return { instanceId, chatId: parsed.data.chatId, limit, ...(before === undefined ? {} : { before }) };
}

export async function channelHistory(
  args: readonly string[],
  deps: ChannelHistoryDeps,
  io: ChannelHistoryIo,
): Promise<number> {
  const execute = async (): Promise<number> => {
    const options = parseChannelHistoryArgs(args);
    const request = Channel.HistoryRequest.parse({
      ...options,
      type: "channel_history",
      requestId: deps.id(),
    });
    const response = await deps.read(request);
    if (response.type === "channel_history_refused") {
      io.stderr(`channel_history_refused (${response.reason}): ${response.detail}`);
      return 1;
    }
    io.stdout(JSON.stringify(response.page));
    return 0;
  };
  const result = await execute().then((code) => ({ code }), ThrownError.parse);
  if (result instanceof Error) {
    const error = result;
    io.stderr(error.message);
    return 1;
  }
  return result.code;
}
