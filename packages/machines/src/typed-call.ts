import type { Ipc } from "@oni/protocol";
import type { Effect } from "effect";
import type { IpcError } from "./ipc/errors";
import type { IpcClient } from "./ipc/client";

type MethodTable = typeof Ipc.Methods;
type MethodName = keyof MethodTable;
type MethodParams<Method extends MethodName> = MethodTable[Method]["params"]["_input"];
type MethodResult<Method extends MethodName> = MethodTable[Method]["result"]["_output"];

type GenericIpcCaller = Pick<IpcClient, "call">;

/**
 * Schema-derived facade for same-version machine wire methods. Lives beside
 * its callers (host/daemon) so the generic ipc layer carries no machine
 * vocabulary; the caller's generic call remains available for unknown methods
 * used by mixed-version peers.
 */
export function typedCall<Method extends MethodName>(
  caller: GenericIpcCaller,
  method: Method,
  params: MethodParams<Method>,
  timeoutMs?: number,
): Effect.Effect<MethodResult<Method>, IpcError> {
  return caller.call(method, params, timeoutMs) as Effect.Effect<MethodResult<Method>, IpcError>;
}
