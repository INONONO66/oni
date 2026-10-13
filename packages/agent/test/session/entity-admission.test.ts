// W5.1 check4 as a package test (plan §4): the admission and request-transition
// contracts as expected-decision tables against the EXPORTED pure functions
// (parity framing dropped per review F7), plus the real-entity integration
// proofs: C1 single-writer FIFO and A17 whole-backlog drain (F4).
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Delivery, LedgerSession, SessionTransition } from "@openomni/protocol";
import { Deferred, Effect } from "effect";
import { decideRequestTransition } from "../../src/core/request";
import { decideSessionAdmission } from "../../src/core/admission";
import {
  fixtureOpenTurn,
  fixtureTerminal,
  fixtureTurn,
} from "../helpers/open-turn-fixture";
import { openRequest } from "../helpers/open-request";
import { approvalAnswer, invocationNode, kernelOwnedRow } from "../helpers/request-fixtures";
import { TEST_APPROVAL_POLICY } from "../helpers/approval-policy";
import {
  clusterTempDir,
  readChain,
  runCluster,
  type TestTurnInput,
  type TestTurnRunner,
  sendPrompt,
  sendResume,
  sessionFileFor,
  verifyChain,
} from "../helpers/cluster-runtime";

type AdmissionSnapshot = Parameters<typeof decideSessionAdmission>[0];
type AdmissionDecision = ReturnType<typeof decideSessionAdmission>;
type OpenTurn = NonNullable<AdmissionSnapshot["open"]>;
type TurnTerminal = NonNullable<AdmissionSnapshot["terminal"]>;

// Shared fixtures (mirrors packages/agent/test/session-fsm.test.ts shapes).

const sessionRow = (state: LedgerSession.State) => kernelOwnedRow("S", state);

const turn = fixtureTurn;
const open: OpenTurn = fixtureOpenTurn;

const terminal: (kind: "result" | "interrupted") => TurnTerminal = fixtureTerminal;

let itemSequence = 0;
function item(kind: Delivery.Kind, sessionId = "S"): Delivery.Row {
  itemSequence += 1;
  return {
    id: `M${itemSequence}`,
    sessionId,
    kind,
    content: kind,
    origin: { encodingVersion: 1, value: { kind: "session", id: sessionId } },
    status: "pending",
    consumedBy: null,
    consumedAt: null,
    createdAt: itemSequence,
    ordinal: itemSequence,
  };
}

/** The W1 contract surface: the decision kind plus WHICH items/turn it selects. */
function normalize(decision: AdmissionDecision): { kind: string; ids: readonly string[] } {
  switch (decision.kind) {
    case "recover":
      return { kind: decision.kind, ids: [decision.open.turnId] };
    case "resume":
      return { kind: decision.kind, ids: [decision.item.id] };
    case "consume":
      return { kind: decision.kind, ids: decision.items.map((entry) => entry.id) };
    default:
      return { kind: decision.kind, ids: [] };
  }
}

// Table A: admission expected-decision rows (A01–A17).

interface AdmissionCase {
  readonly name: string;
  readonly state: LedgerSession.State;
  readonly items: readonly Delivery.Row[];
  readonly open?: OpenTurn;
  readonly terminal?: TurnTerminal;
  readonly expected: { readonly kind: string; readonly at?: readonly number[] };
}

const prompt = () => item("prompt");
const interrupt = () => item("interrupt");
const resume = () => item("resume");

