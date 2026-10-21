import { expect, test } from "bun:test";
import { canonicalDigest, type SessionTransition } from "@oni/protocol";
import { Effect } from "effect";
import { rmSync } from "node:fs";
import { openCatalogStore } from "../../src/core/store/catalog";
import * as SessionHandleStore from "../../src/core/store/fence";
import { outboundOpen } from "../../src/core/session/outbound";
import { openSessionStore } from "../../src/core/store/session-file";
import type { SessionEntityPorts } from "../../src/core/session/runtime";
import {
  clusterTempDir,
  indexResident,
  materializeResident,
  runCluster,
  sendKick,
  sendPrompt,
  sessionFileFor,
  resolvedRunner,
} from "../helpers/cluster-runtime";
import { runAgent } from "../helpers/executor";

const sessionId = "entity-redrive";

async function seedPendingOutbound(home: ReturnType<typeof clusterTempDir>): Promise<void> {
  await runAgent(
    Effect.gen(function* () {
      const catalog = openCatalogStore(home.catalogFile, { now: Date.now });
      const store = openSessionStore(sessionFileFor(home.sessionsDir, sessionId), { now: Date.now });
      const kernel = SessionHandleStore.createSessionKernel(store, catalog);
      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* materializeResident(kernel, sessionId);
          indexResident(catalog, sessionId);
          yield* kernel.adoptFence({ sessionId, owner: "seed", fence: 1 });
          const message: SessionTransition.OutboundMessage = {
    messageId: "entity-redrive-message",
    sourceSessionId: sessionId,
    sourceActionId: `${sessionId}:materialize`,
    destinationSessionId: "receiver",
    requestId: "request",
    replyTo: "binding",
    terminal: "completed",
    content: "answer",
    digest: canonicalDigest({
      messageId: "entity-redrive-message",
      sourceSessionId: sessionId,
      sourceActionId: `${sessionId}:materialize`,
      destinationSessionId: "receiver",
      requestId: "request",
      replyTo: "binding",
      terminal: "completed",
      content: "answer",
    }),
          };
          yield* kernel.commit({
            sessionId,
            owner: "seed",
            fence: 1,
            now: Date.now(),
            expectedRevision: kernel.row(sessionId).revision,
            actions: [outboundOpen(message, Date.now())],
            state: "idle",
          });
        }),
        Effect.sync(() => {
          store.close();
          catalog.close();
        }),
      );
    }),
  );
}

test("real entity activation redrives pending outbound before its next turn", async () => {
  const home = clusterTempDir("entity-outbound-redrive-");
  try {
    await seedPendingOutbound(home);
    const dispatches: string[] = [];
    const options = {
      sessionsDir: home.sessionsDir,
      catalogFile: home.catalogFile,
      runner: resolvedRunner("turn result"),
      dispatchOutbound: ({ kernel, sessionId: id }: Parameters<NonNullable<SessionEntityPorts["dispatchOutbound"]>>[0]) =>
        Effect.sync(() => {
          dispatches.push(
            ...kernel
              .outboundRows(id)
              .filter((row) => row.state === "pending")
              .map((row) => row.message.messageId),
          );
        }),
    };
    await runCluster(
      options,
      Effect.gen(function* () {
        yield* sendKick(sessionId);
        yield* sendPrompt(sessionId, "entity-redrive-prompt", "continue");
      }),
    );
    expect(dispatches).toEqual(["entity-redrive-message"]);
  } finally {
    rmSync(home.dir, { recursive: true, force: true });
  }
});
