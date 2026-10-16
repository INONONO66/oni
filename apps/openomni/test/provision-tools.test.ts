import { bundleTools, testToolPorts } from "./helpers/tool-ports";
import { dispatcherFixture } from "./helpers/dispatcher-fixture";
import { Effect } from "effect";
import { runEffect } from "./helpers/effect";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Vault } from "@openomni/channels";
import { testPlane } from "./helpers/ledger";
import type { AppLedgerPlane } from "../src/composition/cluster-runtime";
import { type PlainObject, Provisioning } from "@openomni/protocol";
import type { ChannelRuntimeStatus } from "../src/bundles/provision/supervisor";
import { Core } from "@openomni/agent";
const eraseTool = Core.eraseTool;
import { createProvisionTool } from "../src/bundles/provision/provision";
import { provisionApproval } from "../src/bundles/provision/execution";
import type { ProvisionPort } from "../src/bundles/provision/channels";
import { executor } from "./helpers/executor";
import { bounded, protectedDispatch } from "./helpers/protected-dispatch";
import { dispatchModelTool, modelToolOutput } from "./helpers/tool-dispatch";

const NOW = 1_756_000_000_000;
const RESIDENT = { role: "resident", sessionId: "provision-test" } as const;

const provisionTool = (name: string, port: ProvisionPort, now: () => number = Date.now) => {
  const run = modelToolOutput("provision", { provisioning: port }, RESIDENT, now);
  const op = name === "provision_status" ? "status" : name;
  return (input: PlainObject) => run({ operation: { op, args: input } });
};
const personDeclare = (port: ProvisionPort, now?: () => number) =>
  provisionTool("contact_add", port, now);
const personRemove = (port: ProvisionPort) => provisionTool("contact_remove", port);
const channelDeclare = (port: ProvisionPort, now?: () => number) =>
  provisionTool("channel_add", port, now);
const channelEnable = (port: ProvisionPort, now?: () => number) =>
  provisionTool("channel_enable", port, now);
const channelDisable = (port: ProvisionPort, now?: () => number) =>
  provisionTool("channel_disable", port, now);
const secretRotate = (port: ProvisionPort, now?: () => number) =>
  provisionTool("secret_rotate", port, now);
const provisionStatus = (port: ProvisionPort) => provisionTool("provision_status", port);
const KEK = Vault.kekOf(new Uint8Array(32).fill(7));

interface FakeSupervisor {
  readonly calls: string[];
  statuses: ChannelRuntimeStatus[];
}

function portWith(overrides: Partial<ProvisionPort> = {}): {
  port: ProvisionPort;
  supervisor: FakeSupervisor;
} {
  const supervisor: FakeSupervisor = { calls: [], statuses: [] };
  const port: ProvisionPort = {
    persons: plane().stores.persons,
    instances: plane().stores.instances,
    secrets: plane().stores.secrets,
    actors: plane().stores.actors,
    transaction: plane().catalog.transaction,
    kek: { kind: "ok", kek: KEK },
    supervisor: {
      reconcile: async () => {
        supervisor.calls.push("reconcile");
        return supervisor.statuses;
      },
      resume: (instanceId) => {
        supervisor.calls.push(`resume:${instanceId}`);
        return true;
      },
      status: () => supervisor.statuses,
      source: () => "declared",
    },
    materialize: () => {
      supervisor.calls.push("materialize");
    },
    removeIdentity: (id) => {
      supervisor.calls.push(`removeIdentity:${id}`);
      return true;
    },
    bundles: { names: () => [], off: () => [], set: async () => undefined },
    ...overrides,
  };
  return { port, supervisor };
}

const MANAGER_MANIFEST = {
  id: "person:sunwoo",
  kind: "human" as const,
  trustTier: "manager" as const,
  endpoints: [{ channel: "telegram", externalId: "555" }],
};

const planeRef: { current: AppLedgerPlane | undefined } = { current: undefined };
function plane(): AppLedgerPlane {
  if (planeRef.current === undefined) throw new Error("test plane not open");
  return planeRef.current;
}

beforeEach(() => {
  planeRef.current = testPlane();
});

afterEach(() => {
  planeRef.current?.close();
  planeRef.current = undefined;
});

