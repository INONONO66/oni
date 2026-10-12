import { sessionTree } from "../../../../packages/agent/test/store/helpers/session-tree";
import { Effect, type Result } from "effect";
import { Core } from "@openomni/agent";
const defineTool = Core.defineTool;
const eraseTool = Core.eraseTool;
import type { AppSessionHandle } from "../../src";
import type { AnyToolDefinition, LedgerAction } from "@openomni/protocol";
type AdoptReceipt = Core.AdoptReceipt;
type LedgerError = Core.LedgerError;
import { z } from "zod";
import { eventSignal } from "./event-signal";
import { runEffect, runSyncResult } from "./effect";
import type { AppLedgerPlane } from "../../src/composition/cluster-runtime";

export function waveTool(
  name: string,
  execute: (signal: AbortSignal) => Promise<string>,
  sequential?: true,
): AnyToolDefinition {
  return eraseTool(
    defineTool({
      name,
      description: `test ${name}`,
      category: "query",
      visibility: { model: ["resident"], cell: [] },
      input: z.object({ slot: z.literal(name) }),
      output: z.string(),
      ...(sequential ? { sequential } : {}),
      execute: (_input, context) => execute(context.signal),
      render: (_input, result) => result,
    }),
  );
}

export function trackedWaveTools(started: string[]) {
  return ["A", "B", "C"].map((name) =>
    waveTool(name, async () => {
      started.push(name);
      return name;
    }),
  );
}

export const ProviderRequest = z.object({
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.union([
        z.string(),
        z.array(
          z.object({
            type: z.string(),
            tool_use_id: z.string().optional(),
            content: z.string().optional(),
          }),
        ),
      ]),
    }),
  ),
});

export function bounded<T>(promise: Promise<T>): Promise<T> {
  const signal = eventSignal<T>("wave/recovery event");
  void promise.then(signal.resolve, signal.reject);
  return signal.promise;
}

/**
 * Interrupt the live turn while its SECOND model call is parked at the fake
 * provider (#1346): the facade's interrupt rides the entity's asynchronous
 * `Deliver` door, so the provider holds its response until the interrupt has
 * landed and the turn's own boundary drain consumed it. Exact-state gating,
 * never a timing sleep.
 */
export function interruptDuringSecondModel(currentHandle: () => AppSessionHandle | undefined): {
  readonly interrupted: Promise<void>;
  readonly hold: (request: number) => Promise<void>;
} {
  const interrupted = Promise.withResolvers<void>();
  return {
    interrupted: interrupted.promise,
    hold: async (request) => {
      if (request !== 2) return;
      const handle = currentHandle();
      if (handle === undefined) {
        interrupted.reject(new Error("missing live SDK handle"));
        return;
      }
      await runEffect(handle.interrupt()).then(interrupted.resolve, interrupted.reject);
    },
  };
}

/**
 * A contender's fence-adoption attempt at an explicit fence value (W5.2):
 * adopting at or below the current fence refuses as stale, adopting above
 * it steals authority. The lease plane's held/expiry states are gone.
 */
export function adoptAtFence(
  plane: AppLedgerPlane,
  sessionId: string,
  owner: string,
  fence: number,
): Result.Result<AdoptReceipt, LedgerError> {
  return runSyncResult(plane.openKernel(sessionId).adoptFence({ sessionId, owner, fence }));
}

/**
 * One received-message chain action under the live activation's borrowed
 * owner+fence (W5.2): the durable cross-process arrival, minus the entity
 * mailbox — a second RPC would serialize behind the running turn's own
 * delivery, while the running turn's boundary drain reads the chain directly.
 */
function commitReceived(
  plane: AppLedgerPlane,
  sessionId: string,
  kind: "prompt" | "interrupt",
  id: string,
  content: string,
): Effect.Effect<void, Error> {
  return Effect.suspend(() => {
    const kernel = plane.openKernel(sessionId);
    const row = kernel.row(sessionId);
    if (row.fenceOwner === null)
      return Effect.fail(new Error(`session has no activation authority: ${sessionId}`));
    const action: LedgerAction.Append = {
      id,
      parentId: kernel.latestAction(sessionId)?.id ?? null,
      sessionId,
      kind: "prompt",
      intent: { encodingVersion: 1, value: { kind: "sdk" } },
      effect: { encodingVersion: 1, value: { deliveryKind: kind, content } },
      irreversible: true,
      ts: Date.now(),
    };
    return kernel
      .commit({
        sessionId,
        owner: row.fenceOwner,
        fence: row.fence,
        now: Date.now(),
        expectedRevision: row.revision,
        actions: [action],
        state: row.state,
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError((error) => new Error(`delivery commit refused: ${error._tag}`)),
      );
  });
}

export function commitInterrupt(plane: AppLedgerPlane, sessionId: string, id: string) {
  return runEffect(commitReceived(plane, sessionId, "interrupt", id, ""));
}

export function commitPrompt(plane: AppLedgerPlane, sessionId: string, id: string, content: string) {
  return runEffect(commitReceived(plane, sessionId, "prompt", id, content));
}

export function interruptDeliveries(plane: AppLedgerPlane, sessionId: string) {
  return sessionTree(sessionId, plane.sessionStore(sessionId).actions).flatMap((action) => {
    const delivery = Core.SessionHandleStore.delivery(action);
    return delivery?.kind === "interrupt" ? [delivery] : [];
  });
}
