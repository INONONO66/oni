import { useCallback, useState } from "react";
import type { RendererPlatform } from "../platform";
import { adoptForkedSession } from "../state/session-actions";
import { consoleStore, openTab } from "../state/store";
import type { GatewayChatTransport } from "../chat/gateway-transport";

export function useSessionActions(
  host: RendererPlatform,
  transport: GatewayChatTransport | null,
) {
  const [forkNotice, setForkNotice] = useState<string | undefined>(undefined);

  // Boundary fork (#1257): ask the gateway, adopt the durable child on success,
  // surface the typed refusal on the composer otherwise.
  const onFork = useCallback(
    (sessionId: string, anchor: string) => {
      if (transport === null || !("forkSession" in transport)) return;
      void (async () => {
        try {
          const response = await transport.forkSession({ sessionId, at: anchor });
          if (response.type === "session_forked") {
            setForkNotice(undefined);
            adoptForkedSession(response.sessionId, `Fork of ${sessionId}`, host.now());
            return;
          }
          setForkNotice(`fork refused: ${response.reason} (${response.detail})`);
        } catch (error) {
          // Boundary narrowing without a written type: the catch variable is
          // already the widest type, narrowed structurally before it renders.
          setForkNotice(error instanceof Error ? error.message : String(error));
        }
      })();
    },
    [host, transport],
  );

  // Opening a fork child (#1257): reuse the already-bound local session's tab,
  // otherwise adopt the durable child exactly like a fresh fork result.
  const onOpenChild = useCallback(
    (sessionId: string, title?: string) => {
      const existing = consoleStore.state.sessions.find(
        (local) => local.durableSessionId === sessionId,
      );
      if (existing !== undefined) {
        openTab({ kind: "session", sessionId: existing.id });
        return;
      }
      adoptForkedSession(sessionId, title ?? sessionId, host.now());
    },
    [host],
  );

  return { forkNotice, onFork, onOpenChild };
}
