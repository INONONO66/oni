import { expect, test } from "bun:test";
import { Effect } from "effect";
import { PlainValueSchema, type BusEvent, type PlainObject, type PlainValue } from "@openomni/protocol";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { seedPolicy } from "./helpers/seed-policy";
import {
  allowConfigure,
  isolatedRuntime,
  withSessionServices,
  type SessionFixture,
} from "./helpers/session-services";
import { closeSessions, type SessionRunner } from "../src/core/run";
import { session } from "../src/testing/registry";
import { InboundAuthorityViolated, inboundAuthority } from "../src/core/run";

// Unit seam: the perimeter verdicts the turn recognizes.
test("unknown provenance never acts: evidence authority plus a typed violation fact", () => {
  const unknown = inboundAuthority({ kind: "spoofed", payload: "whatever" });
  expect(unknown.authority).toBe("evidence_only");
  expect(unknown.violation?._tag).toBe("InboundAuthorityViolation");
  expect(unknown.violation?.reason).toBe("unknown_origin");
  expect(unknown.violation?.message).toBe("inbound authority violation: unknown_origin");

  const undeclared = inboundAuthority({ kind: "external", messageId: "m", surface: "ws", externalId: "e", actorId: "" });
  expect(undeclared.authority).toBe("evidence_only");
  expect(undeclared.violation?.reason).toBe("undeclared_treatment");
  expect(undeclared.violation?.message).toBe("inbound authority violation: undeclared_treatment");
});

test("known trusted origins keep acting with no violation", () => {
  const origins: readonly PlainValue[] = [
    { kind: "session", id: "parent" },
    { kind: "message", messageId: "m1", senderSessionId: "parent", sourceActionId: "a1" },
    { kind: "external", messageId: "m", surface: "ws", externalId: "e", actorId: "", inboundTreatment: "full_access" },
  ];
  for (const origin of origins) {
    expect(inboundAuthority(origin)).toEqual({ authority: "act" });
  }
});

/** One isolated session runtime at fixed `clock` whose observations land in `published` as plain objects. */
function observedRuntime(clock: number, idPrefix: string) {
  const published: { name: string; data: PlainObject }[] = [];
  const runtime: SessionFixture = {
    authorizeConfigure: allowConfigure,
    observations: {
      publish: <T>(event: BusEvent.Descriptor<T>, data: T) => {
        const value = PlainValueSchema.parse(data);
        published.push({
          name: event.name,
          data: value !== null && typeof value === "object" && !Array.isArray(value) ? value : {},
        });
      },
    },
    clock: () => clock,
    entropy: (() => { let next = 0; return () => `${idPrefix}-${++next}`; })(),
    ...isolatedRuntime(),
  };
  return { runtime, published };
}

// Integration seam: a real turn over mail of unknown provenance runs the
// runner with evidence authority and records the violation observation.
test("a turn over unknown-provenance mail runs as evidence and records the violation fact", () => {
  const authorities: (string | undefined)[] = [];
  const runner: SessionRunner = (input) =>
    Effect.sync(() => {
      authorities.push(input.authority);
      return { kind: "result", text: "done" };
    });
  const { runtime, published } = observedRuntime(1_000, "authority-id");
  return isolated(Effect.scoped(Effect.gen(function* () {
    seedPolicy();
    yield* Effect.addFinalizer(() => closeSessions(runtime).pipe(Effect.orDie));
    const handle = yield* withSessionServices(
      session({ id: "authority-session", role: "resident", runner }, runtime),
      runtime,
    );

    // Trusted provenance: acts, no violation observation.
    yield* handle.prompt("hello", {
      encodingVersion: 1,
      value: { kind: "session", id: "authority-session" },
    });
    expect(authorities).toEqual(["act"]);
    expect(published.filter((event) => event.name === InboundAuthorityViolated.name)).toEqual([]);

    // Unknown provenance: evidence authority plus the recorded violation fact.
    yield* handle.prompt("who sent this?", {
      encodingVersion: 1,
      value: { kind: "spoofed", payload: "mystery" },
    });
    expect(authorities).toEqual(["act", "evidence_only"]);
    const violations = published.filter((event) => event.name === InboundAuthorityViolated.name);
    expect(violations).toHaveLength(1);
    const fact = violations[0]?.data ?? {};
    expect(fact.reason).toBe("unknown_origin");
    expect(fact.sessionId).toBe("authority-session");
    expect(typeof fact.turnId).toBe("string");
    expect(typeof fact.messageId).toBe("string");
    expect(fact.time).toBe(1_000);
  })));
});

// Integration seam: a prompt whose action row cannot be found fails
// the turn typed — the runner never runs, no authority (not even evidence).
test("a prompt with no recorded origin fails the turn typed and never runs the runner", () => {
  let runnerCalls = 0;
  const runner: SessionRunner = () =>
    Effect.sync(() => {
      runnerCalls += 1;
      return { kind: "interrupted" };
    });
  const { runtime, published } = observedRuntime(2_000, "origin-less-id");
  return isolated(Effect.scoped(Effect.gen(function* () {
    seedPolicy();
    yield* Effect.addFinalizer(() => closeSessions(runtime).pipe(Effect.orDie));
    const handle = yield* withSessionServices(
      session({ id: "origin-less-session", role: "resident", runner }, runtime),
      runtime,
    );
    // Turn 1 interrupts, leaving the session resumable.
    yield* handle.prompt("hello", {
      encodingVersion: 1,
      value: { kind: "session", id: "origin-less-session" },
    });
    expect(runnerCalls).toBe(1);

    // A delivered prompt whose delivery id matches NO action row: hydration
    // surfaces the user message but its origin cannot be recovered.
    const ledger = isolatedLedger();
    ledger.session.actions.append(
      {
        id: "ghost-delivery",
        sessionId: "origin-less-session",
        parentId: null,
        kind: "prompt",
        intent: { encodingVersion: 1, value: {} },
        effect: {
          encodingVersion: 1,
          value: {
            phase: "delivery",
            turnId: "ghost-turn",
            deliveryId: "ghost-message",
            kind: "prompt",
            content: "who am I from?",
            origin: { encodingVersion: 1, value: {} },
            boundary: "before_llm",
          },
        },
        ts: 2_000,
        irreversible: true,
      },
      ledger.kernel.row("origin-less-session").revision,
    );

    // The resumed turn hydrates the ghost prompt as its latest user message,
    // fails typed, and never reaches the runner again.
    yield* handle.resume();
    expect(runnerCalls).toBe(1);
    const violations = published.filter((event) => event.name === InboundAuthorityViolated.name);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.data.reason).toBe("missing_origin");
    const terminal = ledger.kernel.latestTurnTerminal("origin-less-session");
    expect(terminal?.effect.kind).toBe("error");
  })));
});
