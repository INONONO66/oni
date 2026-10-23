import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { Effect } from "effect";
import { expect, test } from "bun:test";
import { assertNoLegacyRequestStores } from "./helpers/storage-evidence";
import { Bus } from "./helpers/bus";
import { Core } from "@oni/agent";
import { L0Observation } from "@oni/protocol";
import { sessionFilePath } from "../src/composition/cluster-runtime";
import type { TestLedgerPlane as AppLedgerPlane } from "./helpers/ledger";
import { planeOf } from "./helpers/ledger";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { bounded } from "./helpers/protected-dispatch";
import { nextFrame } from "./helpers/ws";
import { declarePerson } from "./helpers/declared-channel";

const suite = residentSuite();

test("real external WebSocket reply wakes its original idle request owner without legacy writes", async () => {
  let sent = false;
  let received = 0;
  const waiting = Promise.withResolvers<string>();
  const completed = Promise.withResolvers<string>();
  const planeRef: { current: AppLedgerPlane | undefined } = { current: undefined };
  suite.defer(
    Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
      if (event.kind !== "turn" || planeRef.current === undefined) return;
      const terminal = Core.SessionHandleStore.turnTerminal(
        sessionTree(event.sessionId, planeRef.current.sessionStore(event.sessionId).actions).find(
          (action) => action.id === event.id,
        ),
      );
      if (terminal?.text === "WAITING_EXTERNAL_SENTINEL") waiting.resolve(event.sessionId);
      if (terminal?.text === "DONE_EXTERNAL_SENTINEL") completed.resolve(event.sessionId);
    }),
  );
  const config = suite.config("request-channel-", {
    wsToken: "token",
    socialBudgets: [
      { id: "peer-budget", targetActorId: "person:peer", maxPerWindow: 5, windowMs: 1000, cooldownMs: 0 },
    ],
  });
  // #1569 lane 8: Person rows with `reach`, never env actors.
  declarePerson(config.catalogPath, { id: "person:owner", displayName: "Owner", kind: "human", trustTier: "owner", endpoints: [{ channel: "ws", externalId: "owner" }], reach: true });
  declarePerson(config.catalogPath, { id: "person:peer", displayName: "Peer", kind: "ai_agent", trustTier: "assigned_worker", endpoints: [{ channel: "ws", externalId: "peer" }], reach: true });
  const app = await suite.boot({
    config,
    sessionRuntime: { clock: () => 100 },
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        if (!sent) {
          const result = requestToolStep(input, sink, {
            id: "external-request",
            tool: "send_message",
            input: {
              to: { kind: "contact", id: "person:peer" },
              message: "QUESTION_SENTINEL",
              deadline_ms: 900,
            },
          });
          if (result === undefined) return { type: "stop" };
          expect(result.isError).not.toBe(true);
          sent = true;
        }
        const hasAnswer = JSON.stringify(input.messages).includes("EXTERNAL_ANSWER_SENTINEL");
        if (hasAnswer) received += 1;
        sink.onMessage(
          assistantMessage(input, {
            text: hasAnswer ? "DONE_EXTERNAL_SENTINEL" : "WAITING_EXTERNAL_SENTINEL",
          }),
        );
        return { type: "stop" };
      }),
    },
  });
  planeRef.current = await planeOf(app.runtime);
  const plane = planeRef.current;
  const owner = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, [
    "auth",
    "token",
  ]);
  const peer = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=peer`, [
    "auth",
    "token",
  ]);
  const question = nextFrame(peer, (frame) => frame.type === "message");
  const admitted = nextFrame(owner, (frame) => frame.type === "receipt");
  owner.send(JSON.stringify({ text: "START_EXTERNAL_SENTINEL", eventId: "owner-input" }));
  const [delivery, source] = await Promise.all([question, bounded(waiting.promise), admitted]);
  expect(delivery.text).toBe("QUESTION_SENTINEL");
  expect(typeof delivery.messageId).toBe("string");
  expect(plane.openKernel(source).row(source).state).toBe("idle");
  const receipt = nextFrame(peer, (frame) => frame.type === "receipt" || frame.type === "error");
  peer.send(
    JSON.stringify({
      text: "EXTERNAL_ANSWER_SENTINEL",
      replyToId: delivery.messageId,
      eventId: "peer-answer",
    }),
  );
  expect(await receipt).toMatchObject({ type: "receipt", status: "accepted" });
  expect(await bounded(completed.promise)).toBe(source);
  expect(received).toBe(1);
  const request = plane.openKernel(source).requestRows(source)[0];
  expect(request?.state).toBe("resolved");
  expect(request?.replies).toHaveLength(1);
  expect(
    sessionTree(source, plane.sessionStore(source).actions).filter(
      (action) => action.kind === "prompt" && action.id === request?.replies[0]?.replyId,
    ),
  ).toHaveLength(1);
  const sessionsDir = config.sessionsDir;
  if (sessionsDir === undefined) throw new Error("suite config is missing sessionsDir");
  assertNoLegacyRequestStores(sessionFilePath(sessionsDir, source));
});
