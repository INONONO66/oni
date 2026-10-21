/**
 * #1512 conformance: a test Resident sends to a declared `cli:` contact on an
 * attached machine (real daemon, real tmux on a private socket, real session
 * entity). The pane runs a FAKE child — a Bun program the pack's command
 * resolves to — that behaves as the vendor would toward the installed live
 * config using only the pack's captured fixtures. The sender gets one inbox
 * prompt whose reply_to is the send and whose content is the pointer; the
 * child's rows are visible through the app's read model and the session read
 * page; the pane is gone when the app stops. Completion is awaited on the
 * committed prompt row, never on time.
 */
import { expect, test } from "bun:test";
import { chmodSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attachMachineDaemon } from "@oni/machines";
import { L0Observation, Provisioning, type Tool } from "@oni/protocol";
import { Effect } from "effect";
import { foldAlarmChains } from "../src/bundles/alarms/index";
import { cliContactRowId, cliSessionName } from "../src/bundles/child-activity/contact/declaration";
import { cliDeadlineChain, DELEGATION_DEADLINE } from "../src/bundles/delegation-policy/index";
import { type ChildRow, receivedChildRows } from "../src/bundles/child-activity/reconcile";
import { CliTurnPointer } from "../src/bundles/messaging/send-message/index";
import { readSessionCursor } from "../src/gateway";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";
import { Bus } from "./helpers/bus";
import { pack } from "./helpers/child-activity";
import { eventSignal } from "./helpers/event-signal";
import { planeOf } from "./helpers/ledger";
import { ownerStart } from "./helpers/owner-start";
import { receivedMessages } from "./helpers/received-messages";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextResidentTurn } from "./helpers/resident-turn";
import { acquireEffect } from "./helpers/scoped-effect";
import { testSelfMachine } from "./helpers/self-machine";
import { socketPath } from "./helpers/socket-path";
import { testIds } from "./helpers/test-entropy";
import { nextFrame } from "./helpers/ws";

const suite = residentSuite();
const MACHINE = "m-1";
const CONTACT = "reviewer";
const CAPABILITIES = ["pty.session", "fs.read", "fs.write", "shell.exec"];
/**
 * One private tmux server per booted contact: a server captures its
 * environment (the pane's PATH) when it starts, so each test's fake-child
 * directory needs its own; every server is killed with the test.
 */
let servers = 0;
function privateTmux() {
  servers += 1;
  const socketName = `oni-cli-${process.pid}-${servers}`;
  const tmux = (...args: string[]) => Bun.spawnSync(["tmux", "-L", socketName, ...args], { stdout: "pipe", stderr: "pipe" });
  suite.defer(() => void tmux("kill-server"));
  return { socketName, tmux };
}

/** Every persisted child row of a session, paged like the composition reads them. */
function childRowsOf(plane: Awaited<ReturnType<typeof planeOf>>, sessionId: string): ChildRow[] {
  const kernel = plane.openKernel(sessionId);
  const rows: ChildRow[] = [];
  let afterRevision = 0;
  for (;;) {
    const page = kernel.historyPage(sessionId, { afterRevision });
    rows.push(...receivedChildRows(page.actions));
    if (page.nextRevision === null) return rows;
    afterRevision = page.nextRevision;
  }
}

/** The pack's command on the pane's PATH: a trampoline into the fake child, which reads the pack's fixtures. */
function installFakeChild(directory: string): void {
  const command = pack.manifest.commands[0];
  if (command === undefined) throw new Error("the pack declares no command");
  const packDir = realpathSync(join(import.meta.dir, "../src/bundles/child-activity/dialects", pack.manifest.id));
  const fake = realpathSync(join(import.meta.dir, "fixtures/cli-contact-fake-child.ts"));
  const path = join(directory, command);
  writeFileSync(path, `#!/bin/sh\nONI_FAKE_PACK_DIR='${packDir}' exec '${process.execPath}' '${fake}' "$@"\n`);
  chmodSync(path, 0o755);
}

