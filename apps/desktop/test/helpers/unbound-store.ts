import assert from "node:assert/strict";
import { RendererInvariantError } from "../../src/renderer/errors";
import {
  bindStorePlatform,
  consoleStore,
  createSession,
  navigate,
  newSessionTab,
  openTab,
} from "../../src/renderer/state/store";

assert.throws(() => createSession(1), RendererInvariantError);
assert.throws(() => openTab({ kind: "route", route: "automations" }), RendererInvariantError);
assert.throws(() => navigate({ kind: "route", route: "automations" }), RendererInvariantError);
assert.throws(() => newSessionTab(), RendererInvariantError);

let minted = 0;
bindStorePlatform({ now: () => 42, id: () => `fake-${++minted}` });
newSessionTab();
assert.equal(consoleStore.state.sessions[0]?.id, "fake-1");
assert.equal(consoleStore.state.sessions[0]?.createdAt, 42);
