import { Data } from "effect";
import type { MachinesFailure } from "../errors";

export class IpcConnectionError extends Data.TaggedError("IpcConnectionError")<{
  readonly message: string;
  readonly cause?: string;
}> {}
export class IpcTimeoutError extends Data.TaggedError("IpcTimeoutError")<{
  readonly message: string;
  readonly cause?: string;
  readonly requestId: string;
  readonly method: string;
}> {}
export class IpcProtocolError extends Data.TaggedError("IpcProtocolError")<{
  readonly message: string;
  readonly cause?: string;
}> {}
/**
 * The host presented a key whose pin (`hostPinOf`) is not the one the
 * client holds (#1270). Raised by the client the moment the handshake
 * completes and BEFORE any frame is sent; there is no fallback path.
 */
export class IpcPeerKeyMismatchError extends Data.TaggedError("IpcPeerKeyMismatchError")<{
  readonly message: string;
  readonly expected: string;
  readonly presented: string;
}> {}
export class IpcRemoteError extends Data.TaggedError("IpcRemoteError")<{
  readonly message: string;
  readonly cause?: string;
  readonly requestId: string;
  readonly method: string;
  readonly code: number;
}> {}

/**
 * The bounded callback dispatcher refused a task because its queue is at the
 * injected bound (#1312): typed backpressure, never a silent drop.
 */
export class IpcQueueFullError extends Data.TaggedError("IpcQueueFullError")<{
  readonly message: string;
  readonly bound: number;
}> {}

export type IpcError = MachinesFailure | IpcConnectionError | IpcTimeoutError | IpcProtocolError | IpcRemoteError | IpcPeerKeyMismatchError | IpcQueueFullError;
