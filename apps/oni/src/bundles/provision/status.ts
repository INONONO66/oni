import { ChannelProviders } from "@oni/channels";
import { isRegisteredProvider } from "../../channels";
import { z } from "zod";
import type { ProvisionOutput } from "./provision";
import type { ProvisionPort } from "./channels";
import type { ChannelRuntimeStatus } from "./supervisor";
export const EMPTY_INPUT = z.object({}).strict();
export const Statuses = z.array(
  z
    .object({
      id: z.string(),
      surface: z.string(),
      state: z.enum([
        "ready",
        "disabled",
        "vault_locked",
        "unknown_provider",
        "identity_unsupported",
        "missing_credential",
        "credential_invalid",
        "mounted",
        "start_failed",
        "paused_by_breaker",
      ]),
      detail: z.string().optional(),
    })
    .strict(),
);
export const ProvisionStatusOutput = z
  .object({
    source: z.enum(["declared", "env"]),
    vault: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("open") }).strict(),
      z.object({ kind: z.literal("locked"), reason: z.string() }).strict(),
    ]),
    statuses: Statuses,
    preconditions: z.array(z.object({ surface: z.string(), text: z.string() }).strict()),
  })
  .strict();

/** The operator checklist behind one reported surface: the platform's for its bot, the Owner arm's for `<platform>:owner` (#1569). */
function surfacePreconditions(surface: string): readonly string[] {
  const [platform, identity] = surface.split(":");
  if (platform === undefined || !isRegisteredProvider(platform)) return [];
  const provider = ChannelProviders[platform];
  return identity === "owner" ? (provider.owner?.preconditions ?? []) : provider.preconditions;
}

export function executeProvisionStatus(port: ProvisionPort) {
  return async (_input: z.output<typeof EMPTY_INPUT>) => {
    const statuses = port.supervisor.status();
    const preconditions = [...new Set(statuses.map((status) => status.surface))].flatMap((surface) =>
      surfacePreconditions(surface).map((text) => ({ surface, text })),
    );
    return {
      source: port.supervisor.source(),
      vault:
        port.kek.kind === "locked"
          ? { kind: "locked" as const, reason: port.kek.reason }
          : { kind: "open" as const },
      statuses,
      preconditions,
    };
  };
}

function renderProvisionStatus(value: z.output<typeof ProvisionStatusOutput>): string {
  const lines = value.statuses.map(
    (status) =>
      `${status.id} [${status.surface}] → ${status.state}${status.detail === undefined ? "" : ` (${status.detail})`}`,
  );
  return [
    `channel source: ${value.source}`,
    value.vault.kind === "locked" ? `vault_locked (${value.vault.reason})` : "vault open",
    ...(lines.length === 0 ? ["no channels declared or configured"] : lines),
    ...value.preconditions.map(({ surface, text }) => `${surface} precondition: ${text}`),
  ].join("\n");
}
function statusLines(statuses: readonly ChannelRuntimeStatus[]): string {
  return statuses.length === 0
    ? "no channels declared or configured"
    : statuses
        .map(
          (status) =>
            `${status.id} → ${status.state}${status.detail === undefined ? "" : ` (${status.detail})`}`,
        )
        .join("\n");
}

export function renderProvision(value: z.output<typeof ProvisionOutput>): string {
  if ("result" in value && value.op !== "contact_add") return JSON.stringify(value.result);
  if (value.op === "status") return renderProvisionStatus(value);
  if (value.op === "contact_add") {
    return `person ${value.result.id} declared (tier ${value.result.trustTier}, revision ${value.result.revision})`;
  }
  if (value.op === "contact_remove") return `person ${value.id} removed`;
  if (value.op === "contact_promote")
    return `contact ${value.id} registered (tier ${value.trustTier})`;
  if (value.op === "contact_merge") return `endpoint ${value.id} merged into ${value.actorId}`;
  if (value.op === "channel_add" || value.op === "channel_enable" || value.op === "channel_disable")
    return `channel ${value.id} ${value.action}\n${statusLines(value.statuses)}`;
  if (value.op === "bundle_enable" || value.op === "bundle_disable")
    return `bundle ${value.name} ${value.action} (off: ${value.off.length === 0 ? "none" : value.off.join(", ")})`;
  return `secret ${value.id} rotated (kek ${value.kekId})\n${statusLines(value.statuses)}`;
}
