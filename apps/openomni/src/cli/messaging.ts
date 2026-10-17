import type { Provisioning } from "@openomni/protocol";

/**
 * What the readiness report reads (#1600 lane R4): the declared instances,
 * the Persons, and which credential rows are sealed — every fact from the
 * catalog, none from a live platform.
 */
export interface MessagingFacts {
  readonly instances: readonly Provisioning.ChannelInstance[];
  readonly persons: readonly Provisioning.Person[];
  readonly sealed: ReadonlySet<string>;
}

export interface MessagingReport {
  readonly lines: readonly string[];
  /** Something is declared and every enabled declaration has its credential sealed. */
  readonly ok: boolean;
}

/** The platforms reached through the Owner's account alone: no bot arm exists. */
const OWNER_ONLY = new Set(["instagram", "kakaotalk", "linear"]);
/** The Owner arms that name the account they speak as once started, so the mount binds it to the Owner Person (#1600 lane R1). */
const NAMES_ITS_ACCOUNT = new Set(["slack", "discord", "instagram", "kakaotalk"]);
/** What every sender on a surface gets who is not a declared Person, when the declaration names no tier (`MOUNTED_CHANNEL_DEFAULT_TIER`). */
const MOUNT_TIER = "assigned_worker";
/** The tiers the owner policy's `message.external.grant_tier` row admits for a full-access turn. */
const ADMITTED = new Set(["owner", "co_owner", "manager"]);

function setting(instance: Provisioning.ChannelInstance, key: string): string | undefined {
  const value = instance.settings[key];
  return value === undefined || value === null ? undefined : String(value);
}

function ownerPerson(persons: readonly Provisioning.Person[]): Provisioning.Person | undefined {
  return persons.find((person) => person.trustTier === "owner");
}

/** One declared row, as the Owner sees it. */
function rowLine(instance: Provisioning.ChannelInstance, sealed: ReadonlySet<string>): string {
  const credential =
    instance.credentialRef === undefined ? "no credential" : sealed.has(instance.credentialRef) ? "credential sealed" : `credential ${instance.credentialRef} MISSING from the vault`;
  const parts = [instance.enabled ? "enabled" : "DISABLED", credential];
  if (instance.identity === "owner") {
    parts.push(`intake ${setting(instance, "intake") ?? "mentions_and_dms"}`);
    parts.push(instance.grant?.outbound === true ? "outbound" : "inbound-only");
    if (setting(instance, "autoReply") === "true") parts.push("auto-reply");
  }
  const grant = instance.grant;
  if (grant?.defaultTier !== undefined) parts.push(`tier ${grant.defaultTier}`);
  if (grant?.allowedSenders !== undefined) parts.push(`allow [${grant.allowedSenders.join(", ")}]`);
  if (grant?.mentionOnly === true) parts.push("mention-only");
  return `  ${instance.id} [${instance.identity}] ${parts.join(", ")}`;
}

/** Who reaches the Resident through the bot row. */
function botReadLine(platform: string, bot: Provisioning.ChannelInstance): string {
  // Every declared peer is a roster entry of the one a2a door and is admitted at its contact's tier; a peer row's grant block names nothing.
  if (platform === "a2a") return "  READ  every declared a2a peer is admitted through the one door at its contact's tier (a peer row's grant block names nothing)";
  const tier = bot.grant?.defaultTier ?? MOUNT_TIER;
  const who = bot.grant?.allowedSenders === undefined ? "every sender" : "the allowlisted senders";
  const posture = bot.grant?.mentionOnly === true ? " when they mention the bot (or write it a DM)" : "";
  return ADMITTED.has(tier)
    ? `  READ  ${who} on ${platform} reaches the Resident at tier ${tier}${posture}`
    : `  READ  ${who} on ${platform} is admitted at tier ${tier}, which the owner policy does not pass — declare the row with --tier manager (or name people with contact_add)`;
}

/** Who reaches the Resident through the Owner's account. */
function ownerReadLine(platform: string, owner: Provisioning.ChannelInstance): string {
  const intake = setting(owner, "intake") ?? "mentions_and_dms";
  if (intake === "none") return `  READ  your ${platform} account reads nothing (intake none)`;
  if (platform === "linear")
    return intake === "all"
      ? "  READ  every new Linear issue and comment reaches the Resident as receivedBy: owner"
      : "  READ  Linear comments that name you reach the Resident as receivedBy: owner (Linear has no DMs; a keyless row needs ownerUserId to know your name)";
  return intake === "all"
    ? `  READ  everything your ${platform} account sees reaches the Resident as receivedBy: owner`
    : `  READ  DMs to your ${platform} account and mentions of you reach the Resident as receivedBy: owner`;
}

/** Who reaches the Resident on this platform, and how. */
function readLines(platform: string, bot: Provisioning.ChannelInstance | undefined, owner: Provisioning.ChannelInstance | undefined): string[] {
  const lines: string[] = [];
  if (bot?.enabled === true) lines.push(botReadLine(platform, bot));
  if (owner?.enabled === true) lines.push(ownerReadLine(platform, owner));
  if (lines.length === 0) lines.push(`  READ  nothing: no enabled instance on ${platform}`);
  return lines;
}

