import { expect, test } from "bun:test";
import { Effect } from "effect";
import { WebSocketHandler, type WsConnection } from "@oni/channels";
import { ChildState, type Machine } from "@oni/protocol";
import { composedHolder } from "./helpers/bundle-fixture";
import { Bus } from "./helpers/bus";
import { gatewayRuntime, webSocketCallbacks } from "../src/gateway";
import { childStateWire } from "../src/composition/child-state-wire";
import { type ChildRow, currentState, reconcile, stateReceipts } from "../src/bundles/child-activity/reconcile";
import { spec } from "./helpers/child-activity";
import { testIds } from "./helpers/test-entropy";

const request: ChildState.Request = {
  type: "child_state", requestId: "state-1", sessionId: spec.sessionId, child: spec.child, turn: spec.turn,
};

// Three admissions of one child turn: each page lands at a later byte offset
// with a later observation, so the last page's receipt wins the derived state.
function admittedRows(): ChildRow[] {
  const pages: readonly (readonly [readonly Machine.AgentTranscriptRecord[], number])[] = [
    [[{ kind: "turn", role: "user", text: "go" }], 7],
    [[{ kind: "tool_call", callId: "c-1", name: "read", input: "{}" }], 8],
    [[{ kind: "tool_result", callId: "c-1", output: "ok", failed: false }, { kind: "corrupt", reason: "invalid_shape", excerpt: "{" }], 9],
  ];
  let previous = spec.cursor;
  let rows: ChildRow[] = [];
  for (const [records, observedAt] of pages) {
    const cursor = { ...previous, byteOffset: previous.byteOffset + 32, recordHash: String(observedAt).repeat(64) };
    rows = [...rows, ...reconcile({
      machine: spec.machine, contact: spec.contact, child: spec.child, turn: spec.turn,
      records, cursor, previous, observedAt,
    }, rows)];
    previous = cursor;
  }
  return rows;
}

const expected: ChildState.Frame = {
  ...request,
  phase: "result",
  source: "transcript",
  since: 9,
  facts: [{ phase: "observed" }, { toolUseId: "c-1", phase: "requested" }, { toolUseId: "c-1", phase: "result" }],
  diagnostics: [{ code: "corrupt", detail: "invalid_shape" }],
};

test("the gateway answers child_state with the exact derived state of an admitted child turn", async () => {
  const rows = admittedRows();
  const runtime = gatewayRuntime({ composed: composedHolder(), observations: Bus });
  try {
    const handler = new WebSocketHandler(() => Effect.void, Bus.publish, { now: () => 0, id: testIds("child-state") });
    const frames: ChildState.Response[] = [];
    const ws: WsConnection = {
      data: { surfaceKey: "ws::dm:test", authenticated: true, externalId: "console" },
      send: (frame) => {
        frames.push(ChildState.Response.parse(JSON.parse(frame)));
      },
    };
    const gateway = webSocketCallbacks(runtime, handler, Bus, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, (sessionId) => sessionId === spec.sessionId ? rows : undefined);
    await gateway.callbacks.message(ws, JSON.stringify(request));
    await gateway.callbacks.message(ws, JSON.stringify({ ...request, requestId: "state-2", sessionId: "missing" }));
    expect(frames).toEqual([
      expected,
      { type: "child_state_refused", requestId: "state-2", reason: "session_not_found", detail: "missing" },
    ]);
    expect(ws.data.frameSeen).toBe(true);
    const state = currentState(stateReceipts(rows, spec.child, spec.turn));
    expect(state?.fact).toEqual({ child: spec.child, turn: spec.turn, toolUseId: "c-1", phase: expected.phase });
    expect(state?.receipt.observedAt).toBe(expected.since);
    gateway.callbacks.close(ws);
  } finally {
    await runtime.dispose();
  }
});

test("child state wire refuses malformed, uncomposed and unknown requests while leaving other frames alone", () => {
  const rows = admittedRows();
  const admitted = (sessionId: string) => sessionId === spec.sessionId ? rows : undefined;
  expect(childStateWire("invalid json", admitted)).toBeUndefined();
  expect(childStateWire('{"type":"machine_list","requestId":"other"}', admitted)).toBeUndefined();
  expect(childStateWire(JSON.stringify({ ...request, extra: true }), admitted))
    .toEqual({ type: "child_state_refused", requestId: "state-1", reason: "invalid_request", detail: "Invalid child state request" });
  expect(childStateWire('{"type":"child_state"}', admitted))
    .toMatchObject({ type: "child_state_refused", requestId: "invalid", reason: "invalid_request" });
  expect(childStateWire(JSON.stringify(request), undefined))
    .toEqual({ type: "child_state_refused", requestId: "state-1", reason: "unavailable", detail: "Child activity is not composed" });
  expect(childStateWire(JSON.stringify({ ...request, turn: "other-turn" }), admitted))
    .toEqual({ type: "child_state_refused", requestId: "state-1", reason: "unknown", detail: "No admitted receipt for this child turn" });
  expect(childStateWire(Buffer.from(JSON.stringify(request)), admitted)).toEqual(expected);
});
