import { expect, test } from "bun:test";
import { Effect, Exit, Fiber, Scope } from "effect";
import { TestClock } from "effect/testing";
import {
  acquireHookProcess,
  HOOK_PROCESS_REF,
  HookSpawnError,
  hookCapability,
  hookProcessConsultant,
  type HookLateResult,
  type HookOutcome,
} from "../src/plugins/hook";
import { canonicalDigest, type PlainValue } from "@openomni/protocol";
import {
  expectPoisoned,
  forkStarted,
  HOOK_COMMAND as COMMAND,
  hookFailure,
  hookRequest as request,
  hookScoped as scoped,
  withHookProcess,
} from "./helpers/hook-fixture";
import { runTestPromise } from "./helpers/isolated";

/**
 * Hook capability: the scoped JSON-lines process service. Every case
 * runs a REAL scripted child (bun -e) and synchronizes on stdout replies,
 * exit settlement or the TestClock — never on a fixed sleep.
 */

test("the capability declares exactly one handler and no kind, point, input or tool", () => {
  const capability = hookCapability();
  expect(capability.name).toBe("hook");
  expect(capability.requires).toEqual(["action"]);
  expect(Object.keys(capability.handlers)).toEqual([HOOK_PROCESS_REF]);
  expect(Object.keys(capability.kinds)).toEqual([]);
  expect(capability.points).toEqual([]);
  expect(capability.inputs).toEqual([]);
});

test("allow, deny, rewrite and observe results round-trip over JSON lines", () =>
  runTestPromise(
    withHookProcess((hook) =>
      Effect.gen(function* () {
        expect(yield* hook.call(request("allow"))).toEqual({ kind: "gate", verdict: "allow" });
        expect(yield* hook.call(request("deny"))).toEqual({
          kind: "gate",
          verdict: "deny",
          reason: "secret",
        });
        expect(yield* hook.call(request("rewrite"))).toEqual({
          kind: "rewrite",
          fields: { input: { redacted: true } },
        });
        expect(yield* hook.call(request("observe"))).toEqual({
          kind: "observe",
          payload: { note: "seen" },
        });
        expect(hook.inFlight()).toBe(0);
      }),
    ),
  ));

/**
 * M-1 (r4): malformed framing POISONS the PID — the garbage cannot be
 * attributed to a request, so the child dies and no later call on that PID
 * can ever obtain allow. Each malformed shape gets its own acquisition.
 */
const poisonedByFraming = (event: string) =>
  runTestPromise(
    withHookProcess((hook) =>
      Effect.gen(function* () {
        expect(yield* hook.call(request(event))).toEqual(hookFailure("framing"));
        // The poison killed the child; a subsequent call CANNOT obtain allow.
        expect(yield* expectPoisoned(hook)).toEqual({ later: hookFailure("exit"), inFlight: 0 });
      }),
    ),
  );

test("a non-JSON line poisons the PID: framing failure, dead child, no later allow", () =>
  poisonedByFraming("garbage"));

test("a verdict outside the vocabulary poisons the PID the same way", () =>
  poisonedByFraming("bad-verdict"));

test("the process dying during a call settles the call as an exit failure", () =>
  runTestPromise(
    withHookProcess((hook) =>
      Effect.gen(function* () {
        expect(yield* hook.call(request("die"))).toEqual(hookFailure("exit"));
        expect(yield* hook.exited).toBe(7);
        // A dead PID refuses further calls without hanging.
        expect(yield* hook.call(request("allow"))).toEqual(hookFailure("exit"));
      }),
    ),
  ));

