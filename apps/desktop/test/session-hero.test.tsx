import { expect, test } from "bun:test";
import { Chat } from "@ai-sdk/react";
import type { ChatTransport, UIMessage } from "ai";
import { Window } from "happy-dom";
import { act } from "react";
import type { OniUIMessage } from "../src/renderer/chat/message";
import { SessionContent } from "../src/renderer/chat/session-content";
import { UI_NAMES } from "@oni/ui";
import { mountWindow } from "./helpers";
import { makeSession } from "./helpers/session";

const idle: ChatTransport<UIMessage> = {
  sendMessages: () => Promise.reject(new Error("no message may be sent")),
  reconnectToStream: () => Promise.reject(new Error("no stream may be resumed")),
};

test("an empty session hero docks after the first transcript node", async () => {
  const window = new Window({ url: "http://localhost" });
  const { host, restoreGlobals, root } = mountWindow(window);
  const chat = new Chat<OniUIMessage>({ id: "session", messages: [], transport: idle });

  try {
    await act(() =>
      root.render(
        <SessionContent chat={chat} notice={undefined} session={makeSession()} transport={null} />,
      ),
    );
    expect(host.querySelector(`[data-ui="${UI_NAMES.ConsoleHero}"]`)).not.toBeNull();
    expect(host.querySelector(`[data-ui="${UI_NAMES.Composer}"]`)).not.toBeNull();

    await act(() => {
      chat.messages = [{
        id: "prompt",
        role: "user",
        parts: [{ type: "text", text: "first prompt" }],
      }];
    });

    expect(host.querySelector(`[data-ui="${UI_NAMES.ConsoleHero}"]`)).toBeNull();
    expect(host.querySelector(`[data-ui="${UI_NAMES.Composer}"]`)).not.toBeNull();
  } finally {
    await act(() => root.unmount());
    host.remove();
    restoreGlobals();
    await window.happyDOM.close();
  }
});
