/**
 * #1348: per-test fixture for the #1256 hook-process suites. Each acquisition
 * spawns a REAL scripted child (`bun -e`) in a fresh Scope and closes it on
 * every exit — a failing body still kills its child, and no PID leaks into
 * the next test.
 */
import { Effect, Exit, Scope } from "effect";
import {
  acquireHookProcess,
  type HookOutcome,
  type HookProcess,
  type HookProcessConfig,
} from "../../src/plugins/hook";

/** The scripted echo child: behavior is keyed by the request's `event` field. */
export const HOOK_CHILD_SCRIPT = `
const held = [];
const heldResult = (event) =>
  event === "hold-rewrite" ? { type: "rewrite", fields: { input: { redacted: true } } }
  : event === "hold-observe" ? { type: "observe", payload: { note: "late" } }
  : { type: "gate", verdict: "allow" };
const flushHeld = () => {
  for (const entry of held.splice(0)) console.log(JSON.stringify({ id: entry.id, result: heldResult(entry.event) }));
};
process.on("SIGUSR2", flushHeld);
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let cut;
  while ((cut = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 1);
    if (line.length === 0) continue;
    const request = JSON.parse(line);
    const reply = (result) => console.log(JSON.stringify({ id: request.id, result }));
    switch (request.event) {
      case "allow": reply({ type: "gate", verdict: "allow" }); break;
      case "deny": reply({ type: "gate", verdict: "deny", reason: "secret" }); break;
      case "rewrite": reply({ type: "rewrite", fields: { input: { redacted: true } } }); break;
      case "observe": reply({ type: "observe", payload: { note: "seen" } }); break;
      case "garbage": console.log("not a json line"); break;
      case "bad-verdict": reply({ type: "gate", verdict: "maybe" }); break;
      case "hold":
      case "hold-rewrite":
      case "hold-observe": held.push({ id: request.id, event: request.event }); break;
      case "die": process.exit(7);
      case "silent": break;
      case "oversize": reply({ type: "gate", verdict: "allow", reason: "r".repeat(4096) }); break;
      case "unterminated": process.stdout.write("y".repeat(4096)); break;
      case "flush-held": flushHeld(); reply({ type: "gate", verdict: "allow" }); break;
    }
  }
}
`;

export const HOOK_COMMAND = [process.execPath, "-e", HOOK_CHILD_SCRIPT] as const;

export type HookRequest = Parameters<HookProcess["call"]>[0];

/** One `tool.pre` request for the scripted child; the timeout is per call (#1256 r3 M-2). */
export function hookRequest(event: string, id = event, timeoutMs = 60_000): HookRequest {
  return { id, point: "tool.pre", event, decisionInput: { op: "bash" }, timeoutMs };
}

/** The typed failure the process service settles a call with. */
export function hookFailure(cause: "framing" | "exit" | "timeout"): HookOutcome {
  return { kind: "failure", code: "hook_timeout", cause };
}

/** Run `body` under a fresh Scope closed on every exit (success, failure, or interrupt). */
export const hookScoped = <A, E, R>(body: (scope: Scope.Scope) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    return yield* body(scope).pipe(Effect.onExit(() => Scope.close(scope, Exit.void)));
  });

/**
 * Fork a call so it runs synchronously to its first suspension: the pending
 * entry is registered and any TestClock timer armed when the fork returns —
 * the exact-state guarantee the deleted polling loops approximated.
 */
export const forkStarted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.forkChild(effect, { startImmediately: true });

/**
 * Acquire one scripted child in a fresh Scope and hand it to `body`; the
 * Scope closes — killing the child — on every exit of `body`.
 */
export function withHookProcess<A, E, R>(
  body: (hook: HookProcess) => Effect.Effect<A, E, R>,
  options: Partial<HookProcessConfig> = {},
) {
  return hookScoped((scope) =>
    Effect.gen(function* () {
      const hook = yield* acquireHookProcess({ ...options, command: options.command ?? HOOK_COMMAND }).pipe(
        Scope.provide(scope),
      );
      return yield* body(hook);
    }),
  );
}

/**
 * The poisoned-PID contract (r4 M-1): the child is dead, its exit settles
 * without new input, and a later call CANNOT obtain allow — it settles as the
 * exit failure with nothing left in flight.
 */
export function expectPoisoned(hook: HookProcess) {
  return Effect.gen(function* () {
    yield* hook.exited;
    const later = yield* hook.call(hookRequest("allow"));
    return { later, inFlight: hook.inFlight() };
  });
}
