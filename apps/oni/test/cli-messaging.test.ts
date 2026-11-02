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

test("no declared channels is not ready", () => {
  expect(messagingReadiness({ instances: [], persons: [], sealed: new Set() }).ok).toBe(false);
});

test.each(["slack", "telegram", "github", "webhook", "a2a", "linear", "instagram", "kakaotalk"])("readiness for %s depends on sealed credentials, not inbound rules", (provider) => {
  const row = instance(`channel:${provider}:main`, provider, {
    identity: ["linear", "instagram", "kakaotalk"].includes(provider) ? "owner" : "bot",
  });
  const facts = { instances: [row], persons: [] };
  expect(messagingReadiness({ ...facts, sealed: sealedOf([row]) }).ok).toBe(true);
  expect(messagingReadiness({ ...facts, sealed: new Set() }).ok).toBe(false);
  expect(messagingReadiness({ instances: [{ ...row, enabled: false }], persons: [], sealed: new Set() }).ok).toBe(true);
});

test("the report names where the Owner is known and that delivery follows the rule table", () => {
  const row = instance("channel:slack:main", "slack");
  const owner: Provisioning.Person = {
    id: "person:owner", displayName: "Owner", kind: "human", trustTier: "owner",
    endpoints: [{ channel: "slack", externalId: "U1", workspace: "T1" }], revision: 0, createdBy: "owner", updatedAt: 1,
  };
  const { lines } = messagingReadiness({ instances: [row], persons: [owner], sealed: sealedOf([row]) });
  expect(lines).toContain("  OWNER you are U1 in T1 here (owner-tier); inbound delivery follows the rule table");
  expect(lines).toContain("  READ  channel:slack:main on slack uses the ordered rule table; its seeded rows match non-bot DMs and addressed messages");
});

test("an enabled declaration without a credential reference is not ready", () => {
  expect(messagingReadiness({ instances: [instance("channel:slack:main", "slack", { credentialRef: undefined })], persons: [], sealed: new Set() }).ok).toBe(false);
});
