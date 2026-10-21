import type { OwnerLogin } from "@oni/channels";
import type { Provisioning } from "@oni/protocol";
import { CliError } from "./errors";
import type { Ask } from "./onboard";

/** The platforms the Owner's own account can be signed in on (#1569 lane 5b). */
const LOGIN_PLATFORMS = ["slack", "discord", "instagram", "kakaotalk"] as const;
export type LoginPlatform = (typeof LOGIN_PLATFORMS)[number];

export interface LoginDeps {
  /** The platform sign-in flows; the shipped ones ride the agent-messenger SDK. */
  readonly logins: OwnerLogin;
  /** Declares the instance over the Owner's socket; absent when no daemon is reachable. */
  readonly declare: (request: Provisioning.ChannelDeclareRequest) => Promise<Provisioning.ChannelDeclareResponse>;
  readonly id: () => string;
}

export interface LoginOptions {
  readonly platform: LoginPlatform;
  readonly instanceId: string;
  readonly intake: "mentions_and_dms" | "all" | "none";
  readonly outbound: boolean;
  readonly autoReply: boolean;
  /** Print the credential payload instead of declaring the instance. */
  readonly print: boolean;
}

export const LOGIN_USAGE = `usage: oni login <slack|discord|instagram|kakaotalk> [--id channel:<platform>:owner]
                     [--intake mentions_and_dms|all|none] [--outbound] [--auto-reply] [--print]`;

/** Parses the login command line; a bad shape is a typed CLI error naming the usage. */
export function parseLoginArgs(args: readonly string[]): LoginOptions {
  const [platform, ...rest] = args;
  if (!LOGIN_PLATFORMS.some((known) => known === platform))
    throw new CliError(`login needs one of ${LOGIN_PLATFORMS.join(", ")}\n${LOGIN_USAGE}`);
  const options = {
    platform: platform as LoginPlatform,
    instanceId: `channel:${platform}:owner`,
    intake: "mentions_and_dms" as LoginOptions["intake"],
    outbound: false,
    autoReply: false,
    print: false,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    switch (flag) {
      case "--id":
        if (value === undefined) throw new CliError(`--id needs a value\n${LOGIN_USAGE}`);
        options.instanceId = value;
        index += 1;
        break;
      case "--intake":
        if (value !== "mentions_and_dms" && value !== "all" && value !== "none")
          throw new CliError(`--intake needs mentions_and_dms, all or none\n${LOGIN_USAGE}`);
        options.intake = value;
        index += 1;
        break;
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
        throw new CliError(`unknown login flag: ${flag}\n${LOGIN_USAGE}`);
    }
  }
  if (options.autoReply && !options.outbound)
    throw new CliError(`--auto-reply needs --outbound: the reply door answers as the Owner only from an instance that may send\n${LOGIN_USAGE}`);
  return options;
}

interface LoginIo {
  readonly ask: Ask;
  readonly stdout: (line: string) => void;
}

/** Runs the platform's sign-in flow and returns the credential payload the Owner arm admits. */
export async function signIn(
  platform: LoginPlatform,
  deps: LoginDeps,
  io: LoginIo,
): Promise<Record<string, string>> {
  switch (platform) {
    case "slack": {
      const qrImage = await io.ask(
        "In Slack: your name (top-left) → Sign in on mobile → right-click the QR → Copy Image Address; paste it here",
        { required: true, secret: true },
      );
      const session = await deps.logins.slack({
        qrImage: qrImage.trim(),
        confirm: ({ email }) => io.ask(`Confirmation code Slack mailed to ${email}`, { required: true }),
      });
      io.stdout(`Signed in to Slack workspace ${session.workspace}`);
      return { token: session.token, cookie: session.cookie };
    }
    case "discord": {
      const session = await deps.logins.discord({
        showQr: (url) => io.stdout(`Open Discord on your phone and scan: ${url}`),
      });
      io.stdout(`Signed in to Discord${session.username === undefined ? "" : ` as ${session.username}`}`);
      return { token: session.token };
    }
    case "instagram": {
      const username = await io.ask("Instagram username", { required: true });
      const password = await io.ask("Instagram password", { required: true, secret: true });
      const session = await deps.logins.instagram({
        username: username.trim(),
        password,
        twoFactorCode: () => io.ask("Instagram two-factor code", { required: true }),
        challengeCode: ({ contactPoint }) => io.ask(`Code Instagram sent to ${contactPoint}`, { required: true }),
      });
      io.stdout(`Signed in to Instagram as ${username.trim()}`);
      return { session: session.session };
    }
    case "kakaotalk": {
      const email = await io.ask("KakaoTalk account email", { required: true });
      const password = await io.ask("KakaoTalk password", { required: true, secret: true });
      const session = await deps.logins.kakaotalk({
        email: email.trim(),
        password,
        deviceType: "tablet",
        onPasscode: (code) => io.stdout(`Enter this passcode in KakaoTalk on your phone: ${code}`),
      });
      io.stdout(`Signed in to KakaoTalk as user ${session.userId}`);
      return {
        oauthToken: session.oauthToken,
        userId: session.userId,
        deviceUuid: session.deviceUuid,
        deviceType: session.deviceType,
      };
    }
  }
}

