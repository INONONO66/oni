import { testToolPorts } from "./helpers/tool-ports";
import { Effect } from "effect";
import { runEffect } from "./helpers/effect";
import { providerFailure } from "./helpers/provider-failure";
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Core } from "@openomni/agent";
import { Auth } from "@openomni/llm";
const AgentFailure = Core.AgentFailure;
import type { Model } from "@openomni/protocol";
import { createResidentGateway } from "../src/gateway";
import { runSyncEffect } from "./helpers/effect";
import { decodeChannelFailure as decodeDeliveryFailure } from "@openomni/channels";
import { localDelivery } from "./helpers/ledger";
import { prepareMessage } from "../src/composition/message-session";
import { residentRunner as createResident } from "./helpers/resident-runner";
import { providerError, transientProvider, FIXTURE_AUTH_FILE } from "./helpers/sdk-provider";
import { testIds } from "./helpers/test-entropy";
import { residentGatewayPorts } from "./helpers/gateway-ports";

afterEach(() => {
  mock.restore();
});

const PRIMARY: Model.Ref = { provider: "fake", id: "resident-test" };
const FALLBACK: Model.Ref = { provider: "other", id: "fallback-model" };

// Delivery, not fixture CRUD, owns real handle materialization.
const openSession = (_prefix: string): string => crypto.randomUUID();

describe("Resident model fallback wiring", () => {
  it("resolves the configured fallback on the retry after a transient failure", async () => {
    const sessionId = openSession("openomni-resident-fallback-");
    const resolved: Model.Ref[] = [];
    const auths: Auth.Info[] = [];
    const credentials = spyOn(Auth, "get").mockReturnValue(Effect.succeed({ type: "api", key: "fallback-key" }));
    const resident = createResident({
      model: PRIMARY,
      modelFallbacks: [FALLBACK],
      apiKey: "test-key",
      tools: { ...testToolPorts,},
      llm: transientProvider(resolved, auths),
    });

    const result = await resident.prompt(sessionId, "please answer");

    expect(resolved).toEqual([PRIMARY, FALLBACK]);
    expect(auths).toEqual([
      { type: "api", key: "test-key" },
      { type: "api", key: "fallback-key" },
    ]);
    expect(credentials.mock.calls).toEqual([[FALLBACK.provider, FIXTURE_AUTH_FILE]]);
    expect(result.kind).not.toBe("dropped");
  });

  it("keeps every attempt on the primary when no fallback is configured", async () => {
    const sessionId = openSession("openomni-resident-no-fallback-");
    const resolved: Model.Ref[] = [];
    const resident = createResident({
      model: PRIMARY,
      apiKey: "test-key",
      tools: { ...testToolPorts,},
      llm: transientProvider(resolved),
    });

    await resident.prompt(sessionId, "please answer");

    expect(resolved).toEqual([PRIMARY, PRIMARY]);
  });
});

