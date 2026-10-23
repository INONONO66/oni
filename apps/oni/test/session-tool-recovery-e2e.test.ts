import { APPROVAL_POLICY } from "../src/composition/policy";
import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { Effect } from "effect";
import { allowConfigure, generationServices } from "./helpers/generation-services";
import { composedHolder } from "./helpers/bundle-fixture";
import { testToolsBundle } from "./helpers/app-fixture";
import { observationService } from "../../../packages/agent/test/helpers/service-layers";
import { expect, test } from "bun:test";
import { acquireEffect, runEffect } from "./helpers/effect";
import { effectScope } from "./helpers/effect-scope";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bundle, Core, Testing } from "@oni/agent";
const closeSessions = Core.closeSessions;
const createSessionChatRunner = Core.createSessionChatRunner;
const createTurnDispatcher = Bundle.createTurnDispatcher;
const defineTool = Core.defineTool;
const eraseTool = Core.eraseTool;
const session = Testing.session;
const projectTools = Core.projectTools;
type SessionRuntime = Core.SessionRuntime;
import { Bus } from "./helpers/bus";
import { L0Observation, Tool } from "@oni/protocol";
import { z } from "zod";
import { seedKernelPolicyRows } from "../src/composition/policy";
import { sessionFilePath } from "../../../packages/agent/src/core/session/host";
import type { TestLedgerPlane as AppLedgerPlane } from "./helpers/ledger";
import { createAppLedger, drainSession, resolvedRuntimeFor } from "./helpers/ledger";

import { contentBlocks, messageStart, messageEnd, sseResponse } from "./helpers/anthropic-sse";
import { bounded, commitInterrupt, ProviderRequest as Request } from "./helpers/session-wave";
import { testClock } from "./helpers/test-entropy";

function response(names: readonly string[]): Response {
  const blocks =
    names.length > 0
      ? names.map((name) => ({
          start: { type: "tool_use", id: `call-${name}`, name, input: {} },
          delta: { type: "input_json_delta", partial_json: JSON.stringify({ slot: name }) },
        }))
      : [{ start: { type: "text", text: "" }, delta: { type: "text_delta", text: "finished" } }];
  const frames = [
    messageStart(crypto.randomUUID(), "claude-opus-4-5", 10),
    ...contentBlocks(blocks),
    ...messageEnd(names.length > 0 ? "tool_use" : "end_turn", 2),
  ];
  return sseResponse(frames);
}

// The second slot of a two-tool wave that never completed: a lost process is
// settled from evidence as outcome_unknown, never dressed up as a cancel.
const lostSlot = {
  "partial-wave": "Error: fiber_interrupted",
  "crash-window": "Error: B outcome unknown: the process was lost before a result was recorded",
  "after-wave": "Error: tool execution cancelled",
  "error-window": "Error: tool execution cancelled",
} as const;

