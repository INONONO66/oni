import { expect, test } from "bun:test";
import type { Provisioning } from "@oni/protocol";
import { messagingReadiness } from "../src/cli/messaging";
import { createCliDeps } from "../src/cli/main";
import { declareChannel } from "./helpers/declared-channel";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const instance = (
  id: string,
  provider: string,
  overrides: Partial<Provisioning.ChannelInstance> = {},
): Provisioning.ChannelInstance => ({
  id,
  provider,
  identity: "bot",
  enabled: true,
  settings: {},
  credentialRef: `secret:${id.slice("channel:".length).replace(/:/g, "-")}`,
  revision: 0,
  createdBy: "owner",
  updatedAt: 1,
  ...overrides,
});

const person = (id: string, trustTier: Provisioning.Person["trustTier"], endpoints: Provisioning.Person["endpoints"], reach?: boolean): Provisioning.Person => ({
  id, displayName: id, kind: "human", trustTier, endpoints, ...(reach === undefined ? {} : { reach }), revision: 0, createdBy: "owner", updatedAt: 1,
});

const sealedOf = (rows: readonly Provisioning.ChannelInstance[]) => new Set(rows.flatMap((row) => (row.credentialRef === undefined ? [] : [row.credentialRef])));

test("CLI readiness reads the declared catalog without modifying its bytes", async () => {
  const home = mkdtempSync(join(tmpdir(), "cli-readiness-"));
  const path = join(home, ".oni", "catalog.sqlite");
  const previousCatalogPath = process.env.ONI_CATALOG_PATH;
  try {
    declareChannel(path, "webhook", { url: "http://127.0.0.1:1" });
    const before = readFileSync(path);
    process.env.ONI_CATALOG_PATH = path;

    const facts = await createCliDeps(home).messagingFacts();

    expect(facts.instances.map((row) => row.id)).toEqual(["channel:webhook:main"]);
    expect([...facts.sealed]).toEqual(["secret:webhook-main"]);
    expect(facts.persons).toEqual([]);
    expect(readFileSync(path)).toEqual(before);
  } finally {
    if (previousCatalogPath === undefined) delete process.env.ONI_CATALOG_PATH;
    else process.env.ONI_CATALOG_PATH = previousCatalogPath;
    rmSync(home, { recursive: true });
  }
});

test("#1600 lane R4: nothing declared is the one-line answer, not a report", () => {
  expect(messagingReadiness({ instances: [], persons: [], sealed: new Set() })).toEqual({
    lines: ["no channel declared: oni login <platform> for your own account, oni channel add <platform> for a bot"],
    ok: false,
  });
});

test("#1600 lane R4: every platform gets its rows, who reads it, how the Resident writes, and whether the Owner is known there", () => {
  const slackBot = instance("channel:slack:main", "slack", { grant: { defaultTier: "manager", allowedSenders: ["T1:U1"], mentionOnly: true } });
  const slackOwner = instance("channel:slack:owner", "slack", { identity: "owner", settings: { intake: "mentions_and_dms", autoReply: false }, grant: { outbound: true } });
  const telegram = instance("channel:telegram:main", "telegram");
  const instagram = instance("channel:instagram:owner", "instagram", { identity: "owner", settings: { intake: "all", autoReply: true }, grant: { outbound: true } });
  const kakao = instance("channel:kakaotalk:owner", "kakaotalk", { identity: "owner", settings: { intake: "none", autoReply: false } });
  const github = instance("channel:github:main", "github", { grant: { defaultTier: "co_owner" } });
  const off = instance("channel:discord:main", "discord", { enabled: false });
  const unsealed = instance("channel:webhook:hooky", "webhook");
  const sealed = sealedOf([slackBot, slackOwner, telegram, instagram, kakao, github, off]);
  const owner = person("person:owner", "owner", [{ channel: "ws", externalId: "owner" }, { channel: "slack", externalId: "T1:U-owner", workspace: "T1" }]);
  const buyer = person("person:buyer", "collaborator", [{ channel: "telegram", externalId: "7" }], true);
  const stranger = person("person:zed", "observer", [{ channel: "discord", externalId: "D9" }]);
  const report = messagingReadiness({ instances: [slackBot, slackOwner, telegram, instagram, kakao, github, off, unsealed], persons: [owner, buyer, stranger], sealed });
  expect(report.ok).toBe(false);
  expect(report.lines).toEqual([
    "discord",
    "  channel:discord:main [bot] DISABLED, credential sealed",
    "  READ  nothing: no enabled instance on discord",
    "  WRITE nothing: no enabled instance on discord",
    "  OWNER not known on discord: writing to the bot from your account is a stranger's message until contact_add names your discord id on the Owner Person",
    "github",
    "  channel:github:main [bot] enabled, credential sealed, tier co_owner",
    "  READ  every sender on github reaches the Resident at tier co_owner",
    "  WRITE the reply door answers as an issue comment when a token was sealed (keyless, the reply is not_sent and the log says why); send_message writes to owner/repo#N",
    "  OWNER not known on github: writing to the bot from your account is a stranger's message until contact_add names your github id on the Owner Person",
    "instagram (reached through your account alone)",
    "  channel:instagram:owner [owner] enabled, credential sealed, intake all, outbound, auto-reply",
    "  READ  everything your instagram account sees reaches the Resident as receivedBy: owner",
    "  WRITE your instagram account answers conversations only it reaches, and sends as: owner from an Owner-origin turn",
    "  OWNER your account binds to the Owner Person when channel:instagram:owner mounts",
    "kakaotalk (reached through your account alone)",
    "  channel:kakaotalk:owner [owner] enabled, credential sealed, intake none, inbound-only",
    "  READ  your kakaotalk account reads nothing (intake none)",
    "  WRITE your kakaotalk account never sends; a reply only it could carry is delivered to you as a draft",
    "  OWNER your account binds to the Owner Person when channel:kakaotalk:owner mounts",
    "slack",
    "  channel:slack:main [bot] enabled, credential sealed, tier manager, allow [T1:U1], mention-only",
    "  channel:slack:owner [owner] enabled, credential sealed, intake mentions_and_dms, outbound",
    "  READ  the allowlisted senders on slack reaches the Resident at tier manager when they mention the bot (or write it a DM)",
    "  READ  DMs to your slack account and mentions of you reach the Resident as receivedBy: owner",
    "  WRITE the reply door answers as the bot; send_message writes to a Person with reach (the Owner always)",
    "  WRITE your slack account sends as: owner from an Owner-origin turn; a reply only it could carry is delivered to you as a draft",
    "  OWNER you are T1:U-owner in T1 here (owner-tier), but channel:slack:main admits only its allowlist — add T1:U-owner to --allow to write to the bot",
    "telegram",
    "  channel:telegram:main [bot] enabled, credential sealed",
    "  READ  every sender on telegram is admitted at tier assigned_worker, which the owner policy does not pass — declare the row with --tier manager (or name people with contact_add)",
    "  WRITE the reply door answers as the bot; send_message writes to a Person with reach (the Owner always)",
    "  OWNER not known on telegram: writing to the bot from your account is a stranger's message until contact_add names your telegram id on the Owner Person",
    "webhook",
    "  channel:webhook:hooky [bot] enabled, credential secret:webhook-hooky MISSING from the vault",
    "  READ  every sender on webhook is admitted at tier assigned_worker, which the owner policy does not pass — declare the row with --tier manager (or name people with contact_add)",
    "  WRITE the reply door cannot answer on a webhook target — the POST's 200 is its only answer; send_message reaches webhook:<id> when the declaration carries a url",
    "  OWNER not known on webhook: writing to the bot from your account is a stranger's message until contact_add names your webhook id on the Owner Person",
    "reach: person:owner (ws/slack), person:buyer (telegram)",
  ]);
});

