import { describe, expect, it } from "bun:test";
import { Ingress } from "@oni/protocol";
import { resolveRoute, type RouteState } from "../../src/router/resolve-route.js";

type RouteInbound = Parameters<typeof resolveRoute>[0];
import { requireRoutedDecision } from "../../src/router/routing-execution.js";
import { IngressRoutingError } from "../../src/errors";
import { z } from "zod";
import { rejected } from "../helpers/rejection";

async function routingError(
  decision: Ingress.RoutingDecisionPayload,
): Promise<IngressRoutingError> {
  const error = await rejected(
    Promise.resolve().then(() => requireRoutedDecision(decision)),
    z.instanceof(IngressRoutingError),
  );
  expect(error.decision).toEqual(decision);
  return error;
}

const inbound = Object.freeze({
  traceId: "trace-precedence",
  time: 4_000,
  id: "inbound-precedence",
  surface: "discord",
  mode: "direct",
  target: "resident",
  requestedAction: "report_result",
}) satisfies RouteInbound;

const matchedRequest = Object.freeze({
  kind: "match",
  backing: "request",
  key: "request:request-match",
  recordId: "request-match",
  sessionId: "session-request",
  allowed: Object.freeze(["report_result"]),
});

const trustedChannel = Object.freeze({
  id: "grant-trusted",
  kind: "trusted_channel",
  inboundTreatment: "full_access",
  defaultTier: "observer",
});

const blockedChannel = Object.freeze({
  id: "grant-blocked",
  kind: "blocked_channel",
  inboundTreatment: "drop",
});

const registeredActor = Object.freeze({
  id: "actor-registered",
  trustTier: "collaborator",
  registered: true,
});

interface PrecedenceCase {
  readonly name: string;
  readonly state: RouteState;
  readonly stage: Ingress.RoutingDecisionPayload["stage"];
  readonly outcome: Ingress.RoutingDecisionPayload["outcome"];
  readonly sessionId?: string;
}

const precedenceCases = Object.freeze([
  {
    name: "blacklist before request correlation",
    state: Object.freeze({
      blacklist: Object.freeze({ id: "blacklist-actor", kind: "actor", reason: "revoked" }),
      request: matchedRequest,
      channel: trustedChannel,
      actor: registeredActor,
      surfaceSessionId: "session-surface",
    }),
    stage: "blacklist",
    outcome: "drop",
  },
  {
    name: "request correlation before channel ceiling",
    state: Object.freeze({
      request: matchedRequest,
      channel: blockedChannel,
      actor: registeredActor,
      surfaceSessionId: "session-surface",
    }),
    stage: "request_correlation",
    outcome: "route",
    // The request OWNER's session wins over the conflicting surface-key mapping.
    sessionId: "session-request",
  },
  {
    name: "channel ceiling before actor identity",
    state: Object.freeze({
      request: Object.freeze({ kind: "none" }),
      channel: blockedChannel,
      actor: registeredActor,
      surfaceSessionId: "session-surface",
    }),
    stage: "channel_ceiling",
    outcome: "block",
  },
  {
    name: "actor identity before surface default",
    state: Object.freeze({
      request: Object.freeze({ kind: "none" }),
      channel: Object.freeze({
        id: "grant-no-default",
        kind: "trusted_channel",
        inboundTreatment: "full_access",
      }),
      surfaceSessionId: "session-surface",
    }),
    stage: "actor_identity",
    outcome: "block",
  },
  {
    name: "surface default after all earlier stages pass",
    state: Object.freeze({
      request: Object.freeze({ kind: "none" }),
      channel: trustedChannel,
      actor: registeredActor,
      surfaceSessionId: "session-surface",
    }),
    stage: "surface_default",
    outcome: "route",
    sessionId: "session-surface",
  },
]) satisfies readonly PrecedenceCase[];