describe("provision output boundary", () => {
  test("rejects malformed output through the dispatcher", async () => {
    const { port } = portWith();
    const tool = eraseTool(createProvisionTool(port, () => 1000));
    const result = await runEffect(dispatcherFixture([{ ...tool, execute: async () => ({ op: "status" }) }], {
      executor,
    }).execute(
      {
        id: "provision-invalid-output",
        tool: "provision",
        input: { operation: { op: "status", args: {} } },
      },
      { sessionId: "provision-session", turnId: "provision-turn" },
    ));

    expect(result).toEqual({
      toolCallId: "provision-invalid-output",
      id: "provision-invalid-output",
      toolName: "provision",
      content: "provision produced invalid output",
      isError: true,
      errorKind: "invalid_output",
      details: { errorKind: "invalid_output" },
    });
  });
});

/** Open the Owner-consent request for declaring one manifest through the protected dispatcher. */
function consentedDeclare(port: ProvisionPort, manifest: PlainObject) {
  // The answer-time domain-revision read must consult the same plane the
  // tool port mutates; a private dispatch plane reads every person as absent
  // (-1) and rejects the consent as stale.
  return protectedDispatch(
    eraseTool(createProvisionTool(port, () => 1000)),
    { operation: { op: "contact_add", args: { manifest } } },
    undefined,
    { plane: plane() },
  );
}

describe("original Person invocation consent", () => {
  test("a protected raise suspends then applies the exact original manifest once", async () => {
    const { port, supervisor } = portWith();
    const f = consentedDeclare(port, MANAGER_MANIFEST);
    try {
      const request = await bounded(f.opened);
      expect(request.parsedInput).toEqual({
        operation: { op: "contact_add", args: { manifest: MANAGER_MANIFEST } },
      });
      expect(plane().stores.persons.get(MANAGER_MANIFEST.id)).toBeUndefined();
      expect(supervisor.calls).toEqual([]);
      expect((await f.answer()).isError).toBeUndefined();
      expect(plane().stores.persons.get(MANAGER_MANIFEST.id)?.trustTier).toBe("manager");
      expect(plane().stores.persons.get(MANAGER_MANIFEST.id)?.revision).toBe(0);
      expect(supervisor.calls).toEqual(["materialize"]);
    } finally {
      await f.close();
    }
  });
  test("refusal leaves the Person unchanged and approvalId cannot mint authority", async () => {
    const { port } = portWith();
    const f = consentedDeclare(port, MANAGER_MANIFEST);
    try {
      expect((await f.answer("refuse")).isError).toBe(true);
      expect(plane().stores.persons.get(MANAGER_MANIFEST.id)).toBeUndefined();
      const forged = await personDeclare(port)({
        manifest: MANAGER_MANIFEST,
        approvalId: "invented",
      });
      expect(forged).toContain("Unrecognized key");
      expect(plane().stores.persons.get(MANAGER_MANIFEST.id)).toBeUndefined();
    } finally {
      await f.close();
    }
  });
  test("a collaborator declaration remains direct", async () => {
    const { port } = portWith();
    await personDeclare(port)({ manifest: { ...MANAGER_MANIFEST, trustTier: "collaborator" } });
    expect(plane().stores.persons.get(MANAGER_MANIFEST.id)?.trustTier).toBe("collaborator");
  });
  test("the act itself refuses consent bound to a Person revision that no longer holds", async () => {
    const { port, supervisor } = portWith();
    const tool = createProvisionTool(port, () => 1000);
    const context = {
      sessionId: "provision-session",
      turnId: "provision-turn",
      callId: "stale-consent",
      signal: new AbortController().signal,
    };
    const declare = (domainRevisions: Record<string, number>) =>
      tool.execute(
        { operation: { op: "contact_add", args: { manifest: MANAGER_MANIFEST } } },
        { ...context, domainRevisions },
      );
    await expect(declare({ [MANAGER_MANIFEST.id]: 0 })).rejects.toThrow("domain revision changed");
    expect(plane().stores.persons.get(MANAGER_MANIFEST.id)).toBeUndefined();
    expect(supervisor.calls).toEqual([]);
    expect(await declare({ [MANAGER_MANIFEST.id]: -1 })).toMatchObject({
      op: "contact_add",
      result: { kind: "declared", id: MANAGER_MANIFEST.id, revision: 0 },
    });
    expect(supervisor.calls).toEqual(["materialize"]);
  });
  test("domain revision changes invalidate consent instead of applying a stale manifest", async () => {
    const { port } = portWith();
    const f = consentedDeclare(port, MANAGER_MANIFEST);
    try {
      await bounded(f.opened);
      plane().stores.persons.put({
        ...MANAGER_MANIFEST,
        displayName: "Changed",
        trustTier: "observer",
        revision: 0,
        createdBy: "resident",
        updatedAt: NOW,
      });
      await expect(f.answer()).rejects.toMatchObject({ code: "stale_approval" });
      expect(plane().stores.persons.get(MANAGER_MANIFEST.id)?.trustTier).toBe("observer");
    } finally {
      await f.close();
    }
  });
});

