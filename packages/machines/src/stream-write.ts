import type { Machine } from "@oni/protocol";
import type { Effect } from "effect";
import type { MachineError } from "./errors.js";
import type { MachineHandle } from "./host.js";

export interface StreamWriteOptions {
  readonly create: "exclusive";
  readonly maxBytes: number;
  readonly expectedBytes: number;
  readonly signal: AbortSignal;
}

export type StreamWriteReceipt = Extract<Machine.FsValue, { op: "write" }> & {
  readonly sha256: string;
};

/** Uses machine.fs_stream; success means digest-checked atomic finish was acknowledged. */
export interface MachineStreamWriter {
  writeStream(
    path: string,
    chunks: AsyncIterable<Uint8Array>,
    options: StreamWriteOptions,
  ): Effect.Effect<StreamWriteReceipt, MachineError>;
}

/** Additive target: implementing the host method belongs to the machines lane. */
export type StreamingMachineHandle = Omit<MachineHandle, "fs"> & {
  readonly fs: MachineHandle["fs"] & MachineStreamWriter;
};
