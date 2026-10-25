import { canonicalJson, Tool } from "@oni/protocol";
import { Deferred, Effect, Option, type Scope } from "effect";
import { ToolTurnRefused } from "../journal/messages";
import { AgentFailure } from "../ports/failure";
import { interruptOn } from "../ports/ports";
import type { ActivationHandle } from "./entity-activation";
import { createEntityTurn, drain } from "./entity-delivery";
import type { ResolvedSessionRuntime, SessionEntityPorts, SessionToolExecution, SessionRunner } from "./runtime";
import { externalToolCall, externalToolOrigin, inboundAuthority, toolSourceOrigin } from "./turn-open";

function recordedExternalCall(handle: ActivationHandle, callId: string): boolean {
  let revision = 0;
  for (;;) {
    const page = handle.kernel.historyPage(handle.authority.sessionId, {
      afterRevision: revision, limit: 256,
    });
    if (page.actions.some((action) =>
      action.kind === "turn" &&
      externalToolCall(externalToolOrigin(handle.kernel, action.id)?.value ?? null)?.id === callId
    )) return true;
    if (page.nextRevision === null) return false;
    revision = page.nextRevision;
  }
}

/** Wait only for admission, never time out an already admitted side effect. */
export function executeExternalTool(
  handle: ActivationHandle,
  payload: { readonly sourceTurnId: string; readonly call: string; readonly waitMs: number },
): Effect.Effect<string, ToolTurnRefused> {
  return Effect.gen(function* () {
    const call = yield* Effect.try({
      try: () => Tool.Call.parse(JSON.parse(payload.call)),
      catch: () => new ToolTurnRefused({ code: "malformed" }),
    });
    if (!Number.isFinite(payload.waitMs) || payload.waitMs < 0 || payload.waitMs > 60_000)
      return yield* new ToolTurnRefused({ code: "malformed" });
    const recorded = recordedExternalCall(handle, call.id);
    const previous = handle.toolCalls.get(call.id);
    if (previous === null) {
      handle.toolCalls.delete(call.id);
      return yield* Effect.interrupt;
    }
    if (previous !== undefined) return yield* new ToolTurnRefused({ code: "busy" });
    if (recorded) return yield* new ToolTurnRefused({ code: "duplicate" });
    const active = { controller: new AbortController(), done: yield* Deferred.make<void>() };
    handle.toolCalls.set(call.id, active);
    return yield* admitExternalTool(handle, { ...payload, call }).pipe(
      Effect.raceFirst(interruptOn(active.controller.signal)),
      Effect.ensuring(Effect.sync(() => handle.toolCalls.delete(call.id)).pipe(
        Effect.andThen(Deferred.succeed(active.done, undefined)),
      )),
    );
  });
}

function admitExternalTool(
  handle: ActivationHandle,
  payload: { readonly sourceTurnId: string; readonly call: Tool.Call; readonly waitMs: number },
): Effect.Effect<string, ToolTurnRefused> {
  return Effect.gen(function* () {
    const run = handle.env.ports.runTool;
    if (run === undefined) return yield* new ToolTurnRefused({ code: "unavailable" });
    const origin = toolSourceOrigin(handle.kernel, handle.authority.sessionId, payload.sourceTurnId);
    if (origin === undefined || inboundAuthority(origin.value).authority !== "act")
      return yield* new ToolTurnRefused({ code: "origin" });
    const token = yield* Deferred.make<void>();
    const reserve: Effect.Effect<void, ToolTurnRefused> = Effect.suspend(() =>
      handle.gate.withPermits(1)(Effect.gen(function* () {
        if (handle.closing.current) return yield* new ToolTurnRefused({ code: "closed" });
        const active = handle.live.current;
        if (active !== undefined) return active;
        if (handle.kernel.row(handle.authority.sessionId).state !== "idle")
          return yield* new ToolTurnRefused({ code: "busy" });
        handle.live.current = token;
        return undefined;
      })).pipe(Effect.flatMap((active) =>
        active === undefined ? Effect.void : Deferred.await(active).pipe(Effect.andThen(reserve)),
      )),
    );
    return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const admitted = yield* restore(reserve.pipe(Effect.timeoutOption(payload.waitMs)));
      if (Option.isNone(admitted)) return yield* new ToolTurnRefused({ code: "busy" });
      return yield* restore(
        handle.keepAlive(true).pipe(Effect.andThen(run({
          authority: handle.authority, kernel: handle.kernel, call: payload.call, sourceTurnId: payload.sourceTurnId,
        })), Effect.map((result) => canonicalJson(Tool.Result.parse(result))), Effect.orDie),
      );
    })).pipe(Effect.ensuring(Effect.gen(function* () {
        if (handle.live.current !== token) return;
        handle.live.current = undefined;
        yield* Deferred.succeed(token, undefined);
        yield* handle.keepAlive(false);
        yield* drain(handle).pipe(Effect.orDie);
      })));
  });
}

/** Same captured generation, turn gate, dispatcher and seal as an ordinary session turn. */
export function createSessionEntityRunTool(
  execute: SessionToolExecution,
  runtime: ResolvedSessionRuntime,
  scope: Scope.Scope,
  wrap?: (runner: SessionRunner) => SessionRunner,
): NonNullable<SessionEntityPorts["runTool"]> {
  return ({ kernel, authority, call, sourceTurnId }) => Effect.gen(function* () {
    const origin = toolSourceOrigin(kernel, authority.sessionId, sourceTurnId);
    if (origin === undefined || inboundAuthority(origin.value).authority !== "act")
      return yield* new AgentFailure({ operation: "session.tool", cause: "origin" });
    let output: Tool.Result | undefined;
    const runner: SessionRunner = (input) => execute(input, call).pipe(
      Effect.map((result) => {
        output = result;
        return { kind: "result" as const, text: "" };
      }),
    );
    const { admission } = createEntityTurn(kernel, authority, wrap?.(runner) ?? runner, runtime, scope);
    const result = yield* admission.startTurn({ call, sourceTurnId, origin });
    return result?.kind === "result" && output !== undefined ? output : {
      id: call.id, toolCallId: call.id, toolName: call.tool, isError: true,
      content: result?.text ?? "tool turn did not execute",
    };
  });
}
