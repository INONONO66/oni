import { Machine, type Ipc } from "@openomni/protocol";
import { Effect } from "effect";
import type { MachineError } from "./errors";
import { decodeMachineFailure } from "./failure";

/**
 * Host-side pty surface (#1273), kept out of host.ts so the attachment
 * rewrite (#1270) only ever meets one seam: a routed wire call on this
 * machine's live connection. host.ts owns connection lookup and transport
 * error mapping; this module owns schemas, byte codecs, and timeouts.
 */
type PtyWireMethod =
  | typeof Machine.WireMethod.PtyOpen
  | typeof Machine.WireMethod.PtyWrite
  | typeof Machine.WireMethod.PtyRead
  | typeof Machine.WireMethod.PtyResize
  | typeof Machine.WireMethod.PtyClose
  | typeof Machine.WireMethod.PtyList;
export type PtyWireCall = (
  method: PtyWireMethod,
  params: object,
  timeoutMs: number,
) => Effect.Effect<Ipc.Response["result"], MachineError>;

type PtyReadValue = Omit<Extract<Machine.PtyReadResult, { status: "ok" }>, "data"> & { readonly data: Uint8Array };
export interface PtyHandle {
  open(name: string, cwd: string): Effect.Effect<Machine.PtyOpenResult, MachineError>;
  write(name: string, data: Uint8Array): Effect.Effect<Machine.PtyWriteResult, MachineError>;
  read(
    name: string,
    options?: { readonly cursor?: string; readonly waitMs?: number },
  ): Effect.Effect<PtyReadValue | Exclude<Machine.PtyReadResult, { status: "ok" }>, MachineError>;
  resize(name: string, cols: number, rows: number): Effect.Effect<Machine.PtyResizeResult, MachineError>;
  close(name: string): Effect.Effect<Machine.PtyCloseResult, MachineError>;
  list(): Effect.Effect<Machine.PtyListResult, MachineError>;
}

/** Room on top of the daemon-side bound so the daemon times out first. */
const PTY_CALL_MARGIN_MS = 10_000;

export function createPtyHandle(call: PtyWireCall, closed: (name: string) => void): PtyHandle {
  function wire<Request extends object, Result>(
    operation: string,
    method: PtyWireMethod,
    schemas: { request: { parse: (value: object) => Request }; result: { parse: (value: Ipc.Response["result"]) => Result } },
    params: object,
    timeoutMs: number,
  ): Effect.Effect<Result, MachineError> {
    return Effect.gen(function* () {
      const request = yield* Effect.try({ try: () => schemas.request.parse(params), catch: decodeMachineFailure(`${operation}.request`) });
      const raw = yield* call(method, request, timeoutMs);
      return yield* Effect.try({ try: () => schemas.result.parse(raw), catch: decodeMachineFailure(`${operation}.response`) });
    });
  }
  return {
    open: (name, cwd) =>
      wire("pty.open", Machine.WireMethod.PtyOpen, { request: Machine.PtyOpenRequest, result: Machine.PtyOpenResult }, { name, cwd }, PTY_CALL_MARGIN_MS),
    write: (name, data) =>
      wire(
        "pty.write",
        Machine.WireMethod.PtyWrite,
        { request: Machine.PtyWriteRequest, result: Machine.PtyWriteResult },
        { name, data: Buffer.from(data).toString("base64") },
        PTY_CALL_MARGIN_MS,
      ),
    read: (name, options = {}) =>
      wire(
        "pty.read",
        Machine.WireMethod.PtyRead,
        { request: Machine.PtyReadRequest, result: Machine.PtyReadResult },
        { name, ...(options.cursor === undefined ? {} : { cursor: options.cursor }), ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }) },
        (options.waitMs ?? 0) + PTY_CALL_MARGIN_MS,
      ).pipe(Effect.map((result) => (result.status === "ok" ? { ...result, data: Buffer.from(result.data, "base64") } : result))),
    resize: (name, cols, rows) =>
      wire("pty.resize", Machine.WireMethod.PtyResize, { request: Machine.PtyResizeRequest, result: Machine.PtyResizeResult }, { name, cols, rows }, PTY_CALL_MARGIN_MS),
    close: (name) =>
      wire("pty.close", Machine.WireMethod.PtyClose, { request: Machine.PtyCloseRequest, result: Machine.PtyCloseResult }, { name }, PTY_CALL_MARGIN_MS).pipe(
        Effect.tap((result) => Effect.sync(() => {
          if (result.status === "ok" || result.reason === "pty_not_found") closed(name);
        })),
      ),
    list: () => wire("pty.list", Machine.WireMethod.PtyList, { request: Machine.PtyListRequest, result: Machine.PtyListResult }, {}, PTY_CALL_MARGIN_MS),
  };
}
