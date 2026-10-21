import type { Provisioning } from "@oni/protocol";
import { CliError } from "./errors";
import { type LoginDeps, reportDeclared } from "./login";
import type { Ask } from "./onboard";

/**
 * The platforms a declaration may name from the command line (#1600 lane
 * R4), each with the credential keys its arm admits — asked for one by one,
 * a token or secret never echoed. Linear is reached through the Owner's
 * account alone (a personal API key), so its row is the Owner instance.
 */
const CHANNEL_CREDENTIALS: Readonly<Record<string, readonly { readonly key: string; readonly secret: boolean; readonly optional?: boolean }[]>> = {
  slack: [
    { key: "botToken", secret: true },
    { key: "appToken", secret: true },
  ],
  discord: [{ key: "token", secret: true }],
  telegram: [{ key: "token", secret: true }],
  github: [
    { key: "secret", secret: true },
    { key: "token", secret: true, optional: true },
    { key: "botUsername", secret: false, optional: true },
  ],
  webhook: [
    { key: "id", secret: false },
    { key: "secret", secret: true },
    { key: "url", secret: false, optional: true },
  ],
  a2a: [
    { key: "token", secret: true },
    { key: "url", secret: false, optional: true },
    { key: "name", secret: false, optional: true },
  ],
  linear: [
    { key: "secret", secret: true },
    { key: "token", secret: true, optional: true },
    { key: "ownerUserId", secret: false, optional: true },
  ],
};
const OWNER_ONLY = new Set(["linear"]);
const TIERS = ["owner", "co_owner", "manager", "collaborator", "observer", "assigned_worker"] as const;
type Tier = (typeof TIERS)[number];
const INTAKES = ["mentions_and_dms", "all", "none"] as const;
type Intake = (typeof INTAKES)[number];

export const CHANNEL_ADD_USAGE = `usage: oni channel add <slack|discord|telegram|github|webhook|a2a|linear> [--id channel:<provider>:<slug>]
                            [--tier ${TIERS.join("|")}] [--allow <platform-id>[,...]] [--mention-only]
                            [--intake ${INTAKES.join("|")}] [--outbound] [--auto-reply]   (linear: the Owner's account)
                            [--print]`;

export interface ChannelAddOptions {
  readonly provider: string;
  readonly instanceId: string;
  readonly identity: "bot" | "owner";
  readonly tier?: Tier;
  readonly allow?: readonly string[];
  readonly mentionOnly: boolean;
  readonly intake?: Intake;
  readonly outbound: boolean;
  readonly autoReply: boolean;
  /** Print the declaration instead of sending it. */
  readonly print: boolean;
}

function isTier(value: string): value is Tier {
  return TIERS.some((tier) => tier === value);
}
function isIntake(value: string): value is Intake {
  return INTAKES.some((intake) => intake === value);
}

interface ParsedFlags {
  instanceId: string;
  tier?: Tier;
  allow?: string[];
  mentionOnly: boolean;
  intake?: Intake;
  outbound: boolean;
  autoReply: boolean;
  print: boolean;
}

/** One flag folded into the options; `takes` consumes the flag's value or refuses. */
function applyFlag(options: ParsedFlags, flag: string, takes: (name: string) => string): void {
  switch (flag) {
    case "--id":
      options.instanceId = takes("--id");
      break;
    case "--tier": {
      const tier = takes("--tier");
      if (!isTier(tier)) throw new CliError(`--tier needs one of ${TIERS.join(", ")}\n${CHANNEL_ADD_USAGE}`);
      options.tier = tier;
      break;
    }
    case "--allow": {
      const ids = takes("--allow").split(",").map((id) => id.trim()).filter((id) => id.length > 0);
      if (ids.length === 0) throw new CliError(`--allow needs at least one platform id\n${CHANNEL_ADD_USAGE}`);
      options.allow = ids;
      break;
    }
    case "--mention-only":
      options.mentionOnly = true;
      break;
    case "--intake": {
      const intake = takes("--intake");
      if (!isIntake(intake)) throw new CliError(`--intake needs ${INTAKES.join(", ")}\n${CHANNEL_ADD_USAGE}`);
      options.intake = intake;
      break;
    }
    case "--outbound":
      options.outbound = true;
      break;
    case "--auto-reply":
      options.autoReply = true;
      break;
    case "--print":
      options.print = true;
      break;
    default:
      throw new CliError(`unknown channel add flag: ${flag}\n${CHANNEL_ADD_USAGE}`);
  }
}

