import { join } from "node:path";
import { Result } from "effect";
import { CauseText } from "../thrown";
import {
  type DaemonIo,
  type DaemonTarget,
  daemonInstall,
  daemonRestart,
  daemonStart,
  daemonStatus,
  daemonStop,
  daemonUninstall,
} from "./daemon";
import type { EnvEntry } from "./env-file";
import type { DoctorCheck, DoctorPorts } from "./doctor";
import { runDoctor } from "./doctor";
import type { Ask } from "./onboard";
import { gatherOnboarding } from "./onboard";
import { login, type LoginDeps } from "./login";
import { channelAdd } from "./channel";
import { channelHistory, type ChannelHistoryDeps } from "./channel-history";
import { type MessagingFacts, messagingReadiness } from "./messaging";
import { type DeployClient, deployCommand } from "./deploy";
import { ONI_VERSION } from "../version";

/**
 * Command dispatch with every side effect injected. `main.ts` is the only
 * place real IO gets bound, so the whole CLI surface is testable.
 */
export interface CliDeps {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly target: DaemonTarget;
  readonly io: DaemonIo;
  readonly envPath: string;
  readonly startApp: () => Promise<void>;
  readonly attachMachine: (configPath: string) => Promise<number>;
  readonly ask: Ask;
  readonly writeEnv: (entries: readonly EnvEntry[]) => void;
  readonly doctorPorts: () => Promise<DoctorPorts>;
  /** Runs a follow-style child (tail/journalctl) to completion; returns its exit code. */
  readonly follow: (argv: readonly string[]) => Promise<number>;
  /** #1569 lane 5b: the Owner's platform sign-ins and the socket that declares the instance. */
  readonly login: LoginDeps;
  readonly channelHistory: ChannelHistoryDeps;
  /** #1600 lane R4: the catalog's declared instances, Persons and sealed credentials, read for the readiness report. */
  readonly messagingFacts: () => Promise<MessagingFacts>;
  /** #1699: the resident supervisor the service unit runs, and the deploy client of its socket. */
  readonly supervise: () => Promise<number>;
  readonly deploy: DeployClient;
}

const USAGE = `oni — Single-Owner Agent OS

Usage:
  oni start                 run the Resident in the foreground
  oni supervise             run the Resident under the deploy supervisor (the service unit's command)
  oni deploy <tgz>          drain-restart onto a staged release [--grace-ms <0..300000>]; --reload re-deploys the newest staged one
  oni --version             print the version
  oni onboard               interactive setup → ~/.oni/env
  oni daemon <verb>         install | uninstall | status | start | stop | restart
  oni machine attach <json> attach a machine client using a JSON config
  oni doctor                read-only diagnostics
  oni logs                  follow the daemon logs
  oni login <platform>      sign the Owner's own account in and declare it (slack | discord | instagram | kakaotalk | telegram)
  oni channel add <platform> declare a bot (slack | discord | telegram | github | webhook | a2a) or Linear with its grant
      history <instance-id> <chat-id> [--before <cursor>] [--limit <1..100>]  page an Owner account's chat
  oni messaging             the messaging readiness report: who reads, how the Resident writes, where you are known
  oni help                  show this message`;

const DAEMON_VERBS: Record<string, (target: DaemonTarget, io: DaemonIo) => string> = {
  install: daemonInstall,
  uninstall: daemonUninstall,
  status: daemonStatus,
  start: daemonStart,
  stop: daemonStop,
  restart: daemonRestart,
};

export async function runCli(args: readonly string[], deps: CliDeps): Promise<number> {
  const command = args[0] ?? "help";
  switch (command) {
    case "start":
      await deps.startApp();
      return 0;
    case "supervise":
      return await deps.supervise();
    case "deploy":
      return await deployCommand(args.slice(1), deps.deploy);
    case "--version":
      deps.stdout(ONI_VERSION);
      return 0;
    case "onboard":
      return await onboard(deps);
    case "daemon":
      return daemon(args[1], deps);
    case "machine":
      if (args[1] !== "attach" || args[2] === undefined || args.length !== 3) {
        deps.stderr("usage: oni machine attach <config.json>");
        return 1;
      }
      return deps.attachMachine(args[2]);
    case "doctor":
      return await doctor(deps);
    case "logs":
      return await deps.follow(logsArgv(deps.target));
    case "login":
      return await login(args.slice(1), deps.login, deps);
    case "channel":
      if (args[1] === "history") return await channelHistory(args.slice(2), deps.channelHistory, deps);
      if (args[1] !== "add") {
        deps.stderr("usage: oni channel add <platform> [flags] | oni channel history <instance-id> <chat-id> [--before <cursor>] [--limit <1..100>]");
        return 1;
      }
      return await channelAdd(args.slice(2), deps.login, deps);
    case "messaging":
      return await messaging(deps);
    case "help":
    case "--help":
    case "-h":
      deps.stdout(USAGE);
      return 0;
    default:
      deps.stderr(`unknown command: ${command}`);
      deps.stderr(USAGE);
      return 1;
  }
}

async function onboard(deps: CliDeps): Promise<number> {
  if (deps.io.fileExists(deps.envPath)) {
    const answer = await deps.ask(`${deps.envPath} exists — overwrite? (y/N)`);
    if (answer.trim().toLowerCase() !== "y") {
      deps.stdout("keeping the existing env file");
      return 0;
    }
  }
  deps.writeEnv(await gatherOnboarding(deps.ask));
  deps.stdout(`wrote ${deps.envPath}`);
  deps.stdout("next: `oni daemon install` to run 24/7, or `oni start` to try it now");
  return 0;
}

function daemon(verb: string | undefined, deps: CliDeps): number {
  const handler = verb === undefined ? undefined : DAEMON_VERBS[verb];
  if (handler === undefined) {
    deps.stderr("usage: oni daemon install | uninstall | status | start | stop | restart");
    return 1;
  }
  const output = Result.try({ try: () => handler(deps.target, deps.io), catch: CauseText.parse });
  if (Result.isFailure(output)) {
    deps.stderr(output.failure);
    return 1;
  }
  deps.stdout(output.success);
  return 0;
}

async function messaging(deps: CliDeps): Promise<number> {
  let facts: MessagingFacts;
  try {
    facts = await deps.messagingFacts();
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const report = messagingReadiness(facts);
  for (const line of report.lines) deps.stdout(line);
  return report.ok ? 0 : 1;
}

async function doctor(deps: CliDeps): Promise<number> {
  const report = await runDoctor(await deps.doctorPorts());
  const format = (check: DoctorCheck): string =>
    `${check.status.toUpperCase().padEnd(4)} ${check.name}: ${check.detail}`;
  for (const check of report.checks) {
    deps.stdout(format(check));
  }
  return report.ok ? 0 : 1;
}

function logsArgv(target: DaemonTarget): readonly string[] {
  return target.platform === "darwin"
    ? ["tail", "-n", "50", "-F", join(target.home, ".oni", "logs", "oni.log")]
    : ["journalctl", "--user", "-u", "oni", "-f"];
}
