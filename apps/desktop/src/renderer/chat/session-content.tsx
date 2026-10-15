import { setSessionTitleIfPlaceholder } from "../state/session-actions";
import { GatewayUnavailableError } from "../errors";
import { Chat, useChat } from "@ai-sdk/react";
import { ConsoleContent, StatusGlyph } from "@openomni/ui";
import { useStore } from "@tanstack/react-store";
import type { ChatTransport, UIMessage } from "ai";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { sessionGlyphProps } from "../shell/session-glyph";
import { consoleStore, type Session, type SessionId, setDraft } from "../state/store";
import { uiMessagesToTranscript } from "./adapter";
import type { OpenOmniUIMessage } from "./message";

/** Called by App, not the keyed panel: closing a view must not stop its Chat. */
export function useSessionChats(transport: ChatTransport<UIMessage> | null) {
  const transportRef = useRef(transport);
  useLayoutEffect(() => {
    transportRef.current = transport;
  }, [transport]);
  const wire = useMemo<ChatTransport<UIMessage>>(
    () => ({
      sendMessages: (options) => current(transportRef.current).sendMessages(options),
      reconnectToStream: (options) => current(transportRef.current).reconnectToStream(options),
    }),
    [],
  );
  const chats = useRef<Map<SessionId, Chat<OpenOmniUIMessage>>>(new Map());
  useEffect(() => {
    const cache = chats.current;
    return () => {
      for (const chat of cache.values()) void chat.stop();
    };
  }, []);
  return (sessionId: SessionId): Chat<OpenOmniUIMessage> => {
    const existing = chats.current.get(sessionId);
    if (existing !== undefined) return existing;
    const created = new Chat<OpenOmniUIMessage>({
      id: sessionId,
      messages: [],
      transport: wire,
      generateId,
    });
    chats.current.set(sessionId, created);
    return created;
  };
}

export function SessionContent({
  session,
  chat,
  transport,
  notice,
  onFork,
  onOpenChild,
}: {
  readonly session: Session;
  readonly chat: Chat<OpenOmniUIMessage>;
  readonly transport: ChatTransport<UIMessage> | null;
  readonly notice: string | undefined;
  /** Fork this session's durable identity at a boundary anchor (#1257). */
  readonly onFork?: (sessionId: string, anchor: string) => void;
  /** Open one of this session's fork children as a bound local session (#1257). */
  readonly onOpenChild?: (sessionId: string, title?: string) => void;
}) {
  const draft = useStore(consoleStore, (state) => state.drafts[session.id] ?? "");
  const { messages, sendMessage, status, stop, addToolApprovalResponse, error } = useChat({ chat });
  const { nodes, costs, pending } = useMemo(() => uiMessagesToTranscript(messages), [messages]);
  const sending = status === "submitted" || status === "streaming";
  const send = () => {
    const text = draft.trim();
    if (
      text === "" ||
      transport === null ||
      chat.status === "submitted" ||
      chat.status === "streaming"
    )
      return;
    setSessionTitleIfPlaceholder(session.id, text);
    void sendMessage({ text });
    setDraft(session.id, "");
  };
  const decide = (approved: boolean) => (approvalId: string) => {
    void addToolApprovalResponse({ id: approvalId, approved });
  };
  return (
    <ConsoleContent
      header={
        <div className="px-section py-3">
          <h1 className="flex items-center gap-2 font-semibold text-label">
            <StatusGlyph {...sessionGlyphProps(session.phase)} />
            {session.title}
          </h1>
          {session.forkAside === undefined ? null : (
            // Fork ancestry aside (#1257): projection only; never part of the transcript sent back.
            <p className="mt-1 text-xs opacity-60">{session.forkAside}</p>
          )}
          {session.ancestry === undefined ? null : (
            // Parent-child inspection (#1257): the parent edge and anchor as data.
            <p
              className="mt-1 text-xs opacity-60"
              data-ui="SessionContent.Ancestry"
              data-parent={session.ancestry.forkedFrom?.session ?? session.ancestry.parentId ?? undefined}
              data-anchor={session.ancestry.forkedFrom?.anchor}
            >
              {session.ancestry.forkedFrom === null
                ? `child of ${session.ancestry.parentId}`
                : `parent ${session.ancestry.forkedFrom.session} · anchor ${session.ancestry.forkedFrom.anchor}`}
            </p>
          )}
          {onOpenChild === undefined || session.forkChildren === undefined ? null : (
            // Parent->children inspection (#1257): the read page's fork
            // children, each opening the child as a bound local session.
            <ul className="mt-1 text-xs opacity-60" data-ui="SessionContent.Forks">
              {session.forkChildren.map((child) => (
                <li key={child.sessionId}>
                  <button
                    className="underline hover:opacity-100"
                    data-anchor={child.anchor}
                    data-child={child.sessionId}
                    data-ui="SessionContent.ForkChild"
                    onClick={() => onOpenChild(child.sessionId, child.title)}
                    type="button"
                  >
                    {child.title ?? child.sessionId}
                    {child.anchor === undefined ? "" : ` · anchor ${child.anchor}`}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {onFork === undefined ||
          session.durableSessionId === undefined ||
          session.latestForkAnchor === undefined ? null : (
            <button
              className="mt-1 text-xs underline opacity-60 hover:opacity-100"
              data-ui="SessionContent.Fork"
              onClick={() => {
                if (session.durableSessionId !== undefined && session.latestForkAnchor !== undefined)
                  onFork(session.durableSessionId, session.latestForkAnchor);
              }}
              type="button"
            >
              Fork at last boundary
            </button>
          )}
        </div>
      }
      emptyLabel="No turns in this session yet."
      transcript={{
        id: session.id,
        nodes,
        costs,
        draft,
        onDraftChange: (value) => setDraft(session.id, value),
        onSubmit: send,
        onStop: () => void stop(),
        sending,
        composerDisabled: transport === null,
        composerHint: error?.message ?? notice,
        composerMeta: `${Object.keys(costs).length} turns`,
        pending,
        onApprove: decide(true),
        onDeny: decide(false),
      }}
    />
  );
}

function current(transport: ChatTransport<UIMessage> | null): ChatTransport<UIMessage> {
  if (transport === null) throw new GatewayUnavailableError("gateway not configured");
  return transport;
}

let nextId = 0;
const generateId = () => {
  nextId += 1;
  return `m${nextId}`;
};