/** How the Resident answers and writes through the bot row — the identity-less platforms each by their own transport. */
function botWriteLine(platform: string): string {
  switch (platform) {
    case "webhook":
      return "  WRITE the reply door cannot answer on a webhook target — the POST's 200 is its only answer; send_message reaches webhook:<id> when the declaration carries a url";
    case "github":
      return "  WRITE the reply door answers as an issue comment when a token was sealed (keyless, the reply is not_sent and the log says why); send_message writes to owner/repo#N";
    case "a2a":
      return "  WRITE the reply door answers the peer's context; send_message reaches a2a:<id> when the declaration carries a url";
    default:
      return "  WRITE the reply door answers as the bot; send_message writes to a Person with reach (the Owner always)";
  }
}

/** How the Resident answers and writes on this platform. */
function writeLines(platform: string, bot: Provisioning.ChannelInstance | undefined, owner: Provisioning.ChannelInstance | undefined): string[] {
  const lines: string[] = [];
  if (bot?.enabled === true) lines.push(botWriteLine(platform));
  if (owner?.enabled === true) {
    const outbound = owner.grant?.outbound === true;
    const autoReply = setting(owner, "autoReply") === "true";
    if (!outbound) lines.push(`  WRITE your ${platform} account never sends; a reply only it could carry is delivered to you as a draft`);
    else if (autoReply) lines.push(`  WRITE your ${platform} account answers conversations only it reaches, and sends as: owner from an Owner-origin turn`);
    else lines.push(`  WRITE your ${platform} account sends as: owner from an Owner-origin turn; a reply only it could carry is delivered to you as a draft`);
  }
  if (lines.length === 0) lines.push(`  WRITE nothing: no enabled instance on ${platform}`);
  return lines;
}

/** Whether the Owner is known on this platform, and so can instruct the Resident from it — and whether the bot row's allowlist lets them in. */
function ownerLine(
  platform: string,
  owner: Provisioning.Person | undefined,
  bot: Provisioning.ChannelInstance | undefined,
  ownerInstance: Provisioning.ChannelInstance | undefined,
): string {
  const endpoint = owner?.endpoints.find((candidate) => candidate.channel === platform);
  if (endpoint !== undefined) {
    const where = `${endpoint.externalId}${endpoint.workspace === undefined ? "" : ` in ${endpoint.workspace}`}`;
    const allowed = bot?.grant?.allowedSenders;
    return allowed !== undefined && bot?.enabled === true && !allowed.includes(endpoint.externalId)
      ? `  OWNER you are ${where} here (owner-tier), but ${bot.id} admits only its allowlist — add ${endpoint.externalId} to --allow to write to the bot`
      : `  OWNER you are ${where} here (owner-tier)`;
  }
  if (ownerInstance !== undefined && NAMES_ITS_ACCOUNT.has(platform)) return `  OWNER your account binds to the Owner Person when ${ownerInstance.id} mounts`;
  return `  OWNER not known on ${platform}: writing to the bot from your account is a stranger's message until contact_add names your ${platform} id on the Owner Person`;
}

/**
 * The messaging readiness report (#1600 lane R4): every declared platform
 * with who reads it, how the Resident writes on it, and whether the Owner
 * is known there — then the people the Resident may write to cold. Read
 * from the catalog; the first live run proves the rest.
 */
export function messagingReadiness(facts: MessagingFacts): MessagingReport {
  const lines: string[] = [];
  const platforms = [...new Set(facts.instances.map((instance) => instance.provider))].sort();
  if (platforms.length === 0) {
    lines.push("no channel declared: openomni login <platform> for your own account, openomni channel add <platform> for a bot");
    return { lines, ok: false };
  }
  const owner = ownerPerson(facts.persons);
  let ok = true;
  for (const platform of platforms) {
    const rows = facts.instances.filter((instance) => instance.provider === platform);
    lines.push(`${platform}${OWNER_ONLY.has(platform) ? " (reached through your account alone)" : ""}`);
    for (const row of rows) {
      lines.push(rowLine(row, facts.sealed));
      if (row.enabled && (row.credentialRef === undefined || !facts.sealed.has(row.credentialRef))) ok = false;
    }
    const bot = rows.find((row) => row.identity === "bot");
    const ownerInstance = rows.find((row) => row.identity === "owner");
    lines.push(...readLines(platform, bot, ownerInstance), ...writeLines(platform, bot, ownerInstance), ownerLine(platform, owner, bot, ownerInstance));
  }
  const reachable = facts.persons.filter((person) => person.reach === true || person.trustTier === "owner");
  lines.push(
    reachable.length === 0
      ? "reach: nobody — the Resident writes cold to no one until contact_add grants reach"
      : `reach: ${reachable.map((person) => `${person.id} (${person.endpoints.map((endpoint) => endpoint.channel).join("/") || "no endpoint"})`).join(", ")}`,
  );
  return { lines, ok };
}