/** The Resident's script: the first model call sends the letter, every later call speaks. */
function scripted(send: Tool.Call["input"]) {
  let calls = 0;
  return {
    resolveModel: fakeProviderModel,
    run: (input: Parameters<typeof requestToolStep>[0], sink: Parameters<typeof requestToolStep>[1]) =>
      Effect.sync(() => {
        calls += 1;
        if (calls === 1) requestToolStep(input, sink, { id: "send-1", tool: "send_message", input: send });
        else sink.onMessage(assistantMessage(input, { text: `turn ${calls}` }));
        return { type: "stop" as const };
      }),
  };
}

/**
 * One booted Resident with one attached machine on a private tmux socket, the
 * fake child on the pane's PATH, and the cli contact declared through the
 * Owner's own socket (the same `channel_add` the provision tool runs, the
 * Owner's call being the consent).
 */
async function bootContact(prefix: string, send: Tool.Call["input"]) {
  const { socketName, tmux } = privateTmux();
  const root = realpathSync(suite.tempDir(`${prefix}-work-`));
  const fakeDir = realpathSync(suite.tempDir(`${prefix}-bin-`));
  installFakeChild(fakeDir);
  // The daemon spawns the tmux server, whose panes inherit this process's environment: the fake child first on
  // PATH, and a plain POSIX shell so no user dotfile reorders it.
  const previous = { PATH: process.env.PATH, SHELL: process.env.SHELL };
  process.env.PATH = `${fakeDir}:${previous.PATH ?? ""}`;
  process.env.SHELL = "/bin/sh";
  suite.defer(() => {
    process.env.PATH = previous.PATH;
    process.env.SHELL = previous.SHELL;
  });
  const machinesSocket = socketPath();
  const app = await suite.boot({
    config: suite.config(`${prefix}-db-`, {
      wsToken: "owner-token",
      compactionSummarizer: false,
      machines: {
        self: testSelfMachine(),
        listen: { unix: machinesSocket },
        enrolled: [{
          name: "workstation", machineId: MACHINE, allowedCapabilities: CAPABILITIES, allowedExports: ["work"],
          publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", enrolledAt: 1000,
        }],
      },
    }),
    llm: scripted(send),
  });
  await acquireEffect(attachMachineDaemon({
    dispatcherBound: 8, socketPath: machinesSocket, id: testIds(`${prefix}-daemon`),
    offer: {
      machineId: MACHINE, daemonVersion: "0.1.0", platform: "darwin", offeredAt: 2000,
      offeredCapabilities: CAPABILITIES, exports: [{ name: "work", path: root }],
    },
    fsExports: new Map([["work", root]]), pty: { socketName },
  }));
  const plane = await planeOf(app.runtime);
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "owner-token"]);
  const request: Provisioning.ChannelDeclareRequest = {
    type: "channel_add", requestId: `${prefix}-declare`, id: cliContactRowId(CONTACT), provider: "cli",
    settings: { dialect: pack.manifest.id, machine: MACHINE, cwd: root },
  };
  const answer = nextFrame(socket, (frame) => frame.requestId === request.requestId);
  socket.send(JSON.stringify(request));
  expect(Provisioning.ChannelDeclareResponse.parse(await answer)).toMatchObject({
    type: "channel_declared", id: cliContactRowId(CONTACT),
    statuses: [{ id: cliContactRowId(CONTACT), surface: "cli", state: "ready", detail: "contact row: reached over the machine pty, no channel component" }],
  });
  expect(plane.stores.instances.get(cliContactRowId(CONTACT))).toMatchObject({ provider: "cli", createdBy: "owner", settings: request.settings });
  return { app, plane, root, tmux };
}

/** Subscribe before the trigger: resolves with the session id once a prompt row satisfying the predicate is committed. */
function awaitPrompt(plane: Awaited<ReturnType<typeof planeOf>>, name: string, satisfied: (prompt: ReturnType<typeof receivedMessages>[number]) => boolean) {
  const signal = eventSignal<string>(name, 90_000);
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind !== "prompt") return;
    if (receivedMessages(plane, event.sessionId).some(satisfied)) signal.resolve(event.sessionId);
  });
  suite.defer(unsubscribe);
  return signal.promise;
}

