import { relativeTime } from "@oni/ui";
import type { Session } from "../state/store";

export function formatRelative(now: number, at: number): string {
  return relativeTime(at, now);
}

/**
 * Whether the row's second line names the session's state or its last
 * activity. A phase the Owner can act on or watch is state; a session at rest,
 * or one whose end has already been read, is described by when it last moved.
 */
export function hasActiveState(session: Pick<Session, "phase" | "unread">): boolean {
  switch (session.phase) {
    case null:
    case "idle":
    case "archived":
      return false;
    case "completed":
    case "failed":
      return session.unread;
    default:
      return true;
  }
}

export function sessionReason(session: Session, now: number): string {
  switch (session.phase) {
    case null:
      return "not connected";
    case "waiting_approval":
      return `waiting for approval · ${formatRelative(now, session.phaseSince)}`;
    case "waiting_input":
      return `waiting for input · ${formatRelative(now, session.phaseSince)}`;
    case "interrupted":
      return `interrupted ${formatRelative(now, session.phaseSince)}`;
    case "completed":
    case "failed":
      return `${session.phase}${session.unread ? " · unread" : ""}`;
    default:
      return session.phase;
  }
}