describe("Resident terminal LLM failure surfacing", () => {
  function alwaysFailing(error: Error) {
    return {
      resolveModel: (model: Model.Ref) => Effect.succeed({
        id: model.id,
        name: model.id,
        providerID: model.provider,
      }),
      run: () => Effect.succeed({ type: "error" as const, error: providerFailure(error.message, error) }),
    };
  }

  function residentThatAlwaysFails(error: Error) {
    return createResident({
      model: PRIMARY,
      apiKey: "test-key",
      tools: { ...testToolPorts,},
      llm: alwaysFailing(error),
    });
  }

  it("answers a rate-limited exhaustion with a classified, attempt-counted reply", async () => {
    const sessionId = openSession("openomni-resident-ratelimit-");
    const resident = residentThatAlwaysFails(
      providerError({ message: "rate limited", isRetryable: true, statusCode: 429 }),
    );

    const result = await resident.prompt(sessionId, "please answer");
    expect(result.text).toContain("rate limited upstream");
    expect(result.text).toContain("tried 3 times");
    expect(result.kind).toBe("error");
  });

  it("names a spent balance for a billing exhaustion, unhedged", async () => {
    const sessionId = openSession("openomni-resident-billing-");
    const resident = residentThatAlwaysFails(
      providerError({
        message: JSON.stringify({ error: { code: "insufficient_quota", message: "no credit" } }),
        isRetryable: true,
        statusCode: 429,
      }),
    );

    const result = await resident.prompt(sessionId, "please answer");
    expect(result.text).toContain("quota/billing exhausted");
    expect(result.text).toContain("check provider account");
    expect(result.text).not.toContain("may be exhausted");
  });

  it.each([
    { message: "402 Payment Required", name: "a bare payment-required response" },
    { message: "billing_error: card declined", name: "a declined-card billing error" },
  ])("hedges $name as MAY be exhausted", async ({ message }) => {
    const sessionId = openSession("openomni-resident-billing-hedged-");
    const resident = residentThatAlwaysFails(
      providerError({ message, isRetryable: false, statusCode: 402 }),
    );

    const result = await resident.prompt(sessionId, "please answer");
    expect(result.text).toContain("may be exhausted");
  });

  it("names a content-policy refusal", async () => {
    const sessionId = openSession("openomni-resident-content-policy-");
    const resident = residentThatAlwaysFails(
      providerError({
        message: JSON.stringify({
          error: { type: "invalid_request_error", code: "content_policy_violation" },
        }),
        isRetryable: false,
        statusCode: 400,
      }),
    );

    const result = await resident.prompt(sessionId, "please answer");
    expect(result.text).toContain("content policy");
  });

  it("does not expose raw unknown-fault details", async () => {
    const sessionId = openSession("openomni-resident-unknown-");
    const resident = residentThatAlwaysFails(
      new Error("request failed apiKey=sk-live-SECRET baseURL=https://internal.example/v1"),
    );

    const result = await resident.prompt(sessionId, "please answer");
    expect(result.text).toContain("could not reach the model");
    expect(result.text).not.toContain("sk-live-SECRET");
    expect(result.text).not.toContain("https://internal.example/v1");
  });

  it("returns one sanitized reply through gateway ingestion", async () => {
    openSession("openomni-resident-gateway-");
    const resident = residentThatAlwaysFails(
      providerError({ message: "rate limited", isRetryable: true, statusCode: 429 }),
    );
    const gateway = runSyncEffect(Effect.gen(function* () {
      return yield* createResidentGateway({
        now: Date.now,
        id: testIds("resilience-gateway"),
        delivery: { commit: (input) => localDelivery(resident.plane, "resilience-gateway", Date.now)(input).pipe(Effect.mapError(decodeDeliveryFailure("delivery.commit"))) },
        prepare: prepareMessage(resident.plane, resident.genesis),
        ...(yield* residentGatewayPorts(resident.plane, Date.now)),
      }, undefined);
    }).pipe(Effect.provide(resident.services)));

    const result = await runEffect(gateway.ingest(
      { kind: "external", surface: "ws", externalId: "owner" },
      {
        eventId: "inbound-resilience-gateway",
        surface: "ws",
        channelId: "owner",
        addressees: [],
        dm: true,
        payload: {},
        render: "please answer",
      },
    ));
    if (result.status !== "executed") throw new Error("gateway did not commit");
    const completed = await resident.drain(result.handle.target);
    expect(completed?.text).toContain("rate limited upstream");
    const target = result.handle.target;
    expect(resident.plane.openKernel(target).getSnapshot(target).turns.at(-1)?.terminal?.kind).toBe(
      "error",
    );
  });

  it("does not convert a configuration failure into a model reply", async () => {
    const sessionId = openSession("openomni-resident-config-failure-");
    const resident = createResident({
      model: PRIMARY,
      apiKey: "test-key",
      tools: { ...testToolPorts,},
      llm: {
        resolveModel: () => Effect.fail(new AgentFailure({ operation: "resolveModel", cause: "catalog invariant failed" })),
      },
    });

    const result = await resident.prompt(sessionId, "please answer");
    // W5.2: the drain returns the durable terminal; the live result's typed
    // cause/reported fields are no longer observable from this surface.
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("configuration fault was not an error");
  });

  it("records the classified reply in session history so the turn is auditable", async () => {
    const sessionId = openSession("openomni-resident-failure-history-");
    const resident = residentThatAlwaysFails(
      providerError({ message: "rate limited", isRetryable: true, statusCode: 429 }),
    );

    await resident.prompt(sessionId, "please answer");

    const tail = resident.plane.openKernel(sessionId).getSnapshot(sessionId).turns.at(-1);
    expect(tail?.terminal?.kind).toBe("error");
    expect(tail?.messages.at(-1)?.text).toContain("rate limited upstream");
  });

  it("lets an abort keep propagating — a stopped run is not a model fault", async () => {
    const sessionId = openSession("openomni-resident-abort-");
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    const resident = residentThatAlwaysFails(aborted);

    const result = await resident.prompt(sessionId, "please answer");
    expect(result.kind).toBe("interrupted");
  });
});