test("a nonresponsive script times out when the TestClock passes timeoutMs", () =>
  runTestPromise(
    withHookProcess((hook) =>
      Effect.gen(function* () {
        const call = yield* forkStarted(hook.call(request("silent", "silent", 5_000)));
        expect(hook.inFlight()).toBe(1);
        yield* TestClock.adjust(5_001);
        expect(yield* Fiber.join(call)).toEqual(hookFailure("timeout"));
        expect(hook.inFlight()).toBe(0);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  ));

test("rotation: one PID per generation and the old PID dies only after its last in-flight call", () =>
  runTestPromise(
    Effect.gen(function* () {
      const oldScope = yield* Scope.make();
      const oldHook = yield* acquireHookProcess({ command: COMMAND }).pipe(
        Scope.provide(oldScope),
      );
      // A full round-trip proves the child is up with its signal handler bound.
      expect(yield* oldHook.call(request("allow"))).toEqual({ kind: "gate", verdict: "allow" });
      // One turn is mid-call against the generation it captured.
      const inFlightCall = yield* forkStarted(oldHook.call(request("hold")));
      expect(oldHook.inFlight()).toBe(1);
      // M-1 (r3): `inFlight` only proves the parent wrote the request. The
      // child reads stdin in order, so a completed ack round-trip PROVES it
      // consumed the "hold" line before any SIGUSR2 can arrive.
      expect(yield* oldHook.call(request("allow", "hold-ack"))).toEqual({
        kind: "gate",
        verdict: "allow",
      });
      // The manifest changes: a NEW generation composes with its own PID while
      // the old Scope's close parks on the in-flight call.
      const closing = yield* Effect.forkChild(Scope.close(oldScope, Exit.void));
      const result = yield* scoped((scope) =>
        Effect.gen(function* () {
          const newHook = yield* acquireHookProcess({ command: COMMAND }).pipe(
            Scope.provide(scope),
          );
          expect(newHook.pid).not.toBe(oldHook.pid);
          // Release the held reply: the old turn finishes on its captured PID.
          process.kill(oldHook.pid, "SIGUSR2");
          const outcome: HookOutcome = yield* Fiber.join(inFlightCall);
          yield* Fiber.join(closing);
          // The old PID is dead only AFTER the call settled with a real verdict.
          yield* oldHook.exited;
          expect(outcome).toEqual({ kind: "gate", verdict: "allow" });
          return yield* newHook.call(request("allow"));
        }),
      );
      // The new generation's PID kept serving throughout the rotation.
      expect(result).toEqual({ kind: "gate", verdict: "allow" });
    }),
  ));

test("a missing executable is a typed spawn refusal, never a partial activation", () =>
  runTestPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const error = yield* acquireHookProcess({
          command: ["/nonexistent-hook-executable-1256"],
        }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(HookSpawnError);
        expect(error.command).toEqual(["/nonexistent-hook-executable-1256"]);
      }),
    ),
  ));

test("H-2: a response line over maxLineBytes poisons the PID as a framing failure", () =>
  runTestPromise(
    withHookProcess(
      (hook) =>
        Effect.gen(function* () {
          expect(yield* hook.call(request("oversize"))).toEqual(hookFailure("framing"));
          // The poisoned PID was killed and refuses further calls without hanging.
          expect(yield* expectPoisoned(hook)).toEqual({ later: hookFailure("exit"), inFlight: 0 });
        }),
      { maxLineBytes: 1024 },
    ),
  ));

test("H-2: an unterminated buffer over maxLineBytes poisons the PID as a framing failure", () =>
  runTestPromise(
    withHookProcess(
      (hook) =>
        Effect.gen(function* () {
          // The child floods 4096 bytes with NO newline: the buffer bound trips
          // without ever completing a line, and the pending call settles framing.
          expect(yield* hook.call(request("unterminated"))).toEqual(hookFailure("framing"));
          yield* hook.exited;
        }),
      { maxLineBytes: 1024 },
    ),
  ));