const fromContact = (prompt: ReturnType<typeof receivedMessages>[number]) => (prompt.origin.value as { kind?: string }).kind === "contact";
const expiry = (prompt: ReturnType<typeof receivedMessages>[number]) => {
  try {
    return (JSON.parse(prompt.content) as { kind?: string; contact?: string }).kind === "delegation.deadline";
  } catch {
    return false;
  }
};

test("send_message to a declared cli: contact types the letter into the child's pane, admits its rows, and replies with the pointer; the pane is gone on stop", async () => {
  const { app, plane, tmux } = await bootContact("cli-contact", {
    to: { kind: "contact", id: `cli:${CONTACT}` }, message: "Run: echo hello", deadline_ms: 120_000,
  });
  const replied = awaitPrompt(plane, "cli contact reply prompt", fromContact);
  await ownerStart(app, "cli-contact-start");
  const residentId = await replied;
  const sendKey = `${residentId}:send-1`;
  const prompt = receivedMessages(plane, residentId).find(fromContact);
  if (prompt === undefined) throw new Error("no contact prompt");
  expect(prompt.origin.value).toEqual({ kind: "contact", contact: `cli:${CONTACT}`, replyTo: sendKey });
  // The content is the pointer to the admitted rows, never a copy of them.
  const pointer = CliTurnPointer.parse(JSON.parse(prompt.content));
  expect(pointer).toMatchObject({ kind: "cli_turn", contact: `cli:${CONTACT}`, turn: sendKey, phase: "terminal" });
  // The child's rows: the hook spool and the transcript joined on the fixture identity, through the entity Deliver door.
  const rows = childRowsOf(plane, residentId);
  const facts = rows.filter((row): row is Extract<ChildRow, { kind: "child_fact" }> =>
    row.kind === "child_fact" && row.content.child === pointer.child && row.content.turn === pointer.turn);
  expect(facts.map((row) => row.content.phase).sort()).toEqual(["decided", "observed", "requested", "result", "terminal"]);
  expect(facts).toHaveLength(pointer.facts);
  const receipts = rows.filter((row) => row.kind === "child_receipt");
  expect(receipts.some((row) => "kind" in row.content.ref)).toBe(true);
  expect(receipts.some((row) => !("kind" in row.content.ref))).toBe(true);
  expect(rows.some((row) => row.kind === "child_conflict")).toBe(false);
  // The read model answers by hook authority; the session read page lists every admitted row by its key.
  const state = app.childActivity.state(residentId, pointer.child, pointer.turn);
  expect(state?.source).toBe("hook");
  expect(state?.fact).toMatchObject({ child: pointer.child, turn: pointer.turn });
  const kernel = plane.openKernel(residentId);
  const listed = new Set<string>();
  let cursor: { epoch: number; revision: number } | undefined;
  for (;;) {
    const page = readSessionCursor(kernel, { type: "session_read", sessionId: residentId, limit: 256, ...(cursor === undefined ? {} : { cursor }) });
    if (page.type === "session_gap") throw new Error("session page gap");
    for (const action of page.actions) listed.add(action.actionId);
    if (page.nextRevision === null) break;
    cursor = { epoch: page.epoch, revision: page.nextRevision };
  }
  for (const row of rows) expect(listed.has(row.key)).toBe(true);
  // r1 L1: the deadline armed for the send is retired with the terminal — its chain's latest arm is `at: null`.
  // r2 M2: the chain is the cli child's own, never the session's shared `delegation.deadline` chain.
  const chains = foldAlarmChains(kernel, residentId);
  const deadline = chains.get(cliDeadlineChain(residentId, pointer.child));
  expect(deadline?.latest).toMatchObject({ purpose: DELEGATION_DEADLINE, at: null, sourceKey: `delegation:${pointer.child}` });
  expect(deadline?.armCount).toBe(2);
  expect(chains.has(`${residentId}:${DELEGATION_DEADLINE}`)).toBe(false);
  // The pane lives on the private tmux socket while the app runs.
  const session = cliSessionName(CONTACT);
  expect(tmux("has-session", "-t", session).exitCode).toBe(0);
  // Cleanup proof: stopping the app drops the pane this Resident launched.
  await app.stop();
  expect(tmux("has-session", "-t", session).exitCode).not.toBe(0);
}, 120_000);

