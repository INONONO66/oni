import { describe, expect, test } from "bun:test";
import type { Message } from "../src/message/index.js";
import { Transcript } from "../src/transcript/index.js";

const SESSION_ID = "session-1";
const MESSAGE_ID = "message-1";
const ATTEMPT_ID = "attempt-1";

function buildAssistantInfo(): Message.AssistantMessage {
  return {
    id: MESSAGE_ID,
    sessionID: SESSION_ID,
    role: "assistant",
    time: { created: 1_000 },
    parentID: "message-0",
    modelID: "model-1",
    providerID: "provider-1",
    agent: "agent-1",
    path: { cwd: "/work", root: "/work" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function buildUserInfo(): Message.UserMessage {
  return {
    id: MESSAGE_ID,
    sessionID: SESSION_ID,
    role: "user",
    time: { created: 1_000 },
    agent: "agent-1",
    model: { providerID: "provider-1", modelID: "model-1" },
  };
}

function buildTextPart(overrides: Partial<Message.TextPart> = {}): Message.TextPart {
  return {
    id: "part-text-1",
    sessionID: SESSION_ID,
    messageID: MESSAGE_ID,
    type: "text",
    text: "hel",
    time: { start: 1_100 },
    ...overrides,
  };
}

function buildToolPart(overrides: Partial<Message.ToolPart> = {}): Message.ToolPart {
  return {
    id: "part-tool-1",
    sessionID: SESSION_ID,
    messageID: MESSAGE_ID,
    type: "tool",
    callID: "call-1",
    tool: "read",
    state: { status: "pending", input: { path: "/tmp/a" } },
    ...overrides,
  };
}

function buildUsage(): Transcript.Usage {
  return { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } };
}

function createdFact(info: Message.Info = buildAssistantInfo()): Transcript.Fact {
  return { type: "message.created", attemptId: ATTEMPT_ID, message: info };
}

function appendedFact(part: Message.Part): Transcript.Fact {
  return { type: "part.appended", attemptId: ATTEMPT_ID, messageId: MESSAGE_ID, part };
}

function advancedFact(partId: string, transition: Transcript.PartTransition): Transcript.Fact {
  return {
    type: "part.advanced",
    attemptId: ATTEMPT_ID,
    messageId: MESSAGE_ID,
    partId,
    transition,
  };
}

function finishedFact(
  overrides: { finish?: Transcript.FinishReason; at?: number } = {},
): Transcript.Fact {
  return {
    type: "message.finished",
    attemptId: ATTEMPT_ID,
    messageId: MESSAGE_ID,
    at: overrides.at ?? 2_000,
    finish: overrides.finish ?? "stop",
    usage: buildUsage(),
  };
}

function applyAll(facts: Transcript.Fact[]): Message.WithParts {
  let state: Message.WithParts | undefined;
  for (const fact of facts) {
    const outcome = Transcript.fold(state, fact);
    if (!("applied" in outcome)) {
      throw new Error(`expected applied, got rejected ${outcome.reason}`);
    }
    state = outcome.state;
  }
  if (state === undefined) throw new Error("expected folded state");
  return state;
}

function expectRejected(
  outcome: ReturnType<typeof Transcript.fold>,
  reason: Extract<ReturnType<typeof Transcript.fold>, { rejected: true }>["reason"],
): void {
  if (!("rejected" in outcome)) throw new Error("expected rejected");
  expect(outcome.reason).toBe(reason);
}

describe("Transcript fold — happy path", () => {
  test("created → appended(text) → appended(tool) → running → completed → finished folds to the exact WithParts", () => {
    const state = applyAll([
      createdFact(),
      appendedFact(buildTextPart()),
      appendedFact(buildToolPart()),
      advancedFact("part-tool-1", { to: "running", at: 1_200 }),
      advancedFact("part-tool-1", {
        to: "completed",
        at: 1_500,
        output: "file body",
        title: "Read a",
      }),
      finishedFact(),
    ]);

    expect(state).toEqual({
      info: {
        ...buildAssistantInfo(),
        time: { created: 1_000, completed: 2_000 },
        finish: "stop",
        tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
      },
      parts: [
        buildTextPart(),
        {
          ...buildToolPart(),
          state: {
            status: "completed",
            input: { path: "/tmp/a" },
            output: "file body",
            title: "Read a",
            metadata: {},
            time: { start: 1_200, end: 1_500 },
          },
        },
      ],
    });
  });

  test("completed on a text part stamps the authoritative final text and end time", () => {
    const state = applyAll([
      createdFact(),
      appendedFact(buildTextPart()),
      advancedFact("part-text-1", { to: "completed", at: 1_400, output: "hello" }),
    ]);

    expect(state.parts[0]).toEqual(
      buildTextPart({ text: "hello", time: { start: 1_100, end: 1_400 } }),
    );
  });

  test("interrupted projects a running tool part onto Tool.StateError with error 'interrupted'", () => {
    const state = applyAll([
      createdFact(),
      appendedFact(buildToolPart()),
      advancedFact("part-tool-1", { to: "running", at: 1_200 }),
      advancedFact("part-tool-1", { to: "interrupted", at: 1_300, partialOutput: "par" }),
    ]);

    expect(state.parts[0]).toEqual({
      ...buildToolPart(),
      state: {
        status: "error",
        input: { path: "/tmp/a" },
        error: "interrupted",
        time: { start: 1_200, end: 1_300 },
      },
    });
  });

  test("error transition on a running tool part records the error string", () => {
    const state = applyAll([
      createdFact(),
      appendedFact(buildToolPart()),
      advancedFact("part-tool-1", { to: "running", at: 1_200 }),
      advancedFact("part-tool-1", { to: "error", at: 1_300, error: "boom" }),
    ]);

    if (state.parts[0]?.type !== "tool") throw new Error("expected tool part");
    expect(state.parts[0].state).toEqual({
      status: "error",
      input: { path: "/tmp/a" },
      error: "boom",
      time: { start: 1_200, end: 1_300 },
    });
  });
});

describe("Transcript fold — unknown_message", () => {
  test("any non-created fact on undefined state is unknown_message", () => {
    expectRejected(Transcript.fold(undefined, appendedFact(buildTextPart())), "unknown_message");
    expectRejected(
      Transcript.fold(undefined, advancedFact("part-tool-1", { to: "running", at: 1_200 })),
      "unknown_message",
    );
    expectRejected(Transcript.fold(undefined, finishedFact()), "unknown_message");
  });

  test("a fact addressed to a different messageId is unknown_message", () => {
    const state = applyAll([createdFact()]);
    const outcome = Transcript.fold(state, {
      type: "part.appended",
      attemptId: ATTEMPT_ID,
      messageId: "message-other",
      part: buildTextPart({ messageID: "message-other" }),
    });
    expectRejected(outcome, "unknown_message");
  });
});

describe("Transcript fold — unknown_part", () => {
  test("part.advanced on an absent partId is unknown_part", () => {
    const state = applyAll([createdFact(), appendedFact(buildTextPart())]);
    expectRejected(
      Transcript.fold(state, advancedFact("part-missing", { to: "running", at: 1_200 })),
      "unknown_part",
    );
  });
});

describe("Transcript fold — invalid_transition", () => {
  test("message.created on an existing message is invalid_transition", () => {
    const state = applyAll([createdFact()]);
    expectRejected(Transcript.fold(state, createdFact()), "invalid_transition");
  });

  test("skipping running: pending tool part advanced straight to completed is invalid_transition", () => {
    const state = applyAll([createdFact(), appendedFact(buildToolPart())]);
    expectRejected(
      Transcript.fold(
        state,
        advancedFact("part-tool-1", { to: "completed", at: 1_500, output: "x" }),
      ),
      "invalid_transition",
    );
  });

  test("error and interrupted on a pending tool part are invalid_transition", () => {
    const state = applyAll([createdFact(), appendedFact(buildToolPart())]);
    expectRejected(
      Transcript.fold(
        state,
        advancedFact("part-tool-1", { to: "error", at: 1_300, error: "boom" }),
      ),
      "invalid_transition",
    );
    expectRejected(
      Transcript.fold(state, advancedFact("part-tool-1", { to: "interrupted", at: 1_300 })),
      "invalid_transition",
    );
  });

  test("re-advancing a terminal tool part is invalid_transition", () => {
    const state = applyAll([
      createdFact(),
      appendedFact(buildToolPart()),
      advancedFact("part-tool-1", { to: "running", at: 1_200 }),
      advancedFact("part-tool-1", { to: "completed", at: 1_500, output: "x" }),
    ]);
    expectRejected(
      Transcript.fold(state, advancedFact("part-tool-1", { to: "running", at: 1_600 })),
      "invalid_transition",
    );
    expectRejected(
      Transcript.fold(
        state,
        advancedFact("part-tool-1", { to: "completed", at: 1_600, output: "y" }),
      ),
      "invalid_transition",
    );
  });

  test("re-advancing a completed text part is invalid_transition", () => {
    const state = applyAll([
      createdFact(),
      appendedFact(buildTextPart()),
      advancedFact("part-text-1", { to: "completed", at: 1_400, output: "hello" }),
    ]);
    expectRejected(
      Transcript.fold(
        state,
        advancedFact("part-text-1", { to: "completed", at: 1_500, output: "again" }),
      ),
      "invalid_transition",
    );
  });

  test("non-completed transitions on text parts are invalid_transition", () => {
    const state = applyAll([createdFact(), appendedFact(buildTextPart())]);
    for (const transition of [
      { to: "running", at: 1_200 },
      { to: "error", at: 1_200, error: "boom" },
      { to: "interrupted", at: 1_200 },
    ] satisfies Transcript.PartTransition[]) {
      expectRejected(
        Transcript.fold(state, advancedFact("part-text-1", transition)),
        "invalid_transition",
      );
    }
  });

  test("advancing a punctual part (step-start) is invalid_transition", () => {
    const stepStart: Message.Part = {
      id: "part-step-1",
      sessionID: SESSION_ID,
      messageID: MESSAGE_ID,
      type: "step-start",
    };
    const state = applyAll([createdFact(), appendedFact(stepStart)]);
    expectRejected(
      Transcript.fold(
        state,
        advancedFact("part-step-1", { to: "completed", at: 1_200, output: "" }),
      ),
      "invalid_transition",
    );
  });

  test("appending a duplicate partId is invalid_transition", () => {
    const state = applyAll([createdFact(), appendedFact(buildTextPart())]);
    expectRejected(Transcript.fold(state, appendedFact(buildTextPart())), "invalid_transition");
  });

  test("appending a part stamped with a foreign messageID is invalid_transition", () => {
    const state = applyAll([createdFact()]);
    expectRejected(
      Transcript.fold(state, appendedFact(buildTextPart({ messageID: "message-other" }))),
      "invalid_transition",
    );
  });

  test("message.finished on a user message is invalid_transition", () => {
    const state = applyAll([createdFact(buildUserInfo())]);
    expectRejected(Transcript.fold(state, finishedFact()), "invalid_transition");
  });
});

describe("Transcript fold — appended initial state and coherence (F1/F3/F4/F5)", () => {
  test("appending a tool part born past pending is invalid_transition", () => {
    const state = applyAll([createdFact()]);
    for (const toolState of [
      { status: "running", input: {}, time: { start: 1_200 } },
      {
        status: "completed",
        input: {},
        output: "x",
        title: "t",
        metadata: {},
        time: { start: 1_200, end: 1_300 },
      },
      { status: "error", input: {}, error: "boom", time: { start: 1_200, end: 1_300 } },
    ] satisfies Message.ToolPart["state"][]) {
      expectRejected(
        Transcript.fold(state, appendedFact(buildToolPart({ state: toolState }))),
        "invalid_transition",
      );
    }
  });

  test("appending a text or reasoning part born terminal (time.end set) is invalid_transition", () => {
    const state = applyAll([createdFact()]);
    expectRejected(
      Transcript.fold(state, appendedFact(buildTextPart({ time: { start: 1_100, end: 1_200 } }))),
      "invalid_transition",
    );
    const reasoning: Message.Part = {
      id: "part-reasoning-1",
      sessionID: SESSION_ID,
      messageID: MESSAGE_ID,
      type: "reasoning",
      text: "thinking",
      time: { start: 1_100, end: 1_200 },
    };
    expectRejected(Transcript.fold(state, appendedFact(reasoning)), "invalid_transition");
  });

  test("appending a part stamped with a foreign sessionID is invalid_transition", () => {
    const state = applyAll([createdFact()]);
    expectRejected(
      Transcript.fold(state, appendedFact(buildTextPart({ sessionID: "session-other" }))),
      "invalid_transition",
    );
  });

  test("closing a running part before its start (end < start) is invalid_transition", () => {
    const state = applyAll([
      createdFact(),
      appendedFact(buildToolPart()),
      advancedFact("part-tool-1", { to: "running", at: 1_200 }),
    ]);
    expectRejected(
      Transcript.fold(
        state,
        advancedFact("part-tool-1", { to: "completed", at: 1_100, output: "x" }),
      ),
      "invalid_transition",
    );
    expectRejected(
      Transcript.fold(
        state,
        advancedFact("part-tool-1", { to: "error", at: 1_100, error: "boom" }),
      ),
      "invalid_transition",
    );
    expectRejected(
      Transcript.fold(state, advancedFact("part-tool-1", { to: "interrupted", at: 1_100 })),
      "invalid_transition",
    );

    const textState = applyAll([createdFact(), appendedFact(buildTextPart())]);
    expectRejected(
      Transcript.fold(
        textState,
        advancedFact("part-text-1", { to: "completed", at: 1_000, output: "h" }),
      ),
      "invalid_transition",
    );
  });

  test("message.created with an already-finished assistant info is invalid_transition", () => {
    const finishedInfo: Message.Info = { ...buildAssistantInfo(), finish: "stop" };
    expectRejected(Transcript.fold(undefined, createdFact(finishedInfo)), "invalid_transition");
  });
});

describe("Transcript fold — reasoning signature carrier (F2)", () => {
  test("completed with signature projects it onto the reasoning part", () => {
    const reasoning: Message.Part = {
      id: "part-reasoning-1",
      sessionID: SESSION_ID,
      messageID: MESSAGE_ID,
      type: "reasoning",
      text: "thi",
      time: { start: 1_100 },
    };
    const state = applyAll([
      createdFact(),
      appendedFact(reasoning),
      advancedFact("part-reasoning-1", {
        to: "completed",
        at: 1_400,
        output: "thinking done",
        signature: "sig-1",
      }),
    ]);
    expect(state.parts[0]).toEqual({
      ...reasoning,
      text: "thinking done",
      signature: "sig-1",
      time: { start: 1_100, end: 1_400 },
    });
  });

  test("signature on completed is ignored for text and tool parts", () => {
    const state = applyAll([
      createdFact(),
      appendedFact(buildTextPart()),
      appendedFact(buildToolPart()),
      advancedFact("part-tool-1", { to: "running", at: 1_200 }),
      advancedFact("part-text-1", {
        to: "completed",
        at: 1_400,
        output: "hello",
        signature: "sig-1",
      }),
      advancedFact("part-tool-1", { to: "completed", at: 1_500, output: "x", signature: "sig-1" }),
    ]);
    expect(state.parts[0]).toEqual(
      buildTextPart({ text: "hello", time: { start: 1_100, end: 1_400 } }),
    );
    if (state.parts[1]?.type !== "tool") throw new Error("expected tool part");
    expect("signature" in state.parts[1]).toBe(false);
  });

  test("PartTransition completed round-trips signature through zod", () => {
    const transition = { to: "completed", at: 1_400, output: "o", signature: "sig-1" };
    expect(Transcript.PartTransition.parse(transition)).toEqual(transition as never);
  });
});

describe("Transcript fold — already_finished", () => {
  test("a second message.finished is already_finished", () => {
    const state = applyAll([createdFact(), finishedFact()]);
    expectRejected(Transcript.fold(state, finishedFact({ at: 2_100 })), "already_finished");
  });

  test("any fact after message.finished is already_finished", () => {
    const state = applyAll([
      createdFact(),
      appendedFact(buildToolPart()),
      advancedFact("part-tool-1", { to: "running", at: 1_200 }),
      finishedFact({ finish: "aborted" }),
    ]);
    expectRejected(Transcript.fold(state, appendedFact(buildTextPart())), "already_finished");
    expectRejected(
      Transcript.fold(
        state,
        advancedFact("part-tool-1", { to: "completed", at: 2_100, output: "x" }),
      ),
      "already_finished",
    );
  });
});

describe("Transcript fold — immutability and determinism", () => {
  test("the input state is deep-unchanged by applied folds", () => {
    const state = applyAll([
      createdFact(),
      appendedFact(buildTextPart()),
      appendedFact(buildToolPart()),
      advancedFact("part-tool-1", { to: "running", at: 1_200 }),
    ]);
    const snapshot = structuredClone(state);

    Transcript.fold(state, appendedFact(buildTextPart({ id: "part-text-2" })));
    Transcript.fold(
      state,
      advancedFact("part-tool-1", { to: "completed", at: 1_500, output: "x" }),
    );
    Transcript.fold(
      state,
      advancedFact("part-text-1", { to: "completed", at: 1_400, output: "hello" }),
    );
    Transcript.fold(state, finishedFact());

    expect(state).toEqual(snapshot);
  });
});

describe("Transcript schema", () => {
  test("negative and fractional usage counts are rejected", () => {
    const usage = buildUsage();
    for (const bad of [
      { ...usage, input: -1 },
      { ...usage, output: 1.5 },
      { ...usage, cache: { read: -2, write: 0 } },
    ]) {
      expect(Transcript.Usage.safeParse(bad).success).toBe(false);
    }
  });

  test("empty ids are rejected", () => {
    expect(Transcript.Fact.safeParse({ ...createdFact(), attemptId: "" }).success).toBe(false);
    expect(
      Transcript.Fact.safeParse({ ...appendedFact(buildTextPart()), messageId: "" }).success,
    ).toBe(false);
    expect(
      Transcript.Fact.safeParse({
        ...advancedFact("part-tool-1", { to: "running", at: 1_200 }),
        partId: "",
      }).success,
    ).toBe(false);
  });

  test("unknown finish reasons and transition kinds are rejected", () => {
    expect(Transcript.Fact.safeParse({ ...finishedFact(), finish: "overloaded" }).success).toBe(
      false,
    );
    expect(Transcript.PartTransition.safeParse({ to: "paused", at: 1_200 }).success).toBe(false);
  });
});