test("M-1: one JSON line split at a chosen byte across two reader chunks decodes once complete", () =>
  runTestPromise(
    scoped((scope) =>
      Effect.gen(function* () {
        // M-1 (r3): separate child stdout WRITES do not guarantee separate
        // reader chunks. The injected-child seam controls the exact chunk
        // boundary instead: the first chunk carries bytes [0,6) of the "split"
        // response line, the second the remainder plus the "flush" line.
        const encoder = new TextEncoder();
        const splitLine = `${JSON.stringify({ id: "split", result: { type: "gate", verdict: "allow" } })}\n`;
        const flushLine = `${JSON.stringify({ id: "flush", result: { type: "gate", verdict: "allow" } })}\n`;
        const chunks: ((chunk: Uint8Array | null) => void)[] = [];
        const queued: (Uint8Array | null)[] = [];
        const push = (chunk: Uint8Array | null): void => {
          const waiter = chunks.shift();
          if (waiter === undefined) queued.push(chunk);
          else waiter(chunk);
        };
        let exited!: (code: number) => void;
        const child = {
          pid: 4100,
          stdout: (async function* (): AsyncGenerator<Uint8Array> {
            for (;;) {
              const next =
                queued.shift() ??
                (await new Promise<Uint8Array | null>((resolve) => chunks.push(resolve)));
              if (next === null) return;
              yield next;
            }
          })(),
          stdin: {
            write(data: string): void {
              const parsed = JSON.parse(data) as { id: string };
              if (parsed.id === "split") push(encoder.encode(splitLine.slice(0, 6)));
              if (parsed.id === "flush") {
                push(encoder.encode(splitLine.slice(6)));
                push(encoder.encode(flushLine));
              }
            },
            flush: (): undefined => undefined,
          },
          kill: () => {
            push(null);
            exited(0);
          },
          exited: new Promise<number>((resolve) => {
            exited = resolve;
          }),
        };
        const hook = yield* acquireHookProcess({ command: ["./hook.sh"] }, () => child).pipe(
          Scope.provide(scope),
        );
        const splitCall = yield* forkStarted(hook.call(request("split", "split")));
        expect(hook.inFlight()).toBe(1);
        expect(yield* hook.call(request("flush", "flush"))).toEqual({
          kind: "gate",
          verdict: "allow",
        });
        expect(yield* Fiber.join(splitCall)).toEqual({ kind: "gate", verdict: "allow" });
        expect(hook.inFlight()).toBe(0);
      }),
    ),
  ));