describe("owner Person protection and sole owner", () => {
  const ownerManifest = {
    id: "person:ino",
    displayName: "Ino",
    kind: "human" as const,
    trustTier: "owner" as const,
    endpoints: [{ channel: "telegram", externalId: "1" }],
  };
  function putOwner() {
    plane().stores.persons.put({ ...ownerManifest, revision: 0, createdBy: "openomni-init", updatedAt: NOW });
  }
  test("same-tier owner endpoint edits suspend and apply only after consent", async () => {
    putOwner();
    const { port } = portWith();
    const edited = {
      ...ownerManifest,
      endpoints: [...ownerManifest.endpoints, { channel: "discord", externalId: "2" }],
    };
    const f = consentedDeclare(port, edited);
    try {
      await bounded(f.opened);
      expect(plane().stores.persons.get(ownerManifest.id)?.endpoints).toHaveLength(1);
      expect((await f.answer()).isError).toBeUndefined();
      expect(plane().stores.persons.get(ownerManifest.id)?.endpoints).toHaveLength(2);
      expect(plane().stores.persons.get(ownerManifest.id)?.revision).toBe(1);
    } finally {
      await f.close();
    }
  });
  test("consent cannot bypass the sole-owner store invariant", async () => {
    putOwner();
    const { port } = portWith();
    const f = consentedDeclare(port, { ...ownerManifest, id: "person:second", endpoints: [] });
    try {
      expect((await f.answer()).isError).toBe(true);
      expect(plane().stores.persons.get("person:second")).toBeUndefined();
      expect(plane().stores.persons.get(ownerManifest.id)?.trustTier).toBe("owner");
    } finally {
      await f.close();
    }
  });
  test("contact_remove refuses the owner and removes other people", async () => {
    putOwner();
    plane().stores.persons.put({
      ...MANAGER_MANIFEST,
      displayName: "Sunwoo",
      trustTier: "collaborator",
      revision: 0,
      createdBy: "resident",
      updatedAt: NOW,
    });
    const { port, supervisor } = portWith();
    expect(await personRemove(port)({ personId: ownerManifest.id })).toContain("sole owner");
    expect(await personRemove(port)({ personId: "person:ghost" })).toContain("does not exist");
    await personRemove(port)({ personId: MANAGER_MANIFEST.id });
    expect(plane().stores.persons.get(MANAGER_MANIFEST.id)).toBeUndefined();
    expect(supervisor.calls).toEqual(["removeIdentity:person:sunwoo"]);
  });
});