type LoginReport = LoginIo & { readonly stderr: (line: string) => void };

/** The states a freshly declared instance may settle in; anything else is the daemon's reason for a nonzero exit. */
const SETTLED_STATES = new Set(["mounted", "ready", "disabled"]);

/** The command line and the platform's sign-in; either failing is reported, and nothing is declared. */
async function signInFor(
  args: readonly string[],
  deps: LoginDeps,
  io: LoginReport,
): Promise<{ readonly options: LoginOptions; readonly credential: Record<string, string> } | number> {
  try {
    const options = parseLoginArgs(args);
    return { options, credential: await signIn(options.platform, deps, io) };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    io.stderr(error instanceof CliError ? error.message : `sign-in failed: ${error.message}`);
    return 1;
  }
}

/** The declared instance's own status decides the exit; the daemon answers with every instance's. */
export function reportDeclared(
  response: Extract<Provisioning.ChannelDeclareResponse, { readonly type: "channel_declared" }>,
  instanceId: string,
  io: LoginReport,
): number {
  const own = response.statuses.filter((status) => status.id === instanceId);
  if (own.length === 0) {
    io.stderr(`the daemon reported no status for ${instanceId}`);
    return 1;
  }
  let exit = 0;
  for (const status of own) {
    io.stdout(`${status.id} [${status.surface}] → ${status.state}${status.detail === undefined ? "" : ` (${status.detail})`}`);
    if (!SETTLED_STATES.has(status.state)) exit = 1;
  }
  return exit;
}

/**
 * `oni login <platform>` (#1569 lane 5b): signs the Owner's own
 * account in through the platform's flow and declares the Owner instance
 * over the Owner's socket — the credential is sealed into the vault by the
 * daemon and never written anywhere on this side. `--print` shows the
 * payload instead, for an Owner declaring through the Resident's provision
 * tool (which records it in the session journal). A declaration the daemon
 * cannot take after the sign-in completed shows the same payload rather
 * than losing a sign-in the platform counted (a device registration, a
 * single-use code).
 */
export async function login(args: readonly string[], deps: LoginDeps, io: LoginReport): Promise<number> {
  const signedIn = await signInFor(args, deps, io);
  if (typeof signedIn === "number") return signedIn;
  const { options, credential } = signedIn;
  const payload = JSON.stringify({ provider: options.platform, identity: "owner", credential });
  if (options.print) {
    io.stdout(payload);
    return 0;
  }
  let response: Provisioning.ChannelDeclareResponse;
  try {
    response = await deps.declare({
      type: "channel_add",
      requestId: deps.id(),
      id: options.instanceId,
      provider: options.platform,
      identity: "owner",
      settings: { intake: options.intake, autoReply: options.autoReply },
      ...(options.outbound ? { outbound: true } : {}),
      credential,
    });
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    io.stderr(error.message);
    io.stderr(
      "the sign-in completed but nothing was sealed; start the daemon and run login again, or declare this payload through the Resident:",
    );
    io.stdout(payload);
    return 1;
  }
  if (response.type === "channel_add_refused") {
    io.stderr(`channel_add refused (${response.reason}): ${response.detail}`);
    return 1;
  }
  return reportDeclared(response, options.instanceId, io);
}
