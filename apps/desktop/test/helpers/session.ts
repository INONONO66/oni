import type { Session } from "../../src/renderer/state/store";
import { SessionRead } from "@oni/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../src/renderer/state/queries";
import { bindDurableSession } from "../../src/renderer/state/session-actions";

/** Presentation fixtures enter through the same durable query cache as wire pages. */
export function cacheSession(client: QueryClient, session: Session): void {
  if (session.phase === null) return;
  const id = session.durableSessionId ?? `durable:${session.id}`;
  bindDurableSession(session.id, id);
  client.setQueryData(queryKeys.session(id), SessionRead.Page.parse({
    type: "session_snapshot", sessionId: id, epoch: 1, afterRevision: 0,
    headRevision: 1, nextRevision: null, state: session.phase === "running" ? "running" : "idle",
    phase: session.phase, phaseSince: session.phaseSince,
    actions: [{ actionId: `action:${id}`, revision: 1, kind: "turn", at: session.lastActivityAt }],
    usage: [], toolWallMs: 0,
  }));
}

export function makeSession(overrides: Partial<Session> = {}): Session {
  const createdAt = overrides.createdAt ?? 0;
  return {
    id: "session",
    title: "Session",
    titleSource: "prompt",
    projectId: "default",
    phase: "idle",
    createdAt,
    lastActivityAt: createdAt,
    phaseSince: createdAt,
    unread: false,
    pinned: false,
    snoozedUntil: null,
    ...overrides,
  };
}