// `expected.at` indexes into `items` for the ids the decision must select
// (recover selects the open turn "T" instead and is asserted explicitly).
const admissionCases: readonly AdmissionCase[] = [
  { name: "A01 idle + [] -> stop", state: "idle", items: [], expected: { kind: "stop" } },
  {
    name: "A02 idle + [prompt] -> start",
    state: "idle",
    items: [prompt()],
    expected: { kind: "start" },
  },
  {
    name: "A03 idle + [interrupt, prompt] -> consume [interrupt]",
    state: "idle",
    items: [interrupt(), prompt()],
    expected: { kind: "consume", at: [0] },
  },
  {
    name: "A04 idle + [prompt, prompt] -> start (second stays queued)",
    state: "idle",
    items: [prompt(), prompt()],
    expected: { kind: "start" },
  },
  {
    name: "A05 idle + [resume] -> consume [resume]",
    state: "idle",
    items: [resume()],
    expected: { kind: "consume", at: [0] },
  },
  {
    name: "A06 idle + [resume, resume, prompt] -> consume control prefix",
    state: "idle",
    items: [resume(), resume(), prompt()],
    expected: { kind: "consume", at: [0, 1] },
  },
  {
    name: "A07 running + open -> recover",
    state: "running",
    items: [prompt()],
    open,
    expected: { kind: "recover" },
  },
  {
    name: "A08 running without open -> refused",
    state: "running",
    items: [prompt()],
    expected: { kind: "refused" },
  },
  {
    name: "A09 interrupted + [resume] + terminal interrupted -> resume",
    state: "interrupted",
    items: [resume()],
    terminal: terminal("interrupted"),
    expected: { kind: "resume", at: [0] },
  },
  {
    name: "A10 interrupted + [resume] without interrupted terminal -> consume",
    state: "interrupted",
    items: [resume()],
    terminal: terminal("result"),
    expected: { kind: "consume", at: [0] },
  },
  {
    name: "A11 interrupted + [prompt] -> stop",
    state: "interrupted",
    items: [prompt()],
    terminal: terminal("interrupted"),
    expected: { kind: "stop" },
  },
  {
    name: "A12 foreign-session item -> refused",
    state: "idle",
    items: [item("prompt", "other-session")],
    expected: { kind: "refused" },
  },
  {
    name: "A13 foreign open -> refused",
    state: "running",
    items: [],
    open: { ...open, action: { ...turn, sessionId: "other-session" } },
    expected: { kind: "refused" },
  },
  {
    name: "A14 foreign terminal -> refused",
    state: "interrupted",
    items: [resume()],
    terminal: (() => {
      const t = terminal("interrupted");
      return { ...t, action: { ...t.action, sessionId: "other-session" } };
    })(),
    expected: { kind: "refused" },
  },
  {
    name: "A15 idle + own open -> refused",
    state: "idle",
    items: [prompt()],
    open,
    expected: { kind: "refused" },
  },
];

function decide(c: AdmissionCase): AdmissionDecision {
  return decideSessionAdmission({
    row: sessionRow(c.state),
    pending: c.items,
    capabilityKinds: ["tool", "compaction"],
    ...(c.open === undefined ? {} : { open: c.open }),
    ...(c.terminal === undefined ? {} : { terminal: c.terminal }),
  });
}

describe("Table A: admission decisions over the chain-derived pending set", () => {
  for (const c of admissionCases) {
    test(c.name, () => {
      const decision = decide(c);
      expect(decision.kind).toBe(c.expected.kind as AdmissionDecision["kind"]);
      if (c.expected.at !== undefined) {
        const ids = c.expected.at.map((index) => {
          const selected = c.items[index];
          if (selected === undefined) throw new Error(`case ${c.name}: bad index ${index}`);
          return selected.id;
        });
        expect(normalize(decision).ids).toEqual(ids);
      }
      if (decision.kind === "recover") expect(decision.open.turnId).toBe("T");
    });
  }

  test("A16 FIFO invariance (idle): items after the first prompt never change the decision", () => {
    const prefixes: readonly (readonly Delivery.Kind[])[] = [
      ["prompt"],
      ["interrupt", "prompt"],
      ["resume", "prompt"],
      ["interrupt", "resume", "prompt"],
      ["resume", "resume", "prompt"],
    ];
    const suffixes: readonly (readonly Delivery.Kind[])[] = [
      [],
      ["prompt"],
      ["interrupt"],
      ["resume", "prompt"],
      ["interrupt", "interrupt", "prompt"],
    ];
    const row = sessionRow("idle");
    for (const prefix of prefixes) {
      const prefixItems = prefix.map((kind) => item(kind));
      const base = normalize(decideSessionAdmission({ row, pending: prefixItems, capabilityKinds: ["tool", "compaction"] }));
      for (const suffix of suffixes) {
        const extended = [...prefixItems, ...suffix.map((kind) => item(kind))];
        expect(normalize(decideSessionAdmission({ row, pending: extended, capabilityKinds: ["tool", "compaction"] }))).toEqual(base);
      }
    }
  });

  test("A17 interrupted scans the WHOLE pending set for resume (not prefix-invariant)", () => {
    const row = sessionRow("interrupted");
    const items = [prompt(), resume()];
    const decision = decideSessionAdmission({
      row,
      pending: items,
      capabilityKinds: ["tool", "compaction"],
      terminal: terminal("interrupted"),
    });
    expect(decision.kind).toBe("resume");
    const second = items[1];
    if (second === undefined || decision.kind !== "resume") throw new Error("fixture");
    expect(decision.item.id).toBe(second.id);
  });
});

// Table B: request transitions per message in FIFO order (B1–B8).

const requestRow = sessionRow("running");

function makeRequest(): SessionTransition.Request {
  return openRequest({
    requestId: "invocation",
    sessionId: requestRow.id,
    turnId: "T",
    callId: "call",
    parsedInput: { path: "original" },
  });
}