describe("channel administration ends in reconcile (§5, §8.7)", () => {
  test("channel_add validates the credential BEFORE anything lands", async () => {
    const { port, supervisor } = portWith();
    const result = await channelDeclare(
      port,
      () => NOW,
    )({
      id: "channel:telegram:main",
      provider: "telegram",
      credential: { wrong: "field" },
    });
    expect(result).toContain("channel_add refused:");
    expect(plane().stores.instances.get("channel:telegram:main")).toBeUndefined();
    expect(plane().stores.secrets.get("secret:channel-telegram-main")).toBeUndefined();
    expect(supervisor.calls).toEqual([]);
  });

  test("channel_add refuses an unregistered provider before anything lands", async () => {
    const { port, supervisor } = portWith();
    const result = await channelDeclare(
      port,
      () => NOW,
    )({
      id: "channel:matrix:main",
      provider: "matrix",
      credential: { token: "x" },
    });
    expect(result).toContain("unknown provider matrix");
    expect(plane().stores.instances.get("channel:matrix:main")).toBeUndefined();
    expect(supervisor.calls).toEqual([]);
  });

  test("§4 channel_add refuses unknown settings knobs — never accepted-and-ignored", async () => {
    const { port, supervisor } = portWith();
    const result = await channelDeclare(
      port,
      () => NOW,
    )({
      id: "channel:telegram:main",
      provider: "telegram",
      credential: { token: "tg-token" },
      settings: { knob: "x" },
    });
    expect(result).toContain("channel_add refused:");
    expect(plane().stores.instances.get("channel:telegram:main")).toBeUndefined();
    expect(supervisor.calls).toEqual([]);
  });

  test("a store refusal while landing the row surfaces as the tool's refusal, not a crash", async () => {
    const { port, supervisor } = portWith({
      instances: {
        ...plane().stores.instances,
        put: () => {
          throw new Provisioning.StoreError({
            message: "instance store is read-only during migration",
            code: "adapter_absent",
          });
        },
      },
    });
    const result = await channelDeclare(
      port,
      () => NOW,
    )({ id: "channel:telegram:main", provider: "telegram", credential: { token: "tg-token" } });
    expect(result).toBe("channel_add refused: instance store is read-only during migration");
    expect(supervisor.calls).toEqual([]);
  });

  test("a valid declaration seals the credential, lands the row, and reconciles", async () => {
    const { port, supervisor } = portWith();
    supervisor.statuses = [{ id: "channel:telegram:main", surface: "telegram", state: "mounted" }];
    const result = await channelDeclare(
      port,
      () => NOW,
    )({
      id: "channel:telegram:main",
      provider: "telegram",
      credential: { token: "tg-token" },
    });
    expect(result).toContain("channel channel:telegram:main declared");
    expect(result).toContain("channel:telegram:main → mounted");
    const instance = plane().stores.instances.get("channel:telegram:main");
    expect(instance?.credentialRef).toBe("secret:channel-telegram-main");
    expect(instance?.revision).toBe(0);
    const secret = plane().stores.secrets.get("secret:channel-telegram-main");
    if (secret === undefined) throw new Error("expected a sealed secret");
    const opened = Vault.open(secret, KEK).reveal();
    expect(new TextDecoder().decode(opened)).toBe('{"token":"tg-token"}');
    expect(supervisor.calls).toEqual(["reconcile"]);
  });

  test("a locked vault refuses to seal — declaration never half-lands", async () => {
    const { port } = portWith({ kek: { kind: "locked", reason: "no OPENOMNI_VAULT_KEY" } });
    const result = await channelDeclare(
      port,
      () => NOW,
    )({
      id: "channel:telegram:main",
      provider: "telegram",
      credential: { token: "tg-token" },
    });
    expect(result).toContain("vault is locked (no OPENOMNI_VAULT_KEY)");
    expect(plane().stores.instances.get("channel:telegram:main")).toBeUndefined();
  });

  test("a locked vault refuses to rotate — the sealed secret stays as it was", async () => {
    const { port, supervisor } = portWith();
    await channelDeclare(
      port,
      () => NOW,
    )({ id: "channel:telegram:main", provider: "telegram", credential: { token: "old-token" } });
    const locked = portWith({ kek: { kind: "locked", reason: "no OPENOMNI_VAULT_KEY" } }).port;
    const result = await secretRotate(
      locked,
      () => NOW + 10,
    )({ secretId: "secret:channel-telegram-main", credential: { token: "new-token" } });
    expect(result).toContain("secret_rotate refused: vault is locked (no OPENOMNI_VAULT_KEY)");
    expect(plane().stores.secrets.get("secret:channel-telegram-main")?.rotatedAt).toBeUndefined();
    expect(supervisor.calls).toEqual(["reconcile"]);
  });

  test("enable re-arms the breaker then reconciles; disable just reconciles", async () => {
    const { port, supervisor } = portWith();
    await channelDeclare(
      port,
      () => NOW,
    )({
      id: "channel:telegram:main",
      provider: "telegram",
      credential: { token: "tg-token" },
    });
    supervisor.calls.length = 0;

    const disabled = await channelDisable(
      port,
      () => NOW + 1,
    )({
      instanceId: "channel:telegram:main",
    });
    expect(disabled).toContain("channel channel:telegram:main disabled");
    expect(plane().stores.instances.get("channel:telegram:main")?.enabled).toBe(false);
    expect(supervisor.calls).toEqual(["reconcile"]);

    const enabled = await channelEnable(
      port,
      () => NOW + 2,
    )({
      instanceId: "channel:telegram:main",
    });
    expect(enabled).toContain("channel channel:telegram:main enabled");
    expect(plane().stores.instances.get("channel:telegram:main")?.enabled).toBe(true);
    expect(plane().stores.instances.get("channel:telegram:main")?.revision).toBe(2);
    expect(supervisor.calls).toEqual(["reconcile", "resume:channel:telegram:main", "reconcile"]);

    expect(await channelEnable(port)({ instanceId: "channel:ghost:x" })).toContain(
      "is not declared",
    );
  });

  test("#1569 an Owner instance, and any change to its outbound grant, lands only with Owner consent bound to the row's revision", async () => {
    const { port, supervisor } = portWith();
    const tool = createProvisionTool(port, () => NOW);
    const context = {
      sessionId: "provision-session",
      turnId: "provision-turn",
      callId: "owner-consent",
      signal: new AbortController().signal,
    };
    const args = {
      id: "channel:slack:owner",
      provider: "slack",
      identity: "owner" as const,
      outbound: true,
      enabled: true,
      settings: {},
      credential: { token: "xoxc-1", cookie: "d" },
    };
    const redeclare = { id: "channel:slack:owner", provider: "slack", enabled: true, settings: {} };
    const approval = provisionApproval(port);
    expect(approval({ operation: { op: "channel_add", args } }, context)).toEqual({
      required: true,
      domainRevisions: { "channel:slack:owner": -1 },
    });
    // A bot declaration without an outbound grant stays the Resident's own call.
    expect(
      approval(
        { operation: { op: "channel_add", args: { id: "channel:slack:hq", provider: "slack", enabled: true, settings: {} } } },
        context,
      ),
    ).toMatchObject({ required: false });
    // The direct path (no consent on the invocation) refuses before anything lands or reconciles.
    await expect(tool.execute({ operation: { op: "channel_add", args } }, context)).rejects.toThrow(
      "channel:slack:owner: an Owner instance, its outbound grant and a webhook target's or a2a peer's url require Owner consent",
    );
    // A webhook declaration naming a url is an outbound destination: the Owner's call, never the Resident's own.
    const target = {
      id: "channel:webhook:out",
      provider: "webhook",
      enabled: true,
      settings: {},
      credential: { id: "out", secret: "shared", url: "https://hooks.example/in" },
    };
    expect(approval({ operation: { op: "channel_add", args: target } }, context)).toEqual({
      required: true,
      domainRevisions: { "channel:webhook:out": -1 },
    });
    expect(
      approval(
        { operation: { op: "channel_add", args: { ...target, credential: { id: "out", secret: "shared" } } } },
        context,
      ),
    ).toMatchObject({ required: false });
    await expect(tool.execute({ operation: { op: "channel_add", args: target } }, context)).rejects.toThrow(
      "channel:webhook:out: an Owner instance, its outbound grant and a webhook target's or a2a peer's url require Owner consent",
    );
    expect(plane().stores.instances.get("channel:webhook:out")).toBeUndefined();
    expect(plane().stores.instances.get("channel:slack:owner")).toBeUndefined();
    expect(supervisor.calls).toEqual([]);
    // Consent given against another revision no longer holds.
    await expect(
      tool.execute({ operation: { op: "channel_add", args } }, { ...context, domainRevisions: { "channel:slack:owner": 3 } }),
    ).rejects.toThrow("domain revision changed");
    expect(plane().stores.instances.get("channel:slack:owner")).toBeUndefined();
    // Matching consent lands the Owner row with its grant and reconciles once.
    expect(
      await tool.execute({ operation: { op: "channel_add", args } }, { ...context, domainRevisions: { "channel:slack:owner": -1 } }),
    ).toMatchObject({ op: "channel_add", id: "channel:slack:owner", action: "declared" });
    expect(plane().stores.instances.get("channel:slack:owner")).toMatchObject({
      identity: "owner",
      grant: { outbound: true },
      credentialRef: "secret:channel-slack-owner",
      revision: 0,
    });
    expect(supervisor.calls).toEqual(["reconcile"]);
    // Re-declaring the row keeps its identity (and so keeps needing consent), even when the call omits `identity`.
    expect(approval({ operation: { op: "channel_add", args: redeclare } }, context)).toEqual({
      required: true,
      domainRevisions: { "channel:slack:owner": 0 },
    });
    expect(
      await tool.execute(
        { operation: { op: "channel_add", args: { ...redeclare, outbound: false } } },
        { ...context, domainRevisions: { "channel:slack:owner": 0 } },
      ),
    ).toMatchObject({ action: "declared" });
    expect(plane().stores.instances.get("channel:slack:owner")).toMatchObject({
      identity: "owner",
      grant: { outbound: false },
      credentialRef: "secret:channel-slack-owner",
      revision: 1,
    });
    // With consent the target lands; a rotation may never introduce a url behind the Owner's back.
    expect(
      await tool.execute({ operation: { op: "channel_add", args: target } }, { ...context, domainRevisions: { "channel:webhook:out": -1 } }),
    ).toMatchObject({ action: "declared" });
    await expect(
      tool.execute(
        {
          operation: {
            op: "secret_rotate",
            args: { secretId: "secret:channel-webhook-out", credential: { id: "out", secret: "rotated", url: "https://else.example/in" } },
          },
        },
        context,
      ),
    ).rejects.toThrow("channel:webhook:out: a url is declared through channel_add under Owner consent, never by rotation");
    // An a2a peer's url is where the Resident's letters (and the shared bearer) go: the same consent, the same rotation rule (lane 9c).
    const peer = {
      id: "channel:a2a:scout",
      provider: "a2a",
      enabled: true,
      settings: {},
      credential: { token: "scout-token", url: "https://scout.example" },
    };
    expect(approval({ operation: { op: "channel_add", args: peer } }, context)).toEqual({
      required: true,
      domainRevisions: { "channel:a2a:scout": -1 },
    });
    expect(approval({ operation: { op: "channel_add", args: { ...peer, credential: { token: "scout-token" } } } }, context)).toMatchObject({ required: false });
    await expect(tool.execute({ operation: { op: "channel_add", args: peer } }, context)).rejects.toThrow(
      "channel:a2a:scout: an Owner instance, its outbound grant and a webhook target's or a2a peer's url require Owner consent",
    );
    expect(plane().stores.instances.get("channel:a2a:scout")).toBeUndefined();
    expect(
      await tool.execute({ operation: { op: "channel_add", args: { ...peer, credential: { token: "scout-token" } } } }, context),
    ).toMatchObject({ action: "declared" });
    await expect(
      tool.execute(
        { operation: { op: "secret_rotate", args: { secretId: "secret:channel-a2a-scout", credential: { token: "rotated", url: "https://scout.example" } } } },
        context,
      ),
    ).rejects.toThrow("channel:a2a:scout: a url is declared through channel_add under Owner consent, never by rotation");
  });

  test("#1569 an Owner instance's knobs are its intake posture, validated under the resolved identity", async () => {
    const { port } = portWith();
    const tool = createProvisionTool(port, () => NOW);
    const context = {
      sessionId: "provision-session",
      turnId: "provision-turn",
      callId: "owner-posture",
      signal: new AbortController().signal,
      domainRevisions: { "channel:slack:owner": -1 },
    };
    const declare = (settings: Record<string, string>) =>
      tool.execute(
        {
          operation: {
            op: "channel_add",
            args: {
              id: "channel:slack:owner",
              provider: "slack",
              identity: "owner",
              enabled: true,
              settings,
              credential: { token: "xoxc-1", cookie: "d" },
            },
          },
        },
        context,
      );
    await expect(declare({ intake: "loud" })).rejects.toThrow("channel_add refused:");
    expect(plane().stores.instances.get("channel:slack:owner")).toBeUndefined();
    expect(await declare({ intake: "all" })).toMatchObject({ action: "declared" });
    expect(plane().stores.instances.get("channel:slack:owner")?.settings).toEqual({ intake: "all" });
    // A re-declaration that says nothing about settings keeps the posture.
    expect(
      await tool.execute(
        { operation: { op: "channel_add", args: { id: "channel:slack:owner", provider: "slack", enabled: true, outbound: true } } },
        { ...context, domainRevisions: { "channel:slack:owner": 0 } },
      ),
    ).toMatchObject({ action: "declared" });
    expect(plane().stores.instances.get("channel:slack:owner")).toMatchObject({ settings: { intake: "all" }, grant: { outbound: true } });
    // A bot declaration never carries the posture knob.
    expect(await channelDeclare(port, () => NOW)({ id: "channel:slack:hq", provider: "slack", settings: { intake: "all" }, credential: { botToken: "xoxb-1", appToken: "xapp-1" } })).toContain(
      "channel_add refused:",
    );
  });

  test("#1569 secret_rotate validates an Owner instance's replacement under the Owner arm's schema", async () => {
    const { port } = portWith();
    const tool = createProvisionTool(port, () => NOW);
    const context = {
      sessionId: "provision-session",
      turnId: "provision-turn",
      callId: "owner-rotate",
      signal: new AbortController().signal,
      domainRevisions: { "channel:slack:owner": -1 },
    };
    await tool.execute(
      {
        operation: {
          op: "channel_add",
          args: {
            id: "channel:slack:owner",
            provider: "slack",
            identity: "owner",
            enabled: true,
            settings: {},
            credential: { token: "xoxc-old", cookie: "d-old" },
          },
        },
      },
      context,
    );
    const botTokens = await secretRotate(
      port,
      () => NOW + 10,
    )({ secretId: "secret:channel-slack-owner", credential: { botToken: "xoxb-1", appToken: "xapp-1" } });
    expect(botTokens).toContain("secret_rotate refused: channel:slack:owner:");
    expect(plane().stores.secrets.get("secret:channel-slack-owner")?.rotatedAt).toBeUndefined();
    const rotated = await secretRotate(
      port,
      () => NOW + 10,
    )({ secretId: "secret:channel-slack-owner", credential: { token: "xoxc-new", cookie: "d-new" } });
    expect(rotated).toContain("rotated");
    expect(plane().stores.secrets.get("secret:channel-slack-owner")?.rotatedAt).toBe(NOW + 10);
  });

  test("§8.7 secret_rotate keeps the id, bumps rotatedAt, and bounces via reconcile", async () => {
    const { port, supervisor } = portWith();
    await channelDeclare(
      port,
      () => NOW,
    )({
      id: "channel:telegram:main",
      provider: "telegram",
      credential: { token: "old-token" },
    });
    supervisor.calls.length = 0;

    const invalid = await secretRotate(
      port,
      () => NOW + 10,
    )({
      secretId: "secret:channel-telegram-main",
      credential: { wrong: "field" },
    });
    expect(invalid).toContain("secret_rotate refused: channel:telegram:main:");
    expect(plane().stores.secrets.get("secret:channel-telegram-main")?.rotatedAt).toBeUndefined();

    const rotated = await secretRotate(
      port,
      () => NOW + 10,
    )({
      secretId: "secret:channel-telegram-main",
      credential: { token: "new-token" },
    });
    expect(rotated).toContain("secret secret:channel-telegram-main rotated");
    const secret = plane().stores.secrets.get("secret:channel-telegram-main");
    expect(secret?.createdAt).toBe(NOW);
    expect(secret?.rotatedAt).toBe(NOW + 10);
    expect(supervisor.calls).toEqual(["reconcile"]);

    expect(
      await secretRotate(port)({ secretId: "secret:ghost", credential: { token: "x" } }),
    ).toContain("does not exist");
  });

  test("catalog gate: provisioning administration is the Resident's alone", () => {
    const { port } = portWith();
    const provisionTools = ["provision"];
    const definitions = bundleTools({ ...testToolPorts, provisioning: port });
    const resident = definitions.filter((entry: import("@openomni/protocol").AnyToolDefinition) => entry.visibility.model.includes("resident")).map((entry: import("@openomni/protocol").AnyToolDefinition) => entry.name);
    const child = definitions.filter((entry: import("@openomni/protocol").AnyToolDefinition) => entry.visibility.model.includes("child")).map((entry: import("@openomni/protocol").AnyToolDefinition) => entry.name);
    for (const name of provisionTools) {
      expect(resident).toContain(name);
      expect(child).not.toContain(name);
    }
  });

  test("catalog gate: an uncomposed provisioning port keeps the tool and refuses", async () => {
    const result = await dispatchModelTool(
      "provision",
      {},
    )({
      operation: { op: "status", args: {} },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toBe("provision refused: provisioning is not composed");
  });

  test("provision_status reports source, vault state, and per-instance verdicts", async () => {
    const { port, supervisor } = portWith();
    supervisor.statuses = [
      {
        id: "channel:telegram:main",
        surface: "telegram",
        state: "paused_by_breaker",
        detail: "3 consecutive start failures; channel_enable re-arms it",
      },
    ];
    const result = await provisionStatus(port)({});
    expect(result).toContain("channel source: declared");
    expect(result).toContain("vault open");
    expect(result).toContain("channel:telegram:main [telegram] → paused_by_breaker");
    // §4: the provider's operator checklist is reported verbatim for mounted surfaces.
    expect(result).not.toContain("precondition:");

    const slackPort = portWith();
    slackPort.supervisor.statuses = [
      { id: "channel:slack:hq", surface: "slack", state: "mounted" },
    ];
    const slackStatus = await provisionStatus(slackPort.port)({});
    expect(slackStatus).toContain(
      "slack precondition: Socket Mode enabled with an app-level token granted connections:write",
    );
    // #1569: a mounted stage reports its instance surface; the bot's checklist is the platform's, the Owner's is the arm's.
    const instancePort = portWith();
    instancePort.supervisor.statuses = [
      { id: "channel:slack:hq", surface: "slack:bot", state: "mounted" },
      { id: "channel:slack:owner", surface: "slack:owner", state: "mounted" },
    ];
    const instanceStatus = await provisionStatus(instancePort.port)({});
    expect(instanceStatus).toContain("channel:slack:owner [slack:owner] → mounted");
    expect(instanceStatus).toContain(
      "slack:bot precondition: Socket Mode enabled with an app-level token granted connections:write",
    );
    expect(instanceStatus).toContain("slack:owner precondition: Owner session from the Slack QR login");
    expect(instanceStatus).not.toContain("slack:owner precondition: Socket Mode");

    const locked = portWith({ kek: { kind: "locked", reason: "no OPENOMNI_VAULT_KEY" } });
    expect(await provisionStatus(locked.port)({})).toContain(
      "vault_locked (no OPENOMNI_VAULT_KEY)",
    );
  });
});

describe("refusal branches", () => {
  test("malformed inputs refuse with the tool's typed refusal", async () => {
    const { port } = portWith();
    // Bare operations missing the envelope, and an envelope whose operation is not an object.
    const malformed: PlainObject[] = [
      { op: "contact_add", args: {} },
      { op: "contact_remove", args: {} },
      { op: "channel_add", args: {} },
      { op: "channel_enable", args: {} },
      { op: "secret_rotate", args: {} },
      { operation: "nope" },
    ];
    for (const input of malformed) {
      const result = await dispatchModelTool(
        "provision",
        { provisioning: port },
        RESIDENT,
        () => NOW,
      )(input);
      expect(result).toMatchObject({ isError: true, errorKind: "invalid_input" });
      expect(result.content).toContain("provision refused");
    }
  });

  test("foreign approval identifiers are invalid rather than reusable authority", async () => {
    const { port } = portWith();
    const tool = eraseTool(createProvisionTool(port, () => 1000));
    for (const approvalId of ["contact-approval", "another-person-approval"]) {
      const result = await runEffect(dispatcherFixture([tool], { executor }).execute(
        {
          id: approvalId,
          tool: "provision",
          input: {
            operation: { op: "contact_add", args: { manifest: MANAGER_MANIFEST, approvalId } },
          },
        },
        { sessionId: "test", turnId: "turn" },
      ));
      expect(result.errorKind).toBe("invalid_input");
    }
    expect(plane().stores.persons.get(MANAGER_MANIFEST.id)).toBeUndefined();
  });

  test("missing request authority refuses instead of applying a protected mutation", async () => {
    const { port } = portWith();
    const result = await runEffect(Effect.result(dispatcherFixture([eraseTool(createProvisionTool(port, () => 1000))], {
      executor,
    }).execute(
      {
        id: "no-authority",
        tool: "provision",
        input: { operation: { op: "contact_add", args: { manifest: MANAGER_MANIFEST } } },
      },
      { sessionId: "test", turnId: "turn" },
    )));
    expect(result._tag).toBe("Failure");
    expect(result._tag === "Failure" && result.failure).toMatchObject({ _tag: "ExecutionApprovalError", code: "approval_authority_unavailable" });
    expect(plane().stores.persons.get(MANAGER_MANIFEST.id)).toBeUndefined();
  });

  test("a durable-write failure in channel_add is a typed refusal", async () => {
    const { port } = portWith({
      instances: {
        get: plane().stores.instances.get,
        list: plane().stores.instances.list,
        put: () => {
          throw new Error("disk full");
        },
      },
    });
    expect(
      await channelDeclare(
        port,
        () => NOW,
      )({
        id: "channel:telegram:main",
        provider: "telegram",
        credential: { token: "t" },
      }),
    ).toBe("channel_add refused: disk full");
  });
});
