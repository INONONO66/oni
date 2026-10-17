import type { ChannelInstanceStore } from "@openomni/channels";
import { Machine, type Provisioning } from "@openomni/protocol";
import { z } from "zod";
import { packs as registry } from "../dialects/index";
import type { DialectPack } from "../dialects/pack";

/**
 * The `cli:` contact's declaration (#1512): a `channel:cli:<id>` row the Owner
 * declared through `provision channel_add` with provider `cli` and settings
 * `{dialect, machine, cwd?}`. The address carries no vendor literal — the
 * dialect names a registered pack (#1527) and the machine an enrolled or self
 * machine; one contact is one machine and one tmux session name.
 */
const CLI_PROVIDER = "cli";

const CliContactSettings = z.strictObject({
  /** A registered dialect pack id (`dialects/index.ts`). */
  dialect: z.string().min(1),
  /** An enrolled machine id, or the self machine. */
  machine: z.string().min(1),
  /** Where the child runs on that machine; inside an offered export. */
  cwd: Machine.AbsolutePath.optional(),
});

export function cliContactRowId(id: string): string {
  return `channel:${CLI_PROVIDER}:${id}`;
}

/** The pty session is a function of the contact id alone: lookup-or-create finds the same pane every turn. */
export function cliSessionName(id: string): string {
  return Machine.PtySessionName.parse(`cli-${id}`.slice(0, 64));
}

export interface CliDeclarationContext {
  /** The registered dialect ids. */
  readonly dialects: readonly string[];
  /** Whether a machine id is the self machine or a live enrollment. */
  readonly machineKnown: (machineId: string) => boolean;
}

/** The typed reason a declaration may not land, or `undefined` when it may. */
export function validateCliContactSettings(
  settings: Provisioning.ChannelInstance["settings"],
  context: CliDeclarationContext,
): string | undefined {
  const parsed = CliContactSettings.safeParse(settings);
  if (!parsed.success) return `cli contact settings must be {dialect, machine, cwd?}: ${parsed.error.message}`;
  if (!context.dialects.includes(parsed.data.dialect))
    return `unknown dialect ${parsed.data.dialect}; registered dialects: ${context.dialects.join(", ")}`;
  if (!context.machineKnown(parsed.data.machine))
    return `unknown machine ${parsed.data.machine}; enroll it through machine_add first`;
  return undefined;
}

/** A declared, enabled contact resolved to its pack, machine, cwd and pane. */
export interface CliContact {
  readonly id: string;
  readonly pack: DialectPack;
  readonly machine: string;
  readonly cwd: string;
  readonly session: string;
}

export interface CliContactRefusal {
  readonly reason: string;
}

export interface CliContactResolution {
  readonly instances: Pick<ChannelInstanceStore, "get">;
  readonly machineKnown: CliDeclarationContext["machineKnown"];
  readonly packs?: readonly DialectPack[];
}

/** `cli:<id>` is a declared row or nothing: no literal list of agents exists outside the packs. */
export function resolveCliContact(id: string, deps: CliContactResolution): CliContact | CliContactRefusal {
  const row = deps.instances.get(cliContactRowId(id));
  if (row === undefined || row.provider !== CLI_PROVIDER) return { reason: `no cli contact ${id} is declared` };
  if (!row.enabled) return { reason: `cli contact ${id} is disabled` };
  const packs = deps.packs ?? registry;
  const refused = validateCliContactSettings(row.settings, {
    dialects: packs.map((pack) => pack.manifest.id),
    machineKnown: deps.machineKnown,
  });
  if (refused !== undefined) return { reason: `cli contact ${id}: ${refused}` };
  const settings = CliContactSettings.parse(row.settings);
  const pack = packs.find((candidate) => candidate.manifest.id === settings.dialect);
  if (pack === undefined) return { reason: `cli contact ${id}: unknown dialect ${settings.dialect}` };
  return { id, pack, machine: settings.machine, cwd: settings.cwd ?? "/", session: cliSessionName(id) };
}