const invocation = invocationNode({ sessionId: requestRow.id, parentId: "T" });

interface RequestItem {
  readonly id: string;
  readonly at: number;
  readonly payload: SessionTransition.Payload;
}

const sealed = makeRequest();

function resolveItem(id: string, at = 20): RequestItem {
  return { id, at, payload: { kind: "request.answer", answer: approvalAnswer(sealed, id, at) } };
}
function cancelItem(id: string, at = 20): RequestItem {
  return {
    id,
    at,
    payload: {
      kind: "request.cancel",
      requestId: sealed.requestId,
      principal: { kind: "owner", principalId: "owner", evidenceId: "authenticated" },
    },
  };
}
function timeoutItem(id: string, at: number): RequestItem {
  return { id, at, payload: { kind: "request.timeout", requestId: sealed.requestId } };
}
function openItem(id: string, at = 20): RequestItem {
  return { id, at, payload: { kind: "request.open", request: makeRequest() } };
}

/** Apply decideRequestTransition per item in the given order, threading state. */
function foldRequestItems(
  items: readonly RequestItem[],
  initial: SessionTransition.Request | undefined,
): { resolutions: readonly SessionTransition.Resolution[]; request?: SessionTransition.Request } {
  let current = initial;
  const resolutions: SessionTransition.Resolution[] = [];
  for (const entry of items) {
    const decision = decideRequestTransition(
      {
        version: 1,
        inputId: entry.id,
        sessionId: requestRow.id,
        at: entry.at,
        expectedRevision: requestRow.revision,
        authority: { owner: "kernel", fence: 1 },
        payload: entry.payload,
      },
      { row: requestRow, invocation, ...(current === undefined ? {} : { request: current }) },
      TEST_APPROVAL_POLICY.recentOpen,
    );
    resolutions.push(decision.resolution);
    if (decision.request !== undefined) current = decision.request;
  }
  return { resolutions, ...(current === undefined ? {} : { request: current }) };
}

interface RequestCase {
  readonly name: string;
  readonly items: readonly RequestItem[];
  readonly initial?: SessionTransition.Request;
  readonly expected: readonly SessionTransition.Resolution[];
  readonly finalState?: SessionTransition.Request["state"];
}

const requestCases: readonly RequestCase[] = [
  {
    name: "B1 [resolve] -> resolved",
    items: [resolveItem("b1-a")],
    initial: makeRequest(),
    expected: ["resolved"],
    finalState: "resolved",
  },
  {
    name: "B2 [resolve, cancel] -> resolved then duplicate (terminal already won)",
    items: [resolveItem("b2-a"), cancelItem("b2-b")],
    initial: makeRequest(),
    expected: ["resolved", "duplicate"],
    finalState: "resolved",
  },
  {
    name: "B3 [cancel, resolve] -> cancelled; later resolve refused-as-duplicate",
    items: [cancelItem("b3-a"), resolveItem("b3-b")],
    initial: makeRequest(),
    expected: ["cancelled", "duplicate"],
    finalState: "cancelled",
  },
  {
    name: "B4 [cancel, timeout] -> cancelled then duplicate",
    items: [cancelItem("b4-a"), timeoutItem("b4-b", 150)],
    initial: makeRequest(),
    expected: ["cancelled", "duplicate"],
    finalState: "cancelled",
  },
  {
    name: "B5 [timeout, resolve] -> expired then late_unknown",
    items: [timeoutItem("b5-a", 150), resolveItem("b5-b", 150)],
    initial: makeRequest(),
    expected: ["expired", "late_unknown"],
    finalState: "expired",
  },
  {
    name: "B6 duplicate resolve -> resolved then duplicate",
    items: [resolveItem("b6-a"), resolveItem("b6-b")],
    initial: makeRequest(),
    expected: ["resolved", "duplicate"],
    finalState: "resolved",
  },
  {
    name: "B7 [open, resolve] -> opened then resolved",
    items: [openItem("b7-a"), resolveItem("b7-b")],
    expected: ["opened", "resolved"],
    finalState: "resolved",
  },
];

describe("Table B: request commands in FIFO order keep the W1 resolutions", () => {
  for (const c of requestCases) {
    test(c.name, () => {
      const fold = foldRequestItems(c.items, c.initial);
      expect(fold.resolutions).toEqual(c.expected);
      if (c.finalState !== undefined) expect(fold.request?.state).toBe(c.finalState);
    });
  }

  test("B8 cancel-first means the resolve never resolves and produces no intake", () => {
    const first = foldRequestItems([cancelItem("b8-a")], makeRequest());
    if (first.request === undefined) throw new Error("cancel must return a request");
    const decision = decideRequestTransition(
      {
        version: 1,
        inputId: "b8-b",
        sessionId: requestRow.id,
        at: 20,
        expectedRevision: 1,
        authority: { owner: "kernel", fence: 1 },
        payload: { kind: "request.answer", answer: approvalAnswer(sealed, "b8-b", 20) },
      },
      { row: requestRow, invocation, request: first.request },
      TEST_APPROVAL_POLICY.recentOpen,
    );
    expect(decision.resolution).not.toBe("resolved");
    expect(decision.resolution).not.toBe("attached");
    expect(decision.receive).toBeUndefined();
    expect(decision.request?.state).toBe("cancelled");
  });
});

