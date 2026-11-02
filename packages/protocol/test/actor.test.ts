import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { Actor } from "../src/actor/index.js";

describe("Actor protocol contracts", () => {
  test("parses canonical identity and endpoint records", () => {
    // Given
    const identityInput: z.input<typeof Actor.Identity> = {
      id: "act_owner",
      kind: "human",
      trustTier: "owner",
      displayName: "Owner",
    };
    const endpointInput = {
      id: "ep_discord_user_1",
      actorId: "act_owner",
      channel: "discord",
      externalId: "user-1",
    };

    // When
    const identity = Actor.Identity.parse(identityInput);
    const endpoint = Actor.Endpoint.parse(endpointInput);

    // Then
    expect(identity).toEqual(identityInput);
    expect(endpoint).toEqual(endpointInput);
  });

  test("rejects invalid actor vocabulary values", () => {
    // Given
    const invalidIdentity = {
      id: "act_bad",
      kind: "bot",
      trustTier: "root",
    };

    // When
    const result = Actor.Identity.safeParse(invalidIdentity);

    // Then
    expect(result.success).toBe(false);
  });

  test("Kind is THE one actor-kind vocabulary, including unknown (#498 A2)", () => {
    for (const kind of [
      "human",
      "ai_agent",
      "service",
      "resident",
      "internal_worker",
      "system",
      "unknown",
    ] as const) {
      expect(Actor.Kind.parse(kind)).toBe(kind);
    }
    // The retired command-local values are not identity vocabulary.
    expect(Actor.Kind.safeParse("worker").success).toBe(false);
    expect(Actor.Kind.safeParse("user").success).toBe(false);
  });

  test("an old identity blob carrying the retired relationship key still parses (#498 A1)", () => {
    // Given — bytes persisted before the relationship removal
    const legacyBlob = {
      id: "act_legacy",
      kind: "human",
      trustTier: "owner",
      relationship: "owner",
    };

    // When
    const identity = Actor.Identity.parse(legacyBlob);

    // Then — the non-strict schema strips the retired key; the rest survives
    expect(identity).toEqual({ id: "act_legacy", kind: "human", trustTier: "owner" });
    expect("relationship" in identity).toBe(false);
  });
});

describe("Actor.Profile (#498 A3)", () => {
  test("parses a full profile: authority half + executable half", () => {
    const profile = Actor.Profile.parse({
      trustTier: "assigned_worker",
      systemPrompt: "You are a coder.",
      tools: [
        {
          name: "read",
          description: "Read a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      budget: { maxTurns: 10, warningThreshold: 0.75, reassuranceThreshold: 0.5 },
    });

    expect(profile.trustTier).toBe("assigned_worker");
    expect(profile.model?.provider).toBe("anthropic");
    expect(profile.budget.maxTurns).toBe(10);
  });

  test("parses a minimal profile — executable fields are optional", () => {
    const profile = Actor.Profile.parse({ trustTier: "observer", budget: {} });
    expect(profile.trustTier).toBe("observer");
    expect(profile.tools).toBeUndefined();
  });

  test("Budget rejects thresholds outside (0, 1) and threshold endpoints", () => {
    expect(Actor.Profile.Budget.safeParse({ warningThreshold: 1.1 }).success).toBe(false);
    expect(Actor.Profile.Budget.safeParse({ warningThreshold: 0 }).success).toBe(false);
    expect(Actor.Profile.Budget.safeParse({ reassuranceThreshold: 1 }).success).toBe(false);
  });

  test("Budget rejects thresholds that invert the staged status order", () => {
    expect(
      Actor.Profile.Budget.safeParse({ warningThreshold: 0.4, reassuranceThreshold: 0.8 }).success,
    ).toBe(false);
    expect(
      Actor.Profile.Budget.safeParse({ warningThreshold: 0.6, reassuranceThreshold: 0.6 }).success,
    ).toBe(false);
    expect(Actor.Profile.Budget.safeParse({ warningThreshold: 0.5 }).success).toBe(false);
    expect(Actor.Profile.Budget.safeParse({ reassuranceThreshold: 0.9 }).success).toBe(false);
  });

  test("Budget rejects non-positive limits other than the -1 unlimited sentinel", () => {
    expect(Actor.Profile.Budget.safeParse({ maxTurns: 0 }).success).toBe(false);
    expect(Actor.Profile.Budget.safeParse({ maxTurns: -2 }).success).toBe(false);
    expect(Actor.Profile.Budget.parse({ maxTurns: -1 }).maxTurns).toBe(-1);
    expect(Actor.Profile.Budget.parse({ maxTurns: 10 }).maxTurns).toBe(10);
  });

  test("exposes shared budget threshold defaults", () => {
    expect(Actor.Profile.DEFAULT_REASSURANCE_THRESHOLD).toBe(0.6);
    expect(Actor.Profile.DEFAULT_WARNING_THRESHOLD).toBe(0.8);
  });

  test("exposes budget threshold input as a Zod-first contract", () => {
    expect(Actor.Profile.BudgetThresholdInput.parse({ warningThreshold: 0.9 })).toEqual({
      warningThreshold: 0.9,
    });
  });
});
