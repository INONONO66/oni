import { expect, test } from "bun:test";
import { ChildState } from "../src/index";

const frame: ChildState.Frame = {
  type: "child_state",
  requestId: "r-1",
  sessionId: "parent",
  child: "child-redacted",
  turn: "turn-redacted",
  phase: "result",
  source: "transcript",
  since: 9,
  facts: [{ phase: "observed" }, { toolUseId: "c-1", phase: "requested" }, { toolUseId: "c-1", phase: "result" }],
  diagnostics: [{ code: "corrupt", detail: "invalid_shape" }],
};

test("a child state frame round-trips through the wire unchanged", () => {
  const decoded = ChildState.Response.parse(JSON.parse(JSON.stringify(frame)));
  expect(decoded).toEqual(frame);
  expect(ChildState.Request.parse({ type: "child_state", requestId: "r-1", sessionId: "parent", child: "c", turn: "t" }))
    .toEqual({ type: "child_state", requestId: "r-1", sessionId: "parent", child: "c", turn: "t" });
  expect(ChildState.Response.parse({ type: "child_state_refused", requestId: "r-1", reason: "unknown", detail: "" }))
    .toEqual({ type: "child_state_refused", requestId: "r-1", reason: "unknown", detail: "" });
});

test("the frame carries references only: transcript bytes and unknown keys are refused", () => {
  expect(ChildState.Frame.safeParse({ ...frame, records: [{ kind: "turn", role: "user", text: "go" }] }).success).toBe(false);
  expect(ChildState.Frame.safeParse({ ...frame, facts: [{ phase: "observed", text: "go" }] }).success).toBe(false);
  expect(ChildState.Frame.safeParse({ ...frame, source: "journal" }).success).toBe(false);
  expect(ChildState.Request.safeParse({ type: "child_state", requestId: "r-1", sessionId: "parent", child: "c" }).success).toBe(false);
});
