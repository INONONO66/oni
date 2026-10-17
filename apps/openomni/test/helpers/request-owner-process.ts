import { sessionTree } from "../../../../packages/agent/test/store/helpers/session-tree";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { Bus } from "./bus";
import { L0Observation, type PlainValue, type Tool } from "@openomni/protocol";
import { z } from "zod";
import { appFixture } from "./app-fixture";
import type { AppLedgerPlane } from "../../src/composition/cluster-runtime";
import { planeOf } from "./ledger";
import { assistantMessage, requestToolStep } from "./assistant-message";
import { testMachinesPlane } from "./self-machine";

export const OWNER_TOKEN = "request-owner-e2e-token";
export const PERSON = {
  id: "person:request-owner-e2e",
  displayName: "Original protected manifest",
  kind: "human",
  trustTier: "manager",
  endpoints: [{ channel: "ws", externalId: "protected-person" }],
} as const;
export const ORIGINAL_CALL = {
  id: "original-person-declare",
  tool: "provision",
  input: {
    operation: {
      op: "contact_add",
      args: { manifest: { ...PERSON, endpoints: [...PERSON.endpoints] } },
    },
  },
} satisfies Tool.Call;

function snapshot(plane: AppLedgerPlane, catalogPath: string, modelCalls: number) {
  const db = new Database(catalogPath, { readonly: true });
  try {
    return {
      pid: process.pid,
      modelCalls,
      person: plane.stores.persons.get(PERSON.id) ?? null,
      requests: plane.listSessions().flatMap((row) => plane.openKernel(row.id).requestRows(row.id)),
      sessions: plane.listSessions().map((row) => ({
        row,
        actions: sessionTree(row.id, plane.sessionStore(row.id).actions),
        generation: plane.openKernel(row.id).latestGenerationFor(row.id),
        delivery: plane.openKernel(row.id).pendingMessages(row.id),
      })),
      tables: z
        .array(z.object({ name: z.string() }))
        .parse(db.query("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all())
        .map((row) => row.name),
    };
  } finally {
    db.close();
  }
}

export type OwnerSnapshot = ReturnType<typeof snapshot>;
export type OwnerProcessEvent =
  | { type: "ready"; port: number; snapshot: OwnerSnapshot }
  | { type: "opened"; snapshot: OwnerSnapshot }
  | { type: "model"; snapshot: OwnerSnapshot }
  | { type: "applied"; snapshot: OwnerSnapshot }
  | { type: "settled"; snapshot: OwnerSnapshot }
  | { type: "snapshot"; id: string; snapshot: OwnerSnapshot }
  | { type: "error"; error: string };

const Command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), id: z.string() }),
  z.object({ type: z.literal("drift"), id: z.string() }),
  z.object({ type: z.literal("stop") }),
]);

async function serve() {
  const catalogPath = z.string().min(1).parse(process.argv[2]);
  const sessionsDir = z.string().min(1).parse(process.argv[3]);
  const at = z.coerce.number().int().positive().parse(process.argv[4]);
  const recovering = process.argv[5] === "recover";
  let modelCalls = 0;
  let app: Awaited<ReturnType<typeof appFixture>> | undefined;
  let plane: AppLedgerPlane | undefined;
  const emit = (event: OwnerProcessEvent) => process.send?.(event);
  const state = () => {
    if (plane === undefined) throw new Error("app plane not resolved yet");
    return snapshot(plane, catalogPath, modelCalls);
  };
  const failure = (error: Error | string) =>
    emit({
      type: "error",
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  let opened = false;
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (plane === undefined) return;
    const action = sessionTree(event.sessionId, plane.sessionStore(event.sessionId).actions).find((item) => item.id === event.id);
    const request = plane.openKernel(event.sessionId).requestRows(event.sessionId).find(
      (item) => item.callId === ORIGINAL_CALL.id && item.state === "open",
    );
    if (
      !opened &&
      request !== undefined &&
      action?.id === `${request.requestId}:input:${request.requestId}:open`
    ) {
      opened = true;
      emit({ type: "opened", snapshot: state() });
    }
    const effect = action?.effect.value;
    if (effect === null || typeof effect !== "object" || Array.isArray(effect)) return;
    if (
      action?.kind === "tool" &&
      effect.phase === "result" &&
      effect.callId === ORIGINAL_CALL.id
    ) {
      emit({ type: "applied", snapshot: state() });
    }
    if (action?.kind === "turn" && effect.phase === "terminal") {
      emit({ type: "settled", snapshot: state() });
    }
  });
  process.on("message", (message: PlainValue) => {
    const command = Command.parse(message);
    if (command.type === "stop") {
      void (async () => {
        unsubscribe();
        await app?.stop();
        process.disconnect?.();
      })().catch(failure);
      return;
    }
    if (command.type === "drift") {
      if (plane === undefined) throw new Error("app plane not resolved yet");
      plane.stores.persons.put({
        ...PERSON,
        endpoints: [...PERSON.endpoints],
        trustTier: "observer",
        displayName: "Concurrent domain revision",
        revision: 0,
        createdBy: "fixture",
        updatedAt: at,
      });
    }
    emit({ type: "snapshot", id: command.id, snapshot: state() });
  });
  // No replacement definitions, mocked dispatcher, or regenerated captured generation:
  // every process builds the same real catalog through the production app root.
  app = await appFixture({
    config: {
      catalogPath,
      sessionsDir,
      host: "127.0.0.1",
      wsPort: 0,
      wsToken: OWNER_TOKEN,
      kek: { kind: "locked", reason: "no vault key in this fixture" },
      machines: testMachinesPlane(),
      model: { provider: "fake", id: "request-owner-e2e", apiKey: "fixture-key" },
    },
    sessionRuntime: {
      clock: () => at,
    },
    llm: {
      resolveModel: (model) => Effect.succeed({
        id: model.id,
        name: model.id,
        providerID: model.provider,
      }),
      run: (input, sink) => Effect.sync(() => {
        modelCalls += 1;
        emit({ type: "model", snapshot: state() });
        if (recovering) {
          const person = plane?.stores.persons.get(PERSON.id);
          if (person?.trustTier !== "manager" || person.revision !== 0) {
            throw new Error("LLM entered before original protected Person mutation");
          }
          sink.onMessage(assistantMessage(input, { text: "Recovered original invocation." }));
          return { type: "stop" };
        }
        const result = requestToolStep(input, sink, ORIGINAL_CALL);
        if (result !== undefined)
          throw new Error(`unexpected pre-crash tool result: ${result.content}`);
        return { type: "stop" };
      }),
    },
  });
  plane = await planeOf(app.runtime);
  emit({ type: "ready", port: app.port, snapshot: state() });
}

if (import.meta.main) {
  void serve().catch((error: Error | string) => {
    process.send?.({
      type: "error",
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    } satisfies OwnerProcessEvent);
    process.exitCode = 1;
  });
}
