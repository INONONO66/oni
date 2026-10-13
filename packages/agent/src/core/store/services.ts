import type { Effect } from "effect";
import type { LedgerSession, Storage as ProtocolStorage } from "@openomni/protocol";
import type { LedgerError } from "./errors";
import type { CatalogStore } from "./catalog.js";
import type { SessionStore } from "./session-file/index.js";

export type CommitReceipt = Extract<LedgerSession.CommitResult, { readonly ok: true }>;
export type AdoptReceipt = { readonly ok: true; readonly fence: number };

export interface SessionWriteAdapter
  extends Pick<ProtocolStorage.SessionSubAdapter, "get" | "list"> {
  create(row: LedgerSession.Row): Effect.Effect<boolean, LedgerError>;
  materialize(
    input: LedgerSession.Materialize,
  ): Effect.Effect<LedgerSession.MaterializeResult, LedgerError>;
  adoptFence(input: LedgerSession.AdoptFence): Effect.Effect<AdoptReceipt, LedgerError>;
  commit(input: LedgerSession.Commit): Effect.Effect<CommitReceipt, LedgerError>;
}

/** Entity activations own the lifecycle of the stores they open. */
export interface LedgerHandles {
  readonly catalog: CatalogStore;
  readonly openSession: (sessionId: string) => SessionStore;
}