test("#1600 lane R4: an a2a peer is admitted at its contact's tier through the one door; Linear names no account, so the Owner is known there only through contact_add; an allowlist that names the Owner lets them in", () => {
  const peer = instance("channel:a2a:scout", "a2a", { grant: { defaultTier: "manager" } });
  const linear = instance("channel:linear:owner", "linear", { identity: "owner", settings: { intake: "mentions_and_dms", autoReply: false } });
  const linearAll = instance("channel:linear:owner", "linear", { identity: "owner", settings: { intake: "all", autoReply: false } });
  const slackBot = instance("channel:slack:main", "slack", { grant: { defaultTier: "manager", allowedSenders: ["T1:U-owner"] } });
  const owner = person("person:owner", "owner", [{ channel: "slack", externalId: "T1:U-owner", workspace: "T1" }]);
  const report = messagingReadiness({ instances: [peer, linear, slackBot], persons: [owner], sealed: sealedOf([peer, linear, slackBot]) });
  expect(report.ok).toBe(true);
  expect(report.lines).toEqual([
    "a2a",
    "  channel:a2a:scout [bot] enabled, credential sealed, tier manager",
    "  READ  every declared a2a peer is admitted through the one door at its contact's tier (a peer row's grant block names nothing)",
    "  WRITE the reply door answers the peer's context; send_message reaches a2a:<id> when the declaration carries a url",
    "  OWNER not known on a2a: writing to the bot from your account is a stranger's message until contact_add names your a2a id on the Owner Person",
    "linear (reached through your account alone)",
    "  channel:linear:owner [owner] enabled, credential sealed, intake mentions_and_dms, inbound-only",
    "  READ  Linear comments that name you reach the Resident as receivedBy: owner (Linear has no DMs; a keyless row needs ownerUserId to know your name)",
    "  WRITE your linear account never sends; a reply only it could carry is delivered to you as a draft",
    "  OWNER not known on linear: writing to the bot from your account is a stranger's message until contact_add names your linear id on the Owner Person",
    "slack",
    "  channel:slack:main [bot] enabled, credential sealed, tier manager, allow [T1:U-owner]",
    "  READ  the allowlisted senders on slack reaches the Resident at tier manager",
    "  WRITE the reply door answers as the bot; send_message writes to a Person with reach (the Owner always)",
    "  OWNER you are T1:U-owner in T1 here (owner-tier)",
    "reach: person:owner (slack)",
  ]);
  expect(messagingReadiness({ instances: [linearAll], persons: [], sealed: sealedOf([linearAll]) }).lines[2]).toBe(
    "  READ  every new Linear issue and comment reaches the Resident as receivedBy: owner",
  );
});

test("#1600 lane R4: a declared, sealed bot with a tier is ready; nobody reachable is said plainly", () => {
  const telegram = instance("channel:telegram:main", "telegram", { grant: { defaultTier: "manager" } });
  const report = messagingReadiness({ instances: [telegram], persons: [], sealed: new Set([telegram.credentialRef ?? ""]) });
  expect(report.ok).toBe(true);
  expect(report.lines.at(-1)).toBe("reach: nobody — the Resident writes cold to no one until contact_add grants reach");
});
