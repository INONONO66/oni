import type { ChannelInstanceStore } from "@oni/channels";
import { Machine, type Provisioning } from "@oni/protocol";
import { z } from "zod";

/**
 * The `cli:` contact's declaration (#1512): a `channel:cli:<id>` row the Owner
 * declared through `provision channel_add` with provider `cli` and settings
 * `{dialect, machine, cwd?, attach?, sessionId?}`. The address carries no
 * vendor literal — the dialect names a machine-client agent driver and the
 * machine an enrolled or self machine. `attach: "existing"` names a session
 * the Owner ran by hand (#1779, an id from `agent.session.list`): the contact
 * imports its transcript instead of launching, and a letter resumes it.
 */
const CLI_PROVIDER = "cli";

const CliContactSettings = z.strictObject({
  dialect: Machine.AgentSessionOpenRequest.shape.cli,
  /** An enrolled machine id, or the self machine. */
  machine: z.string().min(1),
  /** Where the child runs on that machine; inside an offered export. */
  cwd: Machine.AbsolutePath.optional(),
  attach: z.literal("existing").optional(),
  sessionId: Machine.AgentSessionOpenRequest.shape.sessionId,
}).refine((settings) => (settings.attach === "existing") === (settings.sessionId !== undefined), {
  message: 'attach: "existing" and sessionId are declared together',
});

function cliContactRowId(id: string): string {
  return `channel:${CLI_PROVIDER}:${id}`;
}

export interface CliDeclarationContext {
  /** Whether a machine id is the self machine or a live enrollment. */
  readonly machineKnown: (machineId: string) => boolean;
}

/** The typed reason a declaration may not land, or `undefined` when it may. */
export function validateCliContactSettings(
  settings: Provisioning.ChannelInstance["settings"],
  context: CliDeclarationContext,
): string | undefined {
  const parsed = CliContactSettings.safeParse(settings);
  if (!parsed.success)
    return `cli contact settings must be {dialect, machine, cwd?, attach?: "existing", sessionId?}: ${parsed.error.message}`;
  if (!context.machineKnown(parsed.data.machine))
    return `unknown machine ${parsed.data.machine}; enroll it through machine_add first`;
  return undefined;
}

/** A declared, enabled contact resolved to its machine-client driver and project. */
export interface CliContact {
  readonly id: string;
  readonly dialect: z.infer<typeof CliContactSettings>["dialect"];
  readonly machine: string;
  readonly cwd: string;
  /** The hand-run session this contact attaches to; absent when the contact launches its own. */
  readonly session?: string;
}

export interface CliContactRefusal {
  readonly reason: string;
}

export interface CliContactResolution {
  readonly instances: Pick<ChannelInstanceStore, "get">;
  readonly machineKnown: CliDeclarationContext["machineKnown"];
}

/** `cli:<id>` is a declared row or nothing. */
export function resolveCliContact(id: string, deps: CliContactResolution): CliContact | CliContactRefusal {
  const row = deps.instances.get(cliContactRowId(id));
  if (row === undefined || row.provider !== CLI_PROVIDER) return { reason: `no cli contact ${id} is declared` };
  if (!row.enabled) return { reason: `cli contact ${id} is disabled` };
  const refused = validateCliContactSettings(row.settings, {
    machineKnown: deps.machineKnown,
  });
  if (refused !== undefined) return { reason: `cli contact ${id}: ${refused}` };
  const settings = CliContactSettings.parse(row.settings);
  return {
    id, dialect: settings.dialect, machine: settings.machine, cwd: settings.cwd ?? "/",
    ...(settings.sessionId === undefined ? {} : { session: settings.sessionId }),
  };
}
