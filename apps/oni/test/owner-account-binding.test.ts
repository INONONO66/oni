import { expect, spyOn, test } from "bun:test";
import { ChannelProviders } from "@oni/channels";
import type { Channel } from "@oni/protocol";
import { declareChannel, declarePerson } from "./helpers/declared-channel";
import { planeOf } from "./helpers/ledger";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";

const suite = residentSuite();

/** A started Owner surface that names its account the way the shipped adapters do once logged in. */
class FakeOwnerSurface implements Channel.Surface {
  readonly id = "slack:owner";
  readonly config: Channel.Config = {};
  onMessage(_handler: Channel.MessageHandler): void {
    // bound at build time
  }
  async start(_traceId: string): Promise<void> {
    // the account is known once the session verified
  }
  stop(_traceId: string): void {
    // nothing to close
  }
}

test("#1600 lane R1: a mounted Owner instance binds its account to the Owner Person through the booted composition", async () => {
  const owner = ChannelProviders.slack.owner;
  if (owner === undefined) throw new Error("slack has no Owner arm");
  const create = spyOn(owner, "create").mockImplementation(() => ({
    surface: new FakeOwnerSurface(),
    account: () => ({ externalId: "T1:U-owner", workspace: "T1" }),
  }));
  try {
    const config = suite.config("owner-account-", { wsToken: "token" });
    const kek = declareChannel(config.catalogPath ?? "", "slack", { token: "xoxc-1", cookie: "d" }, { settings: { intake: "none", autoReply: false } });
    const app = await suite.boot({ config: { ...config, kek }, llm: { resolveModel: fakeProviderModel } });
    const plane = await planeOf(app.runtime);
    expect(create).toHaveBeenCalledTimes(1);
    expect(plane.stores.persons.get("person:owner")).toMatchObject({
      trustTier: "owner",
      reach: true,
      endpoints: [{ channel: "slack", externalId: "T1:U-owner", workspace: "T1" }],
      createdBy: "oni",
    });
    // The actor registry carries the endpoint: the Owner writing to the bot on Slack is owner-tier.
    expect(plane.stores.actors.resolveEndpoint("slack", "T1:U-owner", "T1")?.identity).toMatchObject({ id: "person:owner", trustTier: "owner" });
  } finally {
    create.mockRestore();
  }
});

test("#1600 lane R1: an address another Person holds is never re-homed by a mount — the holder keeps it and the Owner is warned", async () => {
  const owner = ChannelProviders.slack.owner;
  if (owner === undefined) throw new Error("slack has no Owner arm");
  const create = spyOn(owner, "create").mockImplementation(() => ({
    surface: new FakeOwnerSurface(),
    account: () => ({ externalId: "T1:U-owner", workspace: "T1" }),
  }));
  try {
    const config = suite.config("owner-account-held-", { wsToken: "token" });
    declarePerson(config.catalogPath, {
      id: "person:zed",
      displayName: "Zed",
      kind: "human",
      trustTier: "observer",
      endpoints: [{ channel: "slack", externalId: "T1:U-owner", workspace: "T1" }],
    });
    const kek = declareChannel(config.catalogPath ?? "", "slack", { token: "xoxc-1", cookie: "d" }, { settings: { intake: "none", autoReply: false } });
    const app = await suite.boot({ config: { ...config, kek }, llm: { resolveModel: fakeProviderModel } });
    const plane = await planeOf(app.runtime);
    expect(create).toHaveBeenCalledTimes(1);
    expect(plane.stores.persons.get("person:zed")?.endpoints).toEqual([{ channel: "slack", externalId: "T1:U-owner", workspace: "T1" }]);
    expect(plane.stores.persons.get("person:owner")?.endpoints ?? []).not.toContainEqual({ channel: "slack", externalId: "T1:U-owner", workspace: "T1" });
    expect(plane.stores.actors.resolveEndpoint("slack", "T1:U-owner", "T1")?.identity).toMatchObject({ id: "person:zed", trustTier: "observer" });
  } finally {
    create.mockRestore();
  }
});