test("a deadline on a cli send arms delegation.deadline; its fire interrupts the pane and the parent gets the expiry prompt", async () => {
  // The [hang] child acknowledges the letter with UserPromptSubmit alone and never ends its turn. The deadline is
  // LONGER than the pack's stall window (r1 H2): an acknowledgement that shares the turn's one `observed` fact must
  // count as live observation, so the deadline path and the stall path are provably distinct — a stall here would
  // retire the pane first, and the later fire would find no child to interrupt.
  const stallWindowMs = pack.submit("probe").stallWindowMs;
  const { app, plane, tmux } = await bootContact("cli-deadline", {
    to: { kind: "contact", id: `cli:${CONTACT}` }, message: "Run: echo hello [hang]", deadline_ms: stallWindowMs + 2_000,
  });
  const expired = awaitPrompt(plane, "delegation.deadline prompt", expiry);
  await ownerStart(app, "cli-deadline-start");
  const residentId = await expired;
  const prompt = receivedMessages(plane, residentId).find(expiry);
  if (prompt === undefined) throw new Error("no expiry prompt");
  expect(JSON.parse(prompt.content)).toMatchObject({ kind: "delegation.deadline", contact: `cli:${CONTACT}` });
  // The letter reached the pane: the child's submit was observed, no terminal, no stall diagnostic, no contact reply.
  const rows = childRowsOf(plane, residentId);
  const phases = rows.flatMap((row) => (row.kind === "child_fact" && row.content.turn === `${residentId}:send-1` ? [row.content.phase] : []));
  expect(phases).toContain("observed");
  expect(phases).not.toContain("terminal");
  expect(rows.some((row) => row.kind === "child_diagnostic")).toBe(false);
  expect(receivedMessages(plane, residentId).some(fromContact)).toBe(false);
  // The interrupt reached the pane: ETX ended the fake child, and with it the pane it was exec'd in.
  expect(tmux("has-session", "-t", cliSessionName(CONTACT)).exitCode).not.toBe(0);
}, 120_000);

test("a child that swallows the letter is a prompt_stalled diagnostic through the reconciler's door, and its pane is retired", async () => {
  const { app, plane, tmux } = await bootContact("cli-stall", {
    to: { kind: "contact", id: `cli:${CONTACT}` }, message: "Run: echo hello [stall]",
  });
  // The diagnostic is an admitted child row: await its committed action.
  const noted = eventSignal<string>("prompt_stalled diagnostic", 90_000);
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind !== "action") return;
    const stalled = childRowsOf(plane, event.sessionId).some(
      (row) => row.kind === "child_diagnostic" && row.content.diagnostic.code === "prompt_stalled",
    );
    if (stalled) noted.resolve(event.sessionId);
  });
  suite.defer(unsubscribe);
  // The run fails only after the pane is retired, and the Resident's turn ends only after the run: that terminal
  // is the exact state the cleanup assertion waits for.
  const terminal = nextResidentTurn(plane, 60_000);
  await ownerStart(app, "cli-stall-start");
  const residentId = await noted.promise;
  await terminal;
  const diagnostic = childRowsOf(plane, residentId).find((row) => row.kind === "child_diagnostic");
  expect(diagnostic).toMatchObject({
    kind: "child_diagnostic",
    content: { turn: `${residentId}:send-1`, ref: { machine: MACHINE, range: { offsetBytes: 0, lengthBytes: 0 } }, diagnostic: { code: "prompt_stalled" } },
  });
  // Retired: the pane is gone before the app stops, and no contact reply exists.
  expect(tmux("has-session", "-t", cliSessionName(CONTACT)).exitCode).not.toBe(0);
  expect(receivedMessages(plane, residentId).some(fromContact)).toBe(false);
}, 120_000);