// Integration on the real entity: C1 single-writer FIFO + A17 backlog drain.

const { dir, sessionsDir, catalogFile } = clusterTempDir("w52-entity-admission-");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sessionState(file: string): string | undefined {
  const db = new Database(file, { readonly: true });
  try {
    return db.query<{ state: string }, []>("SELECT state FROM session").get()?.state;
  } finally {
    db.close();
  }
}

describe("Integration: entity mailbox is a single writer with whole-backlog drain", () => {
  test("C1 three concurrent prompts serialize: distinct ascending receipts, no handler overlap, linear chain", async () => {
    // Deferred-ordered admission probe (no clocks): every handler run posts a
    // start event, resolves its one-shot entry signal, then suspends through
    // explicit scheduler yields before posting its end event. If the mailbox
    // ever admitted two handlers at once, the second fiber would run during
    // those suspension points and interleave its start between another
    // handler's start/end pair.
    const events: string[] = [];
    const runner: TestTurnRunner = (input) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        events.push(`start:${input.turnId}`);
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(entered);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        events.push(`end:${input.turnId}`);
        return { kind: "result" as const, text: "done" };
      });

    const replies = await runCluster(
      { sessionsDir, catalogFile, runner },
      Effect.all(
        [
          sendPrompt("c1", "c1-m1", "one"),
          sendPrompt("c1", "c1-m2", "two"),
          sendPrompt("c1", "c1-m3", "three"),
        ],
        { concurrency: 3 },
      ),
    );

    const ordinals = replies.map((reply) => reply.seq);
    expect(new Set(ordinals).size).toBe(3);
    // Single writer: start/end events come in strict pairs — each handler run
    // observed the previous one finished before its own start was admitted.
    expect(events).toHaveLength(6);
    for (let index = 0; index < events.length; index += 2) {
      const start = events[index];
      const end = events[index + 1];
      if (start === undefined || end === undefined) throw new Error("event fixture");
      expect(start.startsWith("start:")).toBe(true);
      expect(end).toBe(`end:${start.slice("start:".length)}`);
    }
    // OUR hash chain stayed linear under concurrency.
    const file = sessionFileFor(sessionsDir, "c1");
    expect(verifyChain(file, "c1")).toBe(readChain(file, "c1").length);
  }, 60_000);

  test("A17 integration: interrupted + backlog [prompt, resume] resumes and leaves the prompt pending (F4)", async () => {
    const calls: TestTurnInput[] = [];
    const runner: TestTurnRunner = (input) =>
      Effect.sync(() => {
        calls.push(input);
        return calls.length === 1
          ? { kind: "interrupted" as const, text: "cut" }
          : { kind: "result" as const, text: "resumed" };
      });

    await runCluster(
      { sessionsDir, catalogFile, runner },
      Effect.gen(function* () {
        yield* sendPrompt("a17", "a17-p1", "first prompt");
        yield* sendPrompt("a17", "a17-p2", "prompt behind the interrupt");
        yield* sendResume("a17", "a17-r1", "resume");
      }),
    );

    // The resume behind the prompt was selected from the WHOLE backlog: the
    // interrupted turn resumed exactly once without consuming the prompt;
    // Turn-end consumption then ran the pending prompt as its own
    // follow-up turn before the entity went idle.
    expect(calls).toHaveLength(3);
    expect(calls[1]?.resumeCount).toBe(1);
    expect(calls[2]?.resumeCount).toBe(0);
    const file = sessionFileFor(sessionsDir, "a17");
    const chain = readChain(file, "a17");
    expect(chain.filter((row) => row.id === "a17-p2")).toHaveLength(1);
    const db = new Database(file, { readonly: true });
    try {
      const delivered = db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM action WHERE kind = 'prompt' AND effect LIKE '%\"phase\":\"delivery\"%' AND intent LIKE ?",
        )
        .get("%a17-p2%");
      // Delivered exactly once, by the follow-up turn — not by the resume.
      expect(delivered?.n ?? 0).toBe(1);
    } finally {
      db.close();
    }
    expect(sessionState(file)).toBe("idle");
  }, 60_000);
});