/** The flags that contradict the platform: a peer row takes no grant block, a bot has no Owner posture, auto-reply needs outbound. */
function refuseIncoherent(provider: string, owner: boolean, options: ParsedFlags): void {
  if (provider === "a2a" && (options.tier !== undefined || options.allow !== undefined || options.mentionOnly))
    throw new CliError(`an a2a peer is admitted through the one door at its contact's tier (contact_add); a peer row takes no grant block\n${CHANNEL_ADD_USAGE}`);
  if (!owner && (options.intake !== undefined || options.outbound || options.autoReply))
    throw new CliError(`--intake, --outbound and --auto-reply describe the Owner's own account; ${provider} is declared as the bot (sign the account in with oni login)\n${CHANNEL_ADD_USAGE}`);
  if (options.autoReply && !options.outbound)
    throw new CliError(`--auto-reply needs --outbound: the reply door answers as the Owner only from an instance that may send\n${CHANNEL_ADD_USAGE}`);
}

/** Parses `channel add`'s command line; a bad shape is a typed CLI error naming the usage. */
export function parseChannelAddArgs(args: readonly string[]): ChannelAddOptions {
  const [provider, ...rest] = args;
  if (provider === undefined || CHANNEL_CREDENTIALS[provider] === undefined)
    throw new CliError(`channel add needs a platform\n${CHANNEL_ADD_USAGE}`);
  const owner = OWNER_ONLY.has(provider);
  const options: ParsedFlags = { instanceId: `channel:${provider}:${owner ? "owner" : "main"}`, mentionOnly: false, outbound: false, autoReply: false, print: false };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index] ?? "";
    applyFlag(options, flag, (name) => {
      const value = rest[index + 1];
      if (value === undefined) throw new CliError(`${name} needs a value\n${CHANNEL_ADD_USAGE}`);
      index += 1;
      return value;
    });
  }
  refuseIncoherent(provider, owner, options);
  return { provider, identity: owner ? "owner" : "bot", ...options };
}

/** Asks for each credential the platform's arm admits; an optional one left blank is not sent. */
export async function askCredential(provider: string, ask: Ask): Promise<Record<string, string>> {
  const credential: Record<string, string> = {};
  for (const field of CHANNEL_CREDENTIALS[provider] ?? []) {
    const value = await ask(`${provider} ${field.key}${field.optional === true ? " (optional)" : ""}`, {
      required: field.optional !== true,
      secret: field.secret,
    });
    if (value.trim().length > 0) credential[field.key] = value.trim();
  }
  return credential;
}

/** The declaration as the Owner's socket carries it: the grant block is the Owner's consent by the call itself (#1600 lane R1). */
export function channelDeclaration(
  options: ChannelAddOptions,
  credential: Record<string, string>,
  requestId: string,
): Provisioning.ChannelDeclareRequest {
  const grant =
    options.tier === undefined && options.allow === undefined && !options.mentionOnly
      ? undefined
      : {
          ...(options.tier === undefined ? {} : { defaultTier: options.tier }),
          ...(options.allow === undefined ? {} : { allowedSenders: [...options.allow] }),
          ...(options.mentionOnly ? { mentionOnly: true } : {}),
        };
  return {
    type: "channel_add",
    requestId,
    id: options.instanceId,
    provider: options.provider,
    identity: options.identity,
    ...(options.identity === "owner"
      ? { settings: { intake: options.intake ?? "mentions_and_dms", autoReply: options.autoReply } }
      : {}),
    ...(options.outbound ? { outbound: true } : {}),
    ...(grant === undefined ? {} : { grant }),
    credential,
  };
}

interface ChannelIo {
  readonly ask: Ask;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/**
 * `oni channel add <platform>` (#1600 lane R4): declares a bot
 * instance — or Linear's Owner instance — over the Owner's socket with its
 * grant block, the credential asked for here and sealed into the vault by
 * the daemon, never written on this side. `--print` shows the declaration
 * instead, for an Owner declaring through the Resident's provision tool.
 */
export async function channelAdd(args: readonly string[], deps: Pick<LoginDeps, "declare" | "id">, io: ChannelIo): Promise<number> {
  let options: ChannelAddOptions;
  try {
    options = parseChannelAddArgs(args);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    io.stderr(error.message);
    return 1;
  }
  const credential = await askCredential(options.provider, io.ask);
  const request = channelDeclaration(options, credential, deps.id());
  if (options.print) {
    const { type: _type, requestId: _requestId, ...declaration } = request;
    io.stdout(JSON.stringify(declaration));
    return 0;
  }
  let response: Provisioning.ChannelDeclareResponse;
  try {
    response = await deps.declare(request);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    io.stderr(error.message);
    io.stderr("nothing was sealed; start the daemon and run channel add again");
    return 1;
  }
  if (response.type === "channel_add_refused") {
    io.stderr(`channel_add refused (${response.reason}): ${response.detail}`);
    return 1;
  }
  return reportDeclared(response, options.instanceId, io);
}