test("H-3: a result settling after its timeout surfaces through the typed onLate port, never dropped", () =>
  runTestPromise(
    scoped((scope) =>
      Effect.gen(function* () {
        let resolveLate!: (late: HookLateResult) => void;
        const arrived = new Promise<HookLateResult>((resolve) => {
          resolveLate = resolve;
        });
        const hook = yield* acquireHookProcess({
          command: COMMAND,
          onLate: (late) => resolveLate(late),
        }).pipe(Scope.provide(scope));
        const call = yield* forkStarted(hook.call(request("hold", "late-1", 5_000)));
        expect(hook.inFlight()).toBe(1);
        yield* TestClock.adjust(5_001);
        // The call itself settled as the one timeout failure the gate folds to deny.
        expect(yield* Fiber.join(call)).toEqual(hookFailure("timeout"));
        // The child answers AFTER the deadline (stdin is processed in order, so
        // "flush-held" strictly follows "hold"): the decoded result re-surfaces
        // through onLate with its original call id.
        const flush = yield* Effect.forkChild(hook.call(request("flush-held")));
        expect(yield* Effect.promise(() => arrived)).toEqual({
          id: "late-1",
          outcome: { kind: "gate", verdict: "allow" },
        });
        expect(yield* Fiber.join(flush)).toEqual({ kind: "gate", verdict: "allow" });
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  ));

test("H-3: the consultant routes a late result to seed.late with its CALL-time after cursor", () =>
  runTestPromise(
    scoped((scope) =>
      Effect.gen(function* () {
        let resolveLate!: (payload: PlainValue) => void;
        const arrived = new Promise<PlainValue>((resolve) => {
          resolveLate = resolve;
        });
        // The deadline rides the TestClock (M-1 r3): the "hold" child NEVER
        // answers until told to flush, and the clock advances only below.
        const params = { event: "hold", command: [...COMMAND], timeoutMs: 250 };
        const rowId = "hooks-json/tool.pre#1";
        let ordinal = 41;
        const consult = yield* hookProcessConsultant({
          name: HOOK_PROCESS_REF,
          rows: [{ id: rowId, on: "tool.pre", when: {}, do: "gate", how: { ref: HOOK_PROCESS_REF, params }, order: 0 }],
          late: (payload) => resolveLate(payload),
          cursor: () => ordinal,
        }).pipe(Scope.provide(scope));
        // The fork runs to the call's suspension, arming its TestClock timer;
        // one adjust fires it and the joined fiber IS the settlement.
        const timedOutFiber = yield* forkStarted(
          consult({ rowId, point: "tool.pre", params, value: { op: "bash" } }),
        );
        yield* TestClock.adjust(251);
        const timedOut = yield* Fiber.join(timedOutFiber);
        expect(timedOut).toEqual({
          verdict: "deny",
          payload: {
            ref: HOOK_PROCESS_REF,
            verdict: "deny",
            reason: "bundle_failure",
            code: "hook_timeout",
            cause: "timeout",
          },
        });
        // The journal moved on; the late payload must carry the CALL-time cursor.
        ordinal = 99;
        const flushed = yield* consult({ rowId, point: "tool.pre", params: { ...params, event: "flush-held" }, value: { op: "bash" } });
        // The flush call settles on the child's REAL reply; no clock advance.
        expect(flushed).toEqual({
          verdict: "allow",
          payload: { ref: HOOK_PROCESS_REF, verdict: "allow" },
        });
        expect(yield* Effect.promise(() => arrived)).toEqual({
          hook: HOOK_PROCESS_REF,
          id: `${rowId}#1`,
          result: { type: "gate", verdict: "allow" },
          after: 41,
        });
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  ));

test("G-5: a rewrite answer on a consulted row folds to a prepared value with its output digest", () =>
  runTestPromise(
    scoped((scope) =>
      Effect.gen(function* () {
        const params = { event: "rewrite", command: [...COMMAND], timeoutMs: 60_000 };
        const rowId = "hooks-json/tool.pre#1";
        const consult = yield* hookProcessConsultant({
          name: HOOK_PROCESS_REF,
          rows: [{ id: rowId, on: "tool.pre", when: {}, do: "rewrite", how: { ref: HOOK_PROCESS_REF, params }, order: 0 }],
        }).pipe(Scope.provide(scope));
        const result = yield* consult({ rowId, point: "tool.pre", params, value: { op: "bash" } });
        expect(result).toEqual({
          value: { input: { redacted: true } },
          payload: { ref: HOOK_PROCESS_REF, output: canonicalDigest({ input: { redacted: true } }) },
        });
      }),
    ),
  ));

test("G-5: late rewrite and observe results route through seed.late as typed payloads", () =>
  runTestPromise(
    scoped((scope) =>
      Effect.gen(function* () {
        const late: PlainValue[] = [];
        let resolveBoth!: () => void;
        const both = new Promise<void>((resolve) => {
          resolveBoth = resolve;
        });
        const params = { event: "hold-rewrite", command: [...COMMAND], timeoutMs: 250 };
        const rowId = "hooks-json/tool.pre#1";
        const consult = yield* hookProcessConsultant({
          name: HOOK_PROCESS_REF,
          rows: [{ id: rowId, on: "tool.pre", when: {}, do: "gate", how: { ref: HOOK_PROCESS_REF, params }, order: 0 }],
          late: (payload) => {
            late.push(payload);
            if (late.length === 2) resolveBoth();
          },
          cursor: () => 7,
        }).pipe(Scope.provide(scope));
        const timeOut = (event: string) =>
          Effect.gen(function* () {
            // Fork to the timer's suspension, fire it, await the settlement.
            const fiber = yield* forkStarted(
              consult({ rowId, point: "tool.pre", params: { ...params, event }, value: { op: "bash" } }),
            );
            yield* TestClock.adjust(251);
            return yield* Fiber.join(fiber);
          });
        expect(yield* timeOut("hold-rewrite")).toMatchObject({ verdict: "deny" });
        expect(yield* timeOut("hold-observe")).toMatchObject({ verdict: "deny" });
        const flushed = yield* consult({ rowId, point: "tool.pre", params: { ...params, event: "flush-held" }, value: { op: "bash" } });
        expect(flushed).toMatchObject({ verdict: "allow" });
        yield* Effect.promise(() => both);
        expect(late).toEqual([
          { hook: HOOK_PROCESS_REF, id: `${rowId}#1`, result: { type: "rewrite", fields: { input: { redacted: true } } }, after: 7 },
          { hook: HOOK_PROCESS_REF, id: `${rowId}#2`, result: { type: "observe", payload: { note: "late" } }, after: 7 },
        ]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  ));

test("G-5: the late window evicts the oldest timed-out call; an evicted late reply is dropped", () =>
  runTestPromise(
    scoped((scope) =>
      Effect.gen(function* () {
        const late: PlainValue[] = [];
        let resolveOne!: () => void;
        const one = new Promise<void>((resolve) => {
          resolveOne = resolve;
        });
        const params = { event: "hold", command: [...COMMAND], timeoutMs: 250 };
        const rowId = "hooks-json/tool.pre#1";
        const consult = yield* hookProcessConsultant({
          name: HOOK_PROCESS_REF,
          rows: [{ id: rowId, on: "tool.pre", when: {}, do: "gate", how: { ref: HOOK_PROCESS_REF, params }, order: 0 }],
          late: (payload) => {
            late.push(payload);
            resolveOne();
          },
          cursor: () => 7,
          lateWindow: 1,
        }).pipe(Scope.provide(scope));
        const timeOut = () =>
          Effect.gen(function* () {
            // Fork to the timer's suspension, fire it, await the settlement.
            const fiber = yield* forkStarted(
              consult({ rowId, point: "tool.pre", params, value: { op: "bash" } }),
            );
            yield* TestClock.adjust(251);
            return yield* Fiber.join(fiber);
          });
        expect(yield* timeOut()).toMatchObject({ verdict: "deny" });
        expect(yield* timeOut()).toMatchObject({ verdict: "deny" });
        // The flush emits BOTH held replies in order; only the remembered
        // SECOND id routes late — the first was evicted (window = 1).
        const flushed = yield* consult({ rowId, point: "tool.pre", params: { ...params, event: "flush-held" }, value: { op: "bash" } });
        expect(flushed).toMatchObject({ verdict: "allow" });
        yield* Effect.promise(() => one);
        expect(late).toEqual([
          { hook: HOOK_PROCESS_REF, id: `${rowId}#2`, result: { type: "gate", verdict: "allow" }, after: 7 },
        ]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  ));

test("C-1: a stdin write failure settles the call as a typed exit failure, nothing in flight", () =>
  runTestPromise(
    scoped((scope) =>
      Effect.gen(function* () {
        // Bun's FileSink swallows EPIPE, so the broken pipe is injected at the
        // one spawn seam: a live child whose stdin write throws.
        let exited!: (code: number) => void;
        const child = {
          pid: 4242,
          stdout: (async function* (): AsyncGenerator<Uint8Array> {
            await new Promise<void>(() => undefined);
          })(),
          stdin: {
            write(): never {
              throw new Error("EPIPE: broken pipe");
            },
            flush: (): undefined => undefined,
          },
          kill: () => exited(0),
          exited: new Promise<number>((resolve) => {
            exited = resolve;
          }),
        };
        const hook = yield* acquireHookProcess(
          { command: ["./hook.sh"] },
          () => child,
        ).pipe(Scope.provide(scope));
        expect(yield* hook.call(request("allow"))).toEqual(hookFailure("exit"));
        expect(hook.inFlight()).toBe(0);
      }),
    ),
  ));

test("H-2 (r3): an interrupted in-flight call cleans up; generation disposal completes and kills the child", () =>
  runTestPromise(
    Effect.gen(function* () {
      // An injected SILENT child: it never answers and never ends its stdout,
      // so only the interrupt-cleanup path can release the drain finalizer.
      let killed = false;
      let exited!: (code: number) => void;
      const child = {
        pid: 777,
        stdout: (async function* (): AsyncGenerator<Uint8Array> {
          await new Promise<void>(() => undefined);
        })(),
        stdin: { write: (): undefined => undefined, flush: (): undefined => undefined },
        kill: () => {
          killed = true;
          exited(0);
        },
        exited: new Promise<number>((resolve) => {
          exited = resolve;
        }),
      };
      const scope = yield* Scope.make();
      const hook = yield* acquireHookProcess(
        { command: ["./hook.sh"] },
        () => child,
      ).pipe(Scope.provide(scope));
      const call = yield* forkStarted(hook.call(request("silent")));
      expect(hook.inFlight()).toBe(1);
      yield* Fiber.interrupt(call);
      // The interrupted call left NO pending entry behind.
      expect(hook.inFlight()).toBe(0);
      // Disposal parks on nothing: drain sees zero pending, the kill runs.
      yield* Scope.close(scope, Exit.void);
      expect(killed).toBe(true);
      expect(yield* hook.exited).toBe(0);
    }),
  ));

test("M-2: two rows with the same command and different timeouts share ONE PID; a per-call line bound fails only its call", () =>
  runTestPromise(
    scoped((scope) =>
      Effect.gen(function* () {
        // The REAL consultant seed: two rows, identical command, different
        // per-call timeouts. Pool identity is the command, so ONE child serves
        // both rows.
        const seen: string[] = [];
        const script = `
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
    console.log(JSON.stringify({ id: request.id, result: { type: "observe", payload: { pid: process.pid } } }));
  }
}
`;
        const command = [process.execPath, "-e", script];
        const fast = { event: "PreToolUse", command, timeoutMs: 1_000 };
        const slow = { event: "PreToolUse", command, timeoutMs: 30_000 };
        const consult = yield* hookProcessConsultant({
          name: HOOK_PROCESS_REF,
          rows: [
            { id: "hooks-json/tool.pre#1", on: "tool.pre", when: {}, do: "observe", how: { ref: HOOK_PROCESS_REF, params: fast }, order: 0 },
            { id: "hooks-json/tool.pre#2", on: "tool.pre", when: {}, do: "observe", how: { ref: HOOK_PROCESS_REF, params: slow }, order: 1 },
          ],
        }).pipe(Scope.provide(scope));
        const first = yield* consult({ rowId: "hooks-json/tool.pre#1", point: "tool.pre", params: fast, value: { op: "bash" } });
        const second = yield* consult({ rowId: "hooks-json/tool.pre#2", point: "tool.pre", params: slow, value: { op: "bash" } });
        const pidOf = (result: typeof first): number => {
          const payload = result.payload;
          if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("missing payload");
          const pid = payload.pid;
          if (typeof pid !== "number") throw new Error("missing pid");
          seen.push(String(pid));
          return pid;
        };
        // Both rows answered from the SAME child process.
        expect(pidOf(first)).toBe(pidOf(second));
        expect(seen).toHaveLength(2);
        // A per-call maxLineBytes smaller than the response fails ONLY that
        // call as framing; the shared PID stays healthy for the next row.
        const bounded = { ...fast, maxLineBytes: 8 };
        expect(yield* consult({ rowId: "hooks-json/tool.pre#1", point: "tool.pre", params: bounded, value: { op: "bash" } })).toEqual({
          verdict: "deny",
          payload: {
            ref: HOOK_PROCESS_REF,
            verdict: "deny",
            reason: "bundle_failure",
            code: "hook_timeout",
            cause: "framing",
          },
        });
        expect(pidOf(yield* consult({ rowId: "hooks-json/tool.pre#2", point: "tool.pre", params: slow, value: { op: "bash" } }))).toBe(
          pidOf(first),
        );
      }),
    ),
  ));
