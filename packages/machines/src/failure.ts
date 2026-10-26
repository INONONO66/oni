import { z } from "zod";
import { MachinesFailure, MachineCellError, MachineRefusalError, TransportFailure, type MachineError } from "./errors";
import { IpcConnectionError, IpcPeerKeyMismatchError, IpcProtocolError, IpcRemoteError, IpcTimeoutError, type IpcError } from "./ipc/errors";

/** One fallback for every machines-owned domain (including `@oni/codemode`): a Cause without a typed error becomes MachinesFailure. */
function machinesFallback(operation: string) {
  return z.preprocess(String, z.string()).transform((cause) => new MachinesFailure({ operation, cause }));
}

export function decodeMachineFailure(operation: string) {
  return z.union([
    z.instanceof(MachinesFailure), z.instanceof(MachineCellError), z.instanceof(MachineRefusalError),
    z.instanceof(TransportFailure),
    machinesFallback(operation),
  ]).transform((error): MachineError => error).parse;
}

export function decodeIpcFailure(operation: string) {
  return z.union([
    z.instanceof(MachinesFailure), z.instanceof(IpcConnectionError), z.instanceof(IpcProtocolError),
    z.instanceof(IpcRemoteError), z.instanceof(IpcTimeoutError), z.instanceof(IpcPeerKeyMismatchError),
    machinesFallback(operation),
  ]).transform((error): IpcError => error).parse;
}
