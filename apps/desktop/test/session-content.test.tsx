import { expect, test } from "bun:test";
import { Chat } from "@ai-sdk/react";
import type { ChatTransport, UIMessage } from "ai";
import { Window } from "happy-dom";
import { act } from "react";
import type { OniUIMessage } from "../src/renderer/chat/message";
import { SessionContent, useSessionChats } from "../src/renderer/chat/session-content";
import { GatewayUnavailableError } from "../src/renderer/errors";
import { mountWindow } from "./helpers";
import { makeSession } from "./helpers/session";

/** A decision never sends a message on its own, so any wire use is a failure. */
const idle: ChatTransport<UIMessage> = {
  sendMessages: () => Promise.reject(new Error("no message may be sent by a decision")),
  reconnectToStream: () => Promise.reject(new Error("no stream may be resumed by a decision")),
};

const blocked = (): OniUIMessage => ({
  id: "answer",
  role: "assistant",
  parts: [
    {
      type: "tool-bash",
      toolCallId: "call-7",
      state: "approval-requested",
      input: { command: "rm -rf dist" },
      approval: { id: "approval-7" },
    },
  ],
});

test.each([
  ["Approve", true],
  ["Deny", false],
])("%s in the tray answers the Chat's blocked tool with that decision", async (control, approved) => {
  const window = new Window({ url: "http://localhost" });
  const { host, restoreGlobals, root } = mountWindow(window);
  const chat = new Chat<OniUIMessage>({
    id: "session",
    messages: [blocked()],
    transport: idle,
  });
  try {
    await act(() =>
      root.render(
        <SessionContent chat={chat} notice={undefined} session={makeSession()} transport={null} />,
      ),
    );
    expect(host.querySelector('[data-tool-row="approval-7"]')).not.toBeNull();
    const button = host.querySelector<HTMLElement>(`[data-ui="ApprovalTray.${control}"]`);
    expect(button).not.toBeNull();
    await act(() => button?.click());
    expect(chat.lastMessage?.parts).toEqual([
      {
        type: "tool-bash",
        toolCallId: "call-7",
        state: "approval-responded",
        input: { command: "rm -rf dist" },
        approval: { id: "approval-7", approved },
      },
    ]);
    expect(host.querySelector('[data-ui="ApprovalTray"]')).toBeNull();
    expect(host.querySelector('[data-tool-row="call-7"]')).not.toBeNull();
  } finally {
    await act(() => root.unmount());
    host.remove();
    restoreGlobals();
    await window.happyDOM.close();
  }
});

test("a send without a configured gateway surfaces the named class on the chat", async () => {
  const window = new Window({ url: "http://localhost" });
  const { host, restoreGlobals, root } = mountWindow(window);
  let chatFor: ReturnType<typeof useSessionChats> | undefined;
  function Probe() {
    chatFor = useSessionChats(null);
    return null;
  }
  try {
    await act(() => root.render(<Probe />));
    const chat = chatFor?.("session");
    if (chat === undefined) throw new Error("the probe did not mount");
    await act(() => chat.sendMessage({ text: "hello" }));
    expect(chat.error).toBeInstanceOf(GatewayUnavailableError);
  } finally {
    await act(() => root.unmount());
    host.remove();
    restoreGlobals();
    await window.happyDOM.close();
  }
});

test("the fork control cites the newest boundary anchor and ancestry renders as data", async () => {
  const window = new Window({ url: "http://localhost" });
  const { host, restoreGlobals, root } = mountWindow(window);
  const chat = new Chat<OniUIMessage>({ id: "session", messages: [], transport: idle });
  const forks: [string, string][] = [];
  const session = makeSession({
    durableSessionId: "durable",
    latestForkAnchor: "hash-2",
    ancestry: {
      parentId: "parent",
      forkedFrom: { session: "parent", anchor: "hash-0", parentSeq: 3, parentHead: "head-3", copied: 4 },
      aside: "aside text",
    },
  });
  try {
    await act(() =>
      root.render(
        <SessionContent
          chat={chat}
          notice={undefined}
          onFork={(sessionId, anchor) => forks.push([sessionId, anchor])}
          session={session}
          transport={null}
        />,
      ),
    );
    // Parent-child inspection: the parent edge and anchor are data, not prose.
    const ancestry = host.querySelector<HTMLElement>('[data-ui="SessionContent.Ancestry"]');
    expect(ancestry?.getAttribute("data-parent")).toBe("parent");
    expect(ancestry?.getAttribute("data-anchor")).toBe("hash-0");
    const button = host.querySelector<HTMLElement>('[data-ui="SessionContent.Fork"]');
    expect(button).not.toBeNull();
    await act(() => button?.click());
    expect(forks).toEqual([["durable", "hash-2"]]);
  } finally {
    await act(() => root.unmount());
    host.remove();
    restoreGlobals();
    await window.happyDOM.close();
  }
});

test("a session without a boundary anchor or durable identity offers no fork control", async () => {
  const window = new Window({ url: "http://localhost" });
  const { host, restoreGlobals, root } = mountWindow(window);
  const chat = new Chat<OniUIMessage>({ id: "session", messages: [], transport: idle });
  try {
    await act(() =>
      root.render(
        <SessionContent
          chat={chat}
          notice={undefined}
          onFork={() => {
            throw new Error("no fork may be offered without an anchor");
          }}
          session={makeSession()}
          transport={null}
        />,
      ),
    );
    expect(host.querySelector('[data-ui="SessionContent.Fork"]')).toBeNull();
    expect(host.querySelector('[data-ui="SessionContent.Ancestry"]')).toBeNull();
  } finally {
    await act(() => root.unmount());
    host.remove();
    restoreGlobals();
    await window.happyDOM.close();
  }
});
