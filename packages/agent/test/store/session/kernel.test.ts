import { generationSnapshot, configureAction, latestGeneration, generationByNumber } from "../../../src/core/store/configure";
import { turnCheckpoint, turnTerminal, openTurns } from "../../../src/core/store/session-reads";
import * as SessionReads from "../../../src/core/store/session-reads";
import { sessionTree } from "../helpers/session-tree";
import { runLedgerSync } from "../helpers/effect";
import { Effect, Result } from "effect";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { type BusEvent, type LedgerAction, type LedgerSession, L0Observation, type SessionGeneration, SessionTurn, } from "@oni/protocol";
import { Bus } from "../helpers/observation";

import type { ObservationSink } from "@oni/protocol";
import { useMemoryStores } from "../helpers/storage";
import { adoptWriter } from "../helpers/session";

const SIGNAL_TIMEOUT_MS = 1_000;

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${label}`)),
      SIGNAL_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const system = {
  preset: "Session preset",
  blocks: [{ id: "rules", source: "test", content: "Follow the rules." }],
};

const writeTool: SessionGeneration.Tool = {
  name: "write",
  inputSchema: { type: "object" },
  category: "mutation",
};
const tools: readonly SessionGeneration.Tool[] = [
  writeTool,
  { name: "read", inputSchema: { type: "object" }, category: "query" },
];

class DroppingObservationSink implements ObservationSink {
  dropNextCommit = false;

  publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
    if (this.dropNextCommit && event.name === L0Observation.ActionCommittedEvent.name) {
      this.dropNextCommit = false;
      return;
    }
    Bus.publish(event, data);
  }

  subscribe<T>(
    event: BusEvent.Descriptor<T>,
    handler: (data: T) => void,
    options?: { match?: Partial<T> },
  ): () => void {
    return Bus.subscribe(event, handler, options);
  }
}

const sink = new DroppingObservationSink();
const stores = useMemoryStores(sink);

beforeEach(() => {
  Bus.reset();
  sink.dropNextCommit = false;
});

afterEach(() => {
  Bus.reset();
});

function materialize(id: string) {
  return Result.getOrThrowWith(
    runLedgerSync(
      Effect.result(
        stores.kernel.materialize({
          id,
          parentId: null,
          role: "resident",
          tools,
          system,
          policyGeneration: 0,
          actionId: `${id}:configure`,
          at: 1,
        }),
      ),
    ),
    (error) => error,
  );
}

function node(action: LedgerAction.Append, ordinal: number): LedgerAction.Node {
  return { ...action, ordinal };
}

function pinned(generation: SessionGeneration.Snapshot) {
  return {
    toolsGeneration: generation.generation,
    toolsHash: generation.toolsHash,
    systemHash: generation.systemHash,
    policyGeneration: generation.policyGeneration,
  };
}

function pendingTurnAction(input: {
  readonly id: string;
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly intent: LedgerAction.Append["intent"];
  readonly ts: number;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: input.intent,
    effect: { encodingVersion: 1, value: SessionTurn.Pending.parse({ phase: "pending" }) },
    irreversible: true,
    ts: input.ts,
  };
}

function turnIntent(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly generation: SessionGeneration.Snapshot;
  readonly resultId: string;
}): LedgerAction.Append {
  return pendingTurnAction({
    ...input,
    intent: {
      encodingVersion: 1,
      value: SessionTurn.HistoricalIntent.parse({
        phase: "intent",
        resultId: input.resultId,
        deliveryIds: [],
        ...pinned(input.generation),
        resumeCount: 0,
        boundaryActionId: null,
      }),
    },
    ts: 10,
  });
}

function turnResume(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly turnId: string;
  readonly generation: SessionGeneration.Snapshot;
  readonly resultId: string;
}): LedgerAction.Append {
  return pendingTurnAction({
    ...input,
    intent: {
      encodingVersion: 1,
      value: SessionTurn.HistoricalResume.parse({
        phase: "resume",
        turnId: input.turnId,
        resultId: input.resultId,
        ...pinned(input.generation),
        resumeCount: 1,
        boundaryActionId: null,
      }),
    },
    ts: 11,
  });
}

function checkpoint(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly turnId: string;
  readonly resultId: string;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: { encodingVersion: 1, value: { phase: "checkpoint", turnId: input.turnId } },
    effect: {
      encodingVersion: 1,
      value: SessionTurn.Checkpoint.parse({
        phase: "checkpoint",
        turnId: input.turnId,
        resultId: input.resultId,
        resumeCount: 1,
        boundaryActionId: input.id,
        boundary: "after_llm",
      }),
    },
    irreversible: true,
    ts: 12,
  };
}

function terminal(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly turnId: string;
  readonly kind: SessionTurn.TerminalKind;
  readonly text: string;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: {
      encodingVersion: 1,
      value: SessionTurn.TerminalIntent.parse({ phase: "terminal", turnId: input.turnId }),
    },
    effect: {
      encodingVersion: 1,
      value: SessionTurn.Terminal.parse({
        phase: "terminal",
        turnId: input.turnId,
        kind: input.kind,
        text: input.text,
        boundaryActionId: input.parentId,
        resumeCount: 1,
      }),
    },
    irreversible: true,
    ts: 13,
  };
}

function delivery(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly turnId: string;
  readonly deliveryId: string;
  readonly content: string;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "prompt",
    intent: { encodingVersion: 1, value: { deliveryId: input.deliveryId } },
    effect: {
      encodingVersion: 1,
      value: SessionTurn.Delivery.parse({
        phase: "delivery",
        turnId: input.turnId,
        deliveryId: input.deliveryId,
        kind: "prompt",
        content: input.content,
        origin: { encodingVersion: 1, value: { source: "test" } },
        boundary: "before_llm",
      }),
    },
    irreversible: true,
    ts: 9,
  };
}

/** A received message on the chain: a `prompt` action carrying the delivery payload. */
function prompt(
  id: string,
  sessionId: string,
  content: string,
  parentActionId: string,
): LedgerAction.Append {
  return {
    id,
    parentId: parentActionId,
    sessionId,
    kind: "prompt",
    intent: { encodingVersion: 1, value: { source: "test" } },
    effect: { encodingVersion: 1, value: { deliveryKind: "prompt", content } },
    irreversible: true,
    ts: 5,
  };
}

/** One fenced single-action commit; returns the committed receipt. */
function commitOne(
  authority: { sessionId: string; owner: string; fence: number },
  action: LedgerAction.Append,
  state: LedgerSession.Row["state"] = "idle",
) {
  const kernel = stores.kernel;
  return Result.getOrThrowWith(
    runLedgerSync(
      Effect.result(
        kernel.commit({
          sessionId: authority.sessionId,
          owner: authority.owner,
          fence: authority.fence,
          now: 12,
          expectedRevision: kernel.row(authority.sessionId).revision,
          actions: [action],
          state,
        }),
      ),
    ),
    (error) => error,
  );
}

function commitWithDroppedMiddle(authority: { sessionId: string; owner: string; fence: number }): void {
  const { sessionId } = authority;
  commitOne(authority, prompt(`${sessionId}-1`, sessionId, "one", `${sessionId}:configure`));
  sink.dropNextCommit = true;
  commitOne(authority, prompt(`${sessionId}-2`, sessionId, "two", `${sessionId}-1`));
  commitOne(authority, prompt(`${sessionId}-3`, sessionId, "three", `${sessionId}-2`));
}

describe("session kernel folds", () => {
  test("canonicalizes generations and decodes every turn action shape", () => {
    const generation = generationSnapshot({
      generation: 2,
      revertTo: 1,
      tools,
      system,
      policyGeneration: 3,
    });
    expect(generation.tools.map((tool) => tool.name)).toEqual(["read", "write"]);
    expect(generation.systemValue).toBe("Session preset\n\nFollow the rules.");

    const configured = node(
      configureAction({
        id: "configured",
        sessionId: "folded",
        parentId: null,
        operation: "tools.add",
        snapshot: generation,
        at: 1,
      }),
      1,
    );
    expect(latestGeneration([configured])).toEqual(generation);
    expect(generationByNumber([configured], 2)).toEqual(generation);
    expect(generationByNumber([configured], 1)).toBeUndefined();
    expect(() => latestGeneration([])).toThrow("no configured generation");

    expect(() =>
      generationSnapshot({
        generation: 1,
        revertTo: 0,
        tools: [writeTool, writeTool],
        system,
        policyGeneration: 0,
      }),
    ).toThrow("duplicate tool name");
    expect(() =>
      generationSnapshot({
        generation: 1,
        revertTo: 0,
        tools: [],
        system: {
          preset: "",
          blocks: [
            { id: "duplicate", source: "test", content: "one" },
            { id: "duplicate", source: "test", content: "two" },
          ],
        },
        policyGeneration: 0,
      }),
    ).toThrow("duplicate system block id");

    const intent = node(
      turnIntent({
        id: "turn-1",
        sessionId: "folded",
        parentId: "configured",
        generation,
        resultId: "result-1",
      }),
      2,
    );
    const resumed = node(
      turnResume({
        id: "resume-1",
        sessionId: "folded",
        parentId: "turn-1",
        turnId: "turn-1",
        generation,
        resultId: "result-1",
      }),
      3,
    );
    const checked = node(
      checkpoint({
        id: "checkpoint-1",
        sessionId: "folded",
        parentId: "resume-1",
        turnId: "turn-1",
        resultId: "result-1",
      }),
      4,
    );
    const delivered = node(
      delivery({
        id: "delivery-1",
        sessionId: "folded",
        parentId: "checkpoint-1",
        turnId: "turn-1",
        deliveryId: "prompt-1",
        content: "continue",
      }),
      5,
    );
    const closed = node(
      terminal({
        id: "result-1",
        sessionId: "folded",
        parentId: "delivery-1",
        turnId: "turn-1",
        kind: "result",
        text: "done",
      }),
      6,
    );

    expect(SessionReads.turnIntent(intent)?.resultId).toBe("result-1");
    expect(SessionReads.turnResume(resumed)?.resumeCount).toBe(1);
    expect(turnCheckpoint(checked)?.boundaryActionId).toBe("checkpoint-1");
    expect(SessionReads.delivery(delivered)?.content).toBe("continue");
    expect(turnTerminal(closed)?.kind).toBe("result");
    expect(SessionReads.turnIntent(configured)).toBeUndefined();
    expect(SessionReads.delivery(intent)).toBeUndefined();

    expect(openTurns([configured, intent, resumed, checked])).toEqual([
      expect.objectContaining({
        turnId: "turn-1",
        resultId: "result-1",
        resumeCount: 1,
        boundaryActionId: "checkpoint-1",
        action: checked,
      }),
    ]);
    expect(openTurns([configured, intent, resumed, checked, closed])).toEqual(
      [],
    );
  });

  test("reads authoritative open and terminal tails from committed session actions", () => {
    const kernel = stores.kernel;
    const sessionId = "snapshot-session";
    materialize(sessionId);
    const generation = latestGeneration(
      sessionTree(sessionId, stores.session.actions),
    );
    const authority = adoptWriter(kernel, sessionId, "owner");
    expect(authority).toEqual({ sessionId, owner: "owner", fence: 1 });

    const first = commitOne(
      authority,
      prompt("prompt-1", sessionId, "first", `${sessionId}:configure`),
    ).receipts[0]?.action;
    const second = commitOne(authority, prompt("prompt-2", sessionId, "second", "prompt-1"))
      .receipts[0]?.action;
    if (first === undefined || second === undefined) throw new Error("prompt commits failed");
    expect(kernel.pendingMessages(sessionId)).toMatchObject([
      { id: "prompt-1", content: "first", kind: "prompt", status: "pending", ordinal: 1 },
      { id: "prompt-2", content: "second", kind: "prompt", status: "pending", ordinal: 2 },
    ]);

    const deliveredFirst = delivery({
      id: "prompt-1:delivery",
      sessionId,
      parentId: second.id,
      turnId: "turn-1",
      deliveryId: first.id,
      content: "first",
    });
    const deliveredSecond = delivery({
      id: "prompt-2:delivery",
      sessionId,
      parentId: deliveredFirst.id,
      turnId: "turn-1",
      deliveryId: second.id,
      content: "second",
    });
    const intent = turnIntent({
      id: "turn-1",
      sessionId,
      parentId: deliveredSecond.id,
      generation,
      resultId: "result-1",
    });
    const running = Result.getOrThrowWith(
      runLedgerSync(
        Effect.result(
          kernel.commit({
            sessionId,
            owner: "owner",
            fence: authority.fence,
            now: 12,
            expectedRevision: kernel.row(sessionId).revision,
            actions: [deliveredFirst, deliveredSecond, intent],
            state: "running",
          }),
        ),
      ),
      (error) => error,
    );
    expect(running.ok).toBe(true);
    expect(kernel.pendingMessages(sessionId)).toEqual([]);
    expect(kernel.getSnapshot(sessionId)).toMatchObject({
      id: sessionId,
      state: "running",
      openTurnId: "turn-1",
      turns: [{ state: "running", messages: [{ text: "first" }, { text: "second" }] }],
    });

    const continuation = commitOne(
      authority,
      prompt("prompt-3", sessionId, "third", "turn-1"),
      "running",
    ).receipts[0]?.action;
    if (continuation === undefined) throw new Error("continuation commit failed");
    const deliveredThird = delivery({
      id: "prompt-3:delivery",
      sessionId,
      parentId: continuation.id,
      turnId: "turn-1",
      deliveryId: continuation.id,
      content: "third",
    });
    const checked = checkpoint({
      id: "checkpoint-1",
      sessionId,
      parentId: deliveredThird.id,
      turnId: "turn-1",
      resultId: "result-1",
    });
    expect(
      Result.getOrThrowWith(
        runLedgerSync(
          Effect.result(
            kernel.commit({
              sessionId,
              owner: "owner",
              fence: authority.fence,
              now: 13,
              expectedRevision: kernel.row(sessionId).revision,
              actions: [deliveredThird, checked],
              state: "running",
            }),
          ),
        ),
        (error) => error,
      ).ok,
    ).toBe(true);
    const result = terminal({
      id: "result-1",
      sessionId,
      parentId: checked.id,
      turnId: "turn-1",
      kind: "result",
      text: "answer",
    });
    expect(commitOne(authority, result, "idle").ok).toBe(true);

    expect(kernel.getSnapshot(sessionId)).toMatchObject({
      state: "idle",
      turns: [
        {
          turnId: "turn-1",
          state: "idle",
          terminal: { kind: "result", actionId: "result-1" },
          messages: [
            { role: "user", text: "first" },
            { role: "user", text: "second" },
            { role: "user", text: "third" },
            { role: "assistant", text: "answer" },
          ],
        },
      ],
    });
    expect(kernel.getSnapshot(sessionId, 0).turns).toEqual([]);
    expect(() => kernel.getSnapshot(sessionId, -1)).toThrow("turn count must be non-negative");
    expect(kernel.listRows().map((row) => row.id)).toEqual([sessionId]);
  });

  test("watch emits revisions and gaps, then releases all subscribers", async () => {
    const kernel = stores.kernel;
    materialize("watched");
    const authority = adoptWriter(kernel, "watched", "owner");
    const watch = kernel.watchSnapshot("watched", 1, sink);
    const seen: SessionTurn.Observation[] = [];
    let resolveObservations: () => void = () => undefined;
    const observations = new Promise<void>((resolve) => {
      resolveObservations = resolve;
    });
    const stopHandler = watch.subscribe((observation) => {
      seen.push(observation);
      if (seen.length === 2) resolveObservations();
    });

    commitWithDroppedMiddle(authority);
    await bounded(observations, "watch observations");

    expect(seen).toEqual([
      expect.objectContaining({ kind: "revision", sessionId: "watched", revision: 2 }),
      { kind: "gap", sessionId: "watched", from: 2, to: 4 },
    ]);
    expect(kernel.getSnapshot("watched").revision).toBe(4);
    stopHandler();
    watch.unsubscribe();
    watch.unsubscribe();
    expect(() => watch.subscribe(() => undefined)).toThrow("watch is unsubscribed");
  });

  test("a dropped notification resynchronizes from the last revision through bounded pages without inventing events", async () => {
    const kernel = stores.kernel;
    materialize("resync");
    const authority = adoptWriter(kernel, "resync", "owner");
    const watch = kernel.watchSnapshot("resync", 1, sink);
    const seen: LedgerAction.Node[] = [];
    const gap = new Promise<SessionTurn.Observation>((resolve) => {
      watch.subscribe((observation) => {
        if (observation.kind === "gap") resolve(observation);
      });
    });

    commitWithDroppedMiddle(authority);
    commitOne(authority, prompt("resync-4", "resync", "four", "resync-3"));
    const observed = await bounded(gap, "gap observation");
    expect(observed).toEqual({ kind: "gap", sessionId: "resync", from: 2, to: 4 });
    if (observed.kind !== "gap") throw new Error("gap expected");

    let page = kernel.historyPage("resync", { afterRevision: observed.from, limit: 2 });
    expect(page).toMatchObject({ afterRevision: 2, headRevision: 5, nextRevision: 4 });
    seen.push(...page.actions);
    page = kernel.historyPage("resync", {
      afterRevision: page.nextRevision ?? 0,
      limit: 2,
    });
    expect(page.nextRevision).toBeNull();
    seen.push(...page.actions);
    expect(seen.map((action) => [action.id, action.ordinal])).toEqual([
      ["resync-2", 3],
      ["resync-3", 4],
      ["resync-4", 5],
    ]);
    expect(seen).toEqual(sessionTree("resync", stores.session.actions).slice(2));
    expect(kernel.historyPage("resync", { afterRevision: 5 })).toEqual({
      sessionId: "resync",
      afterRevision: 5,
      headRevision: 5,
      actions: [],
      nextRevision: null,
    });
    expect(() => kernel.historyPage("resync", { limit: 0 })).toThrow(z.ZodError);
    expect(() => kernel.historyPage("missing")).toThrow("session not found");
    watch.unsubscribe();
  });

  test("a failed initial watch snapshot releases its observation subscription", () => {
    let subscriptions = 0;
    const observations: ObservationSink = {
      publish: () => undefined,
      subscribe: () => {
        subscriptions += 1;
        return () => {
          subscriptions -= 1;
        };
      },
    };

    expect(() => stores.kernel.watchSnapshot("missing", 1, observations)).toThrow(
      "session not found",
    );
    expect(subscriptions).toBe(0);
  });

  test("wrapper failures stay loud when rows or authority are absent", () => {
    const kernel = stores.kernel;
    expect(() => kernel.row("missing")).toThrow("session not found");
    expect(() =>
      Result.getOrThrowWith(
        runLedgerSync(
          Effect.result(kernel.adoptFence({ sessionId: "missing", owner: "owner", fence: 1 })),
        ),
        (error) => error,
      ),
    ).toThrow(expect.objectContaining({ _tag: "SessionNotFound" }));
    expect(() =>
      Result.getOrThrowWith(
        runLedgerSync(
          Effect.result(
            kernel.commit({
              sessionId: "missing",
              owner: "owner",
              fence: 1,
              now: 1,
              expectedRevision: 0,
              actions: [],
              state: "idle",
            }),
          ),
        ),
        (error) => error,
      ),
    ).toThrow(expect.objectContaining({ _tag: "SessionNotFound" }));

    const policies = stores.catalog.policies;
    expect(kernel.currentPolicyGeneration()).toBe(0);
    expect(
      policies.append({
        name: "configure",
        kind: "session.configure",
        phase: "pre",
        match: { encodingVersion: 1, value: {} },
        verdict: { encodingVersion: 1, value: { kind: "allow" } },
        priority: 0,
        generation: 4,
      }),
    ).toBe(true);
    expect(kernel.currentPolicyGeneration()).toBe(4);
    expect(kernel.policyRows(4)).toHaveLength(1);

    expect(() => kernel.watchSnapshot("missing", 1, { publish: () => undefined })).toThrow(
      "requires a subscribable observation sink",
    );
  });
});

describe("session kernel commit query budget (#1314)", () => {
  test("one existence and one parent query per accepted action; in-batch parents query nothing", () => {
    const sessionId = "query-spy";
    materialize(sessionId);
    const authority = adoptWriter(stores.kernel, sessionId, "owner");
    const actions = [
      prompt(`${sessionId}-1`, sessionId, "one", `${sessionId}:configure`),
      prompt(`${sessionId}-2`, sessionId, "two", `${sessionId}-1`),
      prompt(`${sessionId}-3`, sessionId, "three", `${sessionId}-2`),
    ];
    const counts = { exists: 0, parent: 0 };
    const original = Database.prototype.query;
    // Query spy: count the two validation statements;
    // `validActionBatch` is their single call site per action. Matched by
    // pattern, not string equality (review r1 L1), so a rephrased second
    // check cannot evade the count.
    const spy = function (this: Database, ...args: Parameters<typeof original>) {
      const sql = args[0];
      if (/SELECT 1 FROM action/.test(sql)) counts.exists += 1;
      else if (/SELECT session_id FROM action/.test(sql)) counts.parent += 1;
      return original.apply(this, args);
    };
    Database.prototype.query = spy as typeof original;
    try {
      const result = Result.getOrThrowWith(
        runLedgerSync(
          Effect.result(
            stores.kernel.commit({
              sessionId,
              owner: authority.owner,
              fence: authority.fence,
              now: 12,
              expectedRevision: stores.kernel.row(sessionId).revision,
              actions,
              state: "idle",
            }),
          ),
        ),
        (error) => error,
      );
      expect(result.receipts).toHaveLength(3);
    } finally {
      Database.prototype.query = original;
    }
    // Exactly one existence check per action; one parent lookup for the lone
    // external parent (`:configure`) — in-batch parents resolve from the set.
    expect(counts.exists).toBe(3);
    expect(counts.parent).toBe(1);
  });

  test("duplicate-id + schema-mismatch single append throws SchemaRefused (review r1 H2)", () => {
    const sessionId = "double-fault";
    materialize(sessionId);
    const authority = adoptWriter(stores.kernel, sessionId, "owner");
    commitOne(authority, prompt(`${sessionId}-1`, sessionId, "one", `${sessionId}:configure`));
    // Both faults at once: the id is already on the chain AND the body fails
    // the `prompt` declaration (`delivery` outside steer|followUp). The
    // fail-closed order says the schema refusal wins — the typed throw, never
    // a silent `undefined` from the duplicate-id existence check.
    const doubleFault: LedgerAction.Append = {
      ...prompt(`${sessionId}-1`, sessionId, "dup", `${sessionId}:configure`),
      intent: { encodingVersion: 1, value: { source: "test", delivery: "bogus" } },
    };
    expect(() =>
      stores.session.actions.append(doubleFault, stores.kernel.row(sessionId).revision),
    ).toThrow(expect.objectContaining({ _tag: "SchemaRefused" }));
  });
});
