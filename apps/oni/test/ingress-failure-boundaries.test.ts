import { expect, spyOn, test } from "bun:test";
import { ChannelProviders } from "@oni/channels";
import { fakeProviders } from "./helpers/channel-providers";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { declareChannel } from "./helpers/declared-channel";
import { planeOf } from "./helpers/ledger";

const suite = residentSuite();

// W5.2: the async wake seam (admitted message, deferred wake failure) is gone —
// entity sessions drain inside the delivering RPC, so there is no post-commit
// wake to fail. The mounted-driver refusal boundary below remains the app's
// ingress failure contract.
test("a mounted driver receives a rejected promise when message policy refuses admission", async () => {
  const providers = fakeProviders();
  const telegram = spyOn(ChannelProviders.telegram, "create").mockImplementation(providers.providers.telegram.create);
  try {
    const config = suite.config("driver-refusal-");
    const catalogPath = config.catalogPath;
    if (catalogPath === undefined) throw new Error("suite config is missing catalogPath");
    const kek = declareChannel(catalogPath, "telegram", { token: "fixture" });
    const app = await suite.boot({
      config: { ...config, kek },
      llm: { resolveModel: fakeProviderModel },
    });
    const plane = await planeOf(app.runtime);
    plane.catalog.policies.append({
      name: "fixture-message-denial", kind: "message", phase: "pre", priority: 10000,
      generation: plane.openKernel("gateway-ingress").currentPolicyGeneration(),
      match: { encodingVersion: 1, value: {} },
      verdict: { encodingVersion: 1, value: { type: "deny", reason: "fixture_refusal" } },
    });
    const surface = providers.surfaces[0];
    if (surface?.handler === null || surface?.handler === undefined) throw new Error("missing driver handler");
    await expect(surface.handler({
      sender: { kind: "external", surface: "telegram", externalId: "sender" },
      facts: {
        eventId: "frame", surface: "telegram", channelId: "conversation", dm: true,
        addressees: [], render: "hello", payload: {},
      },
    })).rejects.toThrow("message admission refused:");
    expect(plane.listSessions().map((row) => row.id)).toEqual(["gateway-ingress"]);
    expect((await fetch(`http://127.0.0.1:${app.port}/health`)).status).toBe(200);
  } finally {
    telegram.mockRestore();
  }
});