describe("resolveRoute precedence", () => {
  it("the rejection fixture refuses a fulfilled operation", async () => {
    await expect(rejected(Promise.resolve("accepted"), z.instanceof(Error))).rejects.toThrow();
  });

  for (const testCase of precedenceCases) {
    it(testCase.name, () => {
      // Given
      const state = testCase.state;

      // When
      const decision = Ingress.Events.RoutingDecision.schema.parse(resolveRoute(inbound, state));

      // Then
      expect(decision.stage).toBe(testCase.stage);
      expect(decision.outcome).toBe(testCase.outcome);
      if (testCase.sessionId !== undefined) {
        expect(decision.sessionId).toBe(testCase.sessionId);
      }
    });
  }

  it("preserves fail-closed ambiguity from the winning request-correlation level", () => {
    // Given
    const state = Object.freeze({
      request: Object.freeze({
        kind: "ambiguous",
        candidateInteractionIds: Object.freeze(["request:request-a", "request:request-b"]),
      }),
      channel: trustedChannel,
      actor: registeredActor,
      surfaceSessionId: "session-surface",
    }) satisfies RouteState;

    // When
    const decision = Ingress.Events.RoutingDecision.schema.parse(resolveRoute(inbound, state));

    // Then
    expect(decision).toMatchObject({
      stage: "request_correlation",
      outcome: "ambiguous",
      candidateInteractionIds: ["request:request-a", "request:request-b"],
    });
    expect(decision.sessionId).toBeUndefined();
  });

  it("does not produce an execution target for blocked or missing channel grants", () => {
    // Given
    const states = Object.freeze([
      Object.freeze({
        request: Object.freeze({ kind: "none" }),
        channel: blockedChannel,
        actor: registeredActor,
        surfaceSessionId: "session-surface",
      }),
      Object.freeze({
        request: Object.freeze({ kind: "none" }),
        actor: registeredActor,
        surfaceSessionId: "session-surface",
      }),
    ]) satisfies readonly RouteState[];

    // When
    const decisions = states.map((state) => resolveRoute(inbound, state));

    // Then
    expect(decisions.map((decision) => decision.outcome)).toEqual(["block", "block"]);
    expect(decisions.every((decision) => decision.target === undefined)).toBe(true);
    expect(decisions.every((decision) => decision.sessionId === undefined)).toBe(true);
  });

  it("refuses blacklist, block and ambiguity before the delivery body", async () => {
    const decisions = [
      resolveRoute(inbound, {
        blacklist: { id: "blacklist-actor", kind: "actor", reason: "revoked" },
        request: matchedRequest,
        channel: trustedChannel,
        actor: registeredActor,
      }),
      resolveRoute(inbound, {
        request: { kind: "none" },
        actor: registeredActor,
      }),
      resolveRoute(inbound, {
        request: {
          kind: "ambiguous",
          candidateInteractionIds: ["request:request-a", "request:request-b"],
        },
        channel: trustedChannel,
        actor: registeredActor,
      }),
    ].map((decision) => Ingress.Events.RoutingDecision.schema.parse(decision));

    const accepted = decisions[0];
    expect(accepted).toBeDefined();
    if (accepted === undefined || accepted.stage !== "blacklist" || accepted.outcome !== "drop") {
      throw new TypeError("missing accepted decision fixture");
    }
    const errors = await Promise.all(decisions.map(routingError));
    const codes = errors.map((error) => error.code);
    expect(codes).toEqual(["route_blocked", "route_blocked", "route_ambiguous"]);
  });

  it.each([
    { label: "a blocked channel", channel: blockedChannel },
    {
      label: "an actor-identity block",
      channel: { id: "grant-no-default", kind: "trusted_channel", inboundTreatment: "full_access" },
    },
  ] as const)("classifies $label through the typed routing error", async ({ channel }) => {
    const decision = Ingress.Events.RoutingDecision.schema.parse(
      resolveRoute(inbound, { request: { kind: "none" }, channel }),
    );
    expect((await routingError(decision)).code).toBe("route_blocked");
  });

  it("preserves evidence_only treatment while routing a broadcast channel", () => {
    // Given
    const state = Object.freeze({
      request: Object.freeze({ kind: "none" }),
      channel: Object.freeze({
        id: "grant-broadcast",
        kind: "broadcast_channel",
        inboundTreatment: "evidence_only",
        defaultTier: "observer",
      }),
      surfaceSessionId: "session-surface",
    }) satisfies RouteState;

    // When
    const decision = Ingress.Events.RoutingDecision.schema.parse(resolveRoute(inbound, state));

    // Then
    expect(decision).toMatchObject({
      stage: "surface_default",
      outcome: "route",
      target: "resident",
      sessionId: "session-surface",
      inboundTreatment: "evidence_only",
    });
    expect(decision.factsUsed).toContain("channel:grant-broadcast");
    expect(decision.factsUsed).toContain("channel.treatment:evidence_only");
  });

  it("blocks an unknown actor when the channel supplies no default tier", () => {
    // Given
    const state = Object.freeze({
      request: Object.freeze({ kind: "none" }),
      channel: Object.freeze({
        id: "grant-no-default",
        kind: "trusted_channel",
        inboundTreatment: "full_access",
      }),
      surfaceSessionId: "session-surface",
    }) satisfies RouteState;

    // When
    const decision = Ingress.Events.RoutingDecision.schema.parse(resolveRoute(inbound, state));

    // Then
    expect(decision.stage).toBe("actor_identity");
    expect(decision.outcome).toBe("block");
    expect(decision.actorId).toBeUndefined();
    expect(decision.trustTier).toBeUndefined();
    expect(decision.sessionId).toBeUndefined();
  });
});