for (const mode of ["after-wave", "partial-wave", "crash-window", "error-window"] as const) {
  test(`real SDK ${mode} preserves committed rendered tool slots without replay`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "937-tool-recovery-"));
    const catalogPath = join(directory, "catalog.sqlite");
    const sessionsDir = join(directory, "sessions");
    const crashCatalogPath = join(directory, "crash-catalog.sqlite");
    const crashSessionsDir = join(directory, "crash-sessions");
    mkdirSync(crashSessionsDir, { recursive: true });
    const sessionId = `tool-recovery-${mode}`;
    const names = mode === "partial-wave" || mode === "crash-window" ? ["A", "B"] : ["A"];
    const bodies: string[] = [];
    const requests: z.infer<typeof Request>[] = [];
    const enteredB = Promise.withResolvers<void>();
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push(Request.parse(await request.json()));
        return response(requests.length === 1 ? names : []);
      },
    });
    const planeRef: { current: AppLedgerPlane | undefined } = { current: undefined };
    const crashRef: { current: AppLedgerPlane | undefined } = { current: undefined };
    const saved = { current: false };
    const interruptDelivery = () => {
      const plane = planeRef.current;
      if (plane === undefined) throw new Error("plane missing at interrupt");
      void commitInterrupt(plane, sessionId, `interrupt-${mode}`);
    };
    const snapshot = (path: string, target: string) => {
      const source = new Database(path, { readonly: true });
      try {
        writeFileSync(target, source.serialize());
      } finally {
        source.close();
      }
    };
    const observations = observationService({
        publish(event, payload) {
          Bus.publish(event, payload);
          const plane = planeRef.current;
          if (
            mode === "crash-window" &&
            plane !== undefined &&
            event === L0Observation.ActionCommittedEvent &&
            !saved.current
          ) {
            const committed = L0Observation.ActionCommittedEvent.schema.parse(payload);
            const action = sessionTree(sessionId, plane.sessionStore(sessionId).actions).find(
              (node) => node.id === committed.id,
            );
            if (
              action?.kind === "tool" &&
              z
                .object({ terminal: z.literal("executed"), callId: z.literal("call-A") })
                .safeParse(action.effect.value).success
            ) {
              // Snapshot synchronously at commit, before the next native Effect result.
              // Bus subscriptions are observational microtasks, not commit barriers.
              snapshot(sessionFilePath(sessionsDir, sessionId), sessionFilePath(crashSessionsDir, sessionId));
              snapshot(catalogPath, crashCatalogPath);
              saved.current = true;
              interruptDelivery();
            }
          }
          if (mode === "error-window" && event === Tool.Events.Completed)
            throw new Error("crash after committed result");
        },
    });
    const plane = createAppLedger({ now: testClock(), catalogPath, sessionsDir, observationSink: observations });
    planeRef.current = plane;
    const runtime: SessionRuntime = {
      approvalPolicy: APPROVAL_POLICY,
      authorizeConfigure: allowConfigure,
      openKernel: plane.openKernel,
      listSessions: plane.listSessions,
    };
    const definitions = names.map((name) =>
      eraseTool(
        defineTool({
          name,
          description: `recover ${name}`,
          category: "query",
          visibility: { model: ["resident"], cell: [] },
          input: z.object({ slot: z.literal(name) }),
          output: z.object({ value: z.string() }),
          ...(name === "B" ? { sequential: true as const } : {}),
          async execute(_input, context) {
            bodies.push(name);
            if (mode === "partial-wave" && name === "B") {
              const aborted = new Promise<never>((_resolve, reject) => {
                context.signal.addEventListener(
                  "abort",
                  () => reject(new DOMException("cancelled", "AbortError")),
                  { once: true },
                );
              });
              enteredB.resolve();
              return aborted;
            }
            return { value: name };
          },
          render: (_input, output) => `ACTUAL_COMPLETED_RESULT:${output.value}`,
        }),
      ),
    );
    const runner = createSessionChatRunner({
      prepare(input) {
        return Effect.gen(function* () {
        const dispatcher = yield* createTurnDispatcher(input, runtime);
        return {
          traceContext: { traceId: "recovery", sessionId, runId: input.resultId },
          config: {
            executor: dispatcher.executor,
            defaultBudget: APPROVAL_POLICY.defaultBudget,
            tools: [...dispatcher.specs],
            toolWave: (calls, signal) =>
              dispatcher.executeWave(calls, { sessionId, turnId: input.turnId, signal }),
            model: { provider: "anthropic", id: "claude-opus-4-5" },
            auth: { type: "api", key: "recovery-key" },
            transport: { baseUrl: `http://127.0.0.1:${provider.port}/v1` },
          },
        };
        });
      },
    });
    const services = await acquireEffect(generationServices({ composed: composedHolder({ bundles: [testToolsBundle(definitions)] }), observations, plane }));
    let unsubscribe: () => void = () => undefined;
    const drainScope = effectScope();
    try {
      seedKernelPolicyRows(plane.updatePolicy);
      const handle = await acquireEffect(
        session(
          { id: sessionId, role: "resident", runner, tools: projectTools(definitions).session },
          runtime,
        ).pipe(Effect.provide(services)),
      );
      unsubscribe = Bus.subscribe(Tool.Events.Completed, (event) => {
        if (
          event.sessionId !== sessionId ||
          mode === "partial-wave" ||
          mode === "crash-window" ||
          mode === "error-window"
        )
          return;
        interruptDelivery();
      });
      const first = runEffect(handle.prompt("execute each slot once"));
      if (mode === "partial-wave") {
        await bounded(enteredB.promise);
        await bounded(runEffect(handle.interrupt()));
      }
      expect((await bounded(first))?.kind).toBe(mode === "error-window" ? "result" : "interrupted");
      unsubscribe();
      expect(requests).toHaveLength(mode === "error-window" ? 2 : 1);
      const treeOf = () => {
        const active = crashRef.current ?? plane;
        return sessionTree(sessionId, active.sessionStore(sessionId).actions);
      };
      let prefix = treeOf();
      if (mode === "crash-window") {
        expect(saved.current).toBe(true);
        await runEffect(closeSessions(runtime).pipe(Effect.provide(services)));
        const crashPlane = createAppLedger({ now: testClock(),
          catalogPath: crashCatalogPath,
          sessionsDir: crashSessionsDir,
        });
        crashRef.current = crashPlane;
        prefix = treeOf();
        expect(Core.SessionHandleStore.openTurns(prefix)).toHaveLength(1);
        expect(
          prefix.filter(
            (action) =>
              action.kind === "message" &&
              z.object({ terminal: z.literal("executed") }).safeParse(action.effect.value).success,
          ),
        ).toHaveLength(1);
        // The crashed activation's fence is still on the row; the recovery
        // drain adopts a higher fence and settles the open turn from evidence.
        expect(crashPlane.openKernel(sessionId).row(sessionId).fenceOwner).not.toBeNull();
        const crashRuntime: SessionRuntime = {
          approvalPolicy: APPROVAL_POLICY,
          authorizeConfigure: allowConfigure,
          openKernel: crashPlane.openKernel,
          listSessions: crashPlane.listSessions,
        };
        const recovered = await acquireEffect(
          generationServices({ composed: composedHolder({ bundles: [testToolsBundle(definitions)] }), plane: crashPlane }),
        );
        await bounded(
          drainScope.run(
            drainSession({
              plane: crashPlane,
              sessionId,
              runner,
              runtime: resolvedRuntimeFor(crashRuntime, recovered),
              scope: drainScope.scope,
            }).pipe(Effect.provide(recovered)),
          ),
        );
      } else if (mode !== "error-window") {
        await bounded(runEffect(handle.resume()));
      }
      expect(treeOf().slice(0, prefix.length)).toEqual(prefix);
      const results = requests[1]?.messages.flatMap((message) =>
        typeof message.content === "string"
          ? []
          : message.content.filter((part) => part.type === "tool_result"),
      );
      console.log("937 R1", JSON.stringify({ mode, bodies, results }));
      expect(results?.[0]).toMatchObject({
        tool_use_id: "call-A",
        content: "ACTUAL_COMPLETED_RESULT:A",
      });
      if (names.length === 2)
        expect(results?.[1]).toMatchObject({ tool_use_id: "call-B", content: lostSlot[mode] });
      expect(requests).toHaveLength(2);
      expect(bodies).toEqual(names);
    } finally {
      unsubscribe();
      await runEffect(closeSessions(runtime).pipe(Effect.provide(services)));
      await drainScope.close();
      crashRef.current?.close();
      plane.close();
      await provider.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
}
