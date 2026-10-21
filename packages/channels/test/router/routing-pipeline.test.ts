import { describe, expect, it } from "bun:test";
import { Ingress } from "@oni/protocol";
import { resolveRoute, type RouteState } from "../../src/router/resolve-route.js";

type RouteInbound = Parameters<typeof resolveRoute>[0];

function parseDecision(inbound: RouteInbound, state: RouteState) {
  const decision = resolveRoute(inbound, state);
  return Ingress.Events.RoutingDecision.schema.parse(decision);
}

describe("resolveRoute", () => {
  it("returns one surface route for a registered Owner DM", () => {
    // Given
    const inbound = Object.freeze({
      traceId: "trace-owner-dm",
      time: 1_000,
      id: "inbound-owner-dm",
      surface: "discord",
      mode: "direct",
      target: "resident",
    }) satisfies RouteInbound;
    const state = Object.freeze({
      request: Object.freeze({ kind: "none" }),
      channel: Object.freeze({
        id: "grant-owner-dm",
        kind: "trusted_channel",
        inboundTreatment: "full_access",
        defaultTier: "owner",
      }),
      actor: Object.freeze({
        id: "actor-owner",
        trustTier: "owner",
        registered: true,
      }),
      surfaceSessionId: "session-owner-dm",
    }) satisfies RouteState;

    // When
    const decision = parseDecision(inbound, state);

    // Then
    expect(decision).toMatchObject({
      traceId: "trace-owner-dm",
      time: 1_000,
      inboundId: "inbound-owner-dm",
      surface: "discord",
      mode: "direct",
      stage: "surface_default",
      outcome: "route",
      target: "resident",
      sessionId: "session-owner-dm",
      actorId: "actor-owner",
      trustTier: "owner",
      inboundTreatment: "full_access",
    });
    expect(decision.factsUsed).toContain("channel:grant-owner-dm");
    expect(decision.factsUsed).toContain("actor:actor-owner");
    expect(decision.factsUsed).toContain("surface.default:session-owner-dm");
  });

  it("routes trusted first contact to a new surface session candidate", () => {
    // Given
    const inbound = Object.freeze({
      traceId: "trace-first-contact",
      time: 1_500,
      id: "inbound-first-contact",
      surface: "discord",
      mode: "direct",
      target: "resident",
    }) satisfies RouteInbound;
    const state = Object.freeze({
      request: Object.freeze({ kind: "none" }),
      channel: Object.freeze({
        id: "grant-first-contact",
        kind: "trusted_channel",
        inboundTreatment: "full_access",
        defaultTier: "owner",
      }),
    }) satisfies RouteState;

    // When
    const decision = parseDecision(inbound, state);

    // Then
    expect(decision).toMatchObject({
      traceId: "trace-first-contact",
      time: 1_500,
      inboundId: "inbound-first-contact",
      surface: "discord",
      mode: "direct",
      stage: "surface_default",
      outcome: "route",
      target: "resident",
      trustTier: "owner",
      inboundTreatment: "full_access",
    });
    expect(decision.sessionId).toBeUndefined();
    expect(decision.factsUsed).toContain("surface.default:new");
    expect(decision.factsUsed.some((fact) => fact.includes("undefined"))).toBe(false);
  });
});
