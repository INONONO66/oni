/**
 * #1348: the gateway request-port fixture shared by the `session-request-port`
 * and `session-requests-typed` suites. Everything here reads the ACTIVE
 * isolation (`isolatedLedger()`), so each `isolated(...)` case seeds and
 * opens its own port over its own SQLite file.
 */
import { Effect } from "effect";
import { canonicalDigest, type PlainValue } from "@openomni/protocol";
import { createSessionRequests } from "../../src/core/request";
import { isolatedLedger } from "./isolated";
import { allowConfigure, isolatedRuntime, type SessionFixture, withSessionServices } from "./session-services";

/** Materialize the `source` resident session at revision 0 under action `configure`. */
export const materializeSource = Effect.suspend(() =>
  isolatedLedger().kernel.materialize({
    id: "source",
    parentId: null,
    role: "resident",
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: 0,
    actionId: "configure",
    at: 1,
  }),
);

/** Append one pending `message` invocation row under `configure` with the given intent. */
export function appendSourceInvocation(id: string, intent: PlainValue): void {
  const ledger = isolatedLedger();
  ledger.session.actions.append(
    {
      id,
      sessionId: "source",
      parentId: "configure",
      kind: "message",
      intent: { encodingVersion: 1, value: intent },
      effect: { encodingVersion: 1, value: { phase: "pending" } },
      irreversible: true,
      ts: 1,
    },
    ledger.kernel.row("source").revision,
  );
}

/** The canonical pending intent for message `id`. */
export function messageIntent(id: string): PlainValue {
  return { phase: "intent", value: { messageId: id }, effectHash: canonicalDigest({}) };
}

/** One open-request input for `requestId` on `source`, answered by `peer` before t=200. */
export const openingRequest = (requestId: string) => ({
  requestId,
  sessionId: "source",
  expectedResponders: ["peer"],
  correlation: {},
  allowedActions: ["report_result" as const],
  resolution: "first" as const,
  threshold: 1,
  deadline: 200,
  at: 100,
});

/** A request port over a fresh fixture runtime with the canonical clock and silent sink. */
export function gatewayPort(overrides: Partial<SessionFixture> = {}) {
  return Effect.gen(function* () {
    const fixture: SessionFixture = {
      clock: () => 100,
      observations: { publish: () => undefined },
      authorizeConfigure: allowConfigure,
      ...isolatedRuntime(),
      ...overrides,
    };
    return yield* withSessionServices(createSessionRequests(fixture), fixture);
  });
}
