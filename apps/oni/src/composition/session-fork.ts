/**
 * App-side `Session.fork` executor (#1257): binds the core fork writer to the
 * app's ledger plane. The parent's session-file schemaVersion is probed
 * read-only BEFORE the parent is opened — a legacy file is refused without
 * any open-for-write, stamp or WAL side effect. The child chain and its
 * catalog `parent_id` edge are written together by `Core.forkSession` (#1346); every failure
 * returns a typed `session_fork_refused` frame, never a silent success.
 *
 * Effect boundary (W5.3): this module builds the fork program as an Effect
 * and never runs it; the gateway edge's app runtime executes it.
 */
import { Effect } from "effect";
import { Core } from "@oni/agent";
import type { SessionFork } from "@oni/protocol";
import type { AppLedgerPlane } from "./cluster-runtime";

export interface SessionForkOptions {
  /** Injected wall clock (#1245). */
  readonly now: () => number;
  /** Injected entropy for the child session and genesis action ids (#1245). */
  readonly id: () => string;
}

export function createSessionForkExecutor(
  plane: AppLedgerPlane,
  options: SessionForkOptions,
): (request: SessionFork.Request) => Effect.Effect<SessionFork.Response> {
  return (request) => {
    const childId = request.childId ?? `fork_${options.id()}`;
    const refused = (reason: SessionFork.Reason, detail: string): SessionFork.Response => ({
      type: "session_fork_refused",
      sessionId: request.sessionId,
      reason,
      detail,
    });
    return Effect.suspend(() => {
      return plane.session(request.sessionId).fork(
        {
          at: request.at,
          childId,
          genesisActionId: `${childId}:genesis`,
          now: options.now(),
        },
      ).pipe(
        Effect.map(
          (receipt): SessionFork.Response => ({
            type: "session_forked",
            sessionId: receipt.childId,
            parentId: receipt.parentId,
            forkedFrom: receipt.forkedFrom,
            head: receipt.head,
          }),
        ),
        Effect.catch((error) =>
          Effect.succeed(
            error instanceof Core.ForkRefused
              ? refused(error.reason, error.detail)
              : refused("storage", error.message),
          ),
        ),
      );
    }).pipe(
      // Wire boundary: a defect becomes a typed refusal, never a dropped frame.
      Effect.catchDefect((defect) =>
        Effect.succeed(refused("storage", defect instanceof Error ? defect.message : String(defect))),
      ),
    );
  };
}
