import { describe, expect, it, test } from "bun:test";
import { Effect } from "effect";
import { consentOrigin } from "../src/bundles/approval-policy/consent-origin";
import { GATEWAY_INGRESS_SESSION } from "../src/composition/ingress-executor";
import { approvalRequest } from "./helpers/approval-request";
import { computerFixture } from "./helpers/computer";
import { runEffect } from "./helpers/effect";
import { type Gateway, Ingress, type PlainValue, type SessionTransition } from "@oni/protocol";

const session = { locked: false, asleep: false };

function answerFor(request: SessionTransition.Request): SessionTransition.Answer {
  return {
    inputId: "answer-1", requestId: request.requestId, sessionId: request.sessionId,
    receivedAt: 100, principal: { kind: "owner", principalId: "owner", evidenceId: "owner-1" },
    bindingDigest: request.bindingDigest, inputHash: request.inputHash, effectHash: request.effectHash,
    generation: request.generation, toolsHash: request.toolsHash,
    domainRevisions: request.domainRevisions, decision: "approve",
    allowedAction: "report_result", content: "approve",
  };
}

describe("computer consent origin", () => {
  function setup(parsedInput: PlainValue = { operation: {
    op: "computer_request", args: { machineId: "desk", apps: "any", minutes: 5 },
  } }) {
    const fixture = computerFixture();
    const request = approvalRequest(parsedInput, {});
    const facts = fixture.plane.session(GATEWAY_INGRESS_SESSION).decisions;
    let forwarded = 0;
    const answer = consentOrigin(fixture.policy, {
      list: () => [request],
      open: () => Effect.die("not used"),
      receipt: () => Effect.die("not used"),
      answer: () => Effect.sync(() => { forwarded += 1; return "resolved" as const; }),
    }, () => 100_000, () => "trace-1", facts);
    fixture.setClock(100_000);
    return { ...fixture, request, answer, facts, forwarded: () => forwarded };
  }

  it("refuses an injected-only same-machine answer without forwarding it", async () => {
    const fixture = setup();
    try {
      fixture.setSession(session);
      fixture.policy.injected("desk");
      expect(await runEffect(fixture.answer(answerFor(fixture.request), {
        surfaceKey: "ws::dm:desk", machineId: "desk",
      }))).toBe("self_approval_suspected");
      expect(fixture.forwarded()).toBe(0);
      expect(fixture.facts.head("request_answer:answer-1")).toMatchObject({
        type: Ingress.ROUTE_DECIDED_FACT_TYPE,
        data: { reason: "self_approval_suspected", outcome: "block" },
      });
    } finally {
      fixture.close();
    }
  });

  it("admits a same-machine answer after a recent person input edge", async () => {
    const fixture = setup();
    try {
      fixture.setSession(session, { lastAt: 98_000, source: "pointer", events: 1 });
      expect(await runEffect(fixture.answer(answerFor(fixture.request), {
        surfaceKey: "ws::dm:desk", machineId: "desk",
      }))).toBe("resolved");
      expect(fixture.forwarded()).toBe(1);
      expect(fixture.facts.head("request_answer:answer-1")).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  it("refuses a recent injection even after a person input edge", async () => {
    const fixture = setup();
    try {
      fixture.setSession(session, { lastAt: 98_000, source: "keyboard", events: 1 });
      fixture.policy.injected("desk");
      expect(await runEffect(fixture.answer(answerFor(fixture.request), {
        surfaceKey: "ws::dm:desk", machineId: "desk",
      }))).toBe("self_approval_suspected");
      expect(fixture.forwarded()).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it("admits messaging consent without a machine surface fact", async () => {
    const fixture = setup();
    try {
      expect(await runEffect(fixture.answer(answerFor(fixture.request)))).toBe("resolved");
      expect(fixture.forwarded()).toBe(1);
      expect(fixture.facts.head("request_answer:answer-1")).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  it("forwards other approvals from the same surface untouched", async () => {
    const fixture = setup({ operation: {
      op: "computer_exclude", args: { machineId: "desk", app: "com.example.Editor" },
    } });
    try {
      expect(await runEffect(fixture.answer(answerFor(fixture.request), {
        surfaceKey: "ws::dm:desk", machineId: "desk",
      }))).toBe("resolved");
      expect(fixture.forwarded()).toBe(1);
    } finally {
      fixture.close();
    }
  });
});

describe("computer lease revisions", () => {
  it("publishes the active, paused and ended revisions with their state", () => {
    const frames: Gateway.Lease[] = [];
    const fixture = computerFixture((frame) => frames.push(frame));
    try {
      fixture.grant();
      fixture.policy.store.pause("resident", "desk", "human_input");
      fixture.policy.store.end("resident", "desk", "owner_ended");
      expect(frames).toMatchObject([
        { type: "lease", sessionId: "resident", machineId: "desk", state: "active" },
        { type: "lease", sessionId: "resident", machineId: "desk", state: "paused", pauseReason: "human_input" },
        { type: "lease", sessionId: "resident", machineId: "desk", state: "ended" },
      ]);
    } finally {
      fixture.close();
    }
  });
});

test("captured machine input marks the injected window before its response", async () => {
  const fixture = computerFixture();
  try {
    fixture.setClock(10_000);
    fixture.grant();
    expect(await fixture.call()).toEqual({ status: "ok" });
    fixture.setSession(session, { lastAt: 9_000, source: "pointer", events: 1 });
    expect(fixture.policy.selfApprovalSuspected("desk")).toBe(true);
    fixture.setClock(20_001);
    expect(fixture.policy.selfApprovalSuspected("desk")).toBe(true);
    fixture.setSession(session, { lastAt: 19_000, source: "pointer", events: 2 });
    expect(fixture.policy.selfApprovalSuspected("desk")).toBe(false);
  } finally {
    fixture.close();
  }
});
