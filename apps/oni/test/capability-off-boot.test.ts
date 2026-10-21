/**
 * #1306 — the full-app capability-off boot matrix: every removable capability
 * (`alarm`, `action`, `hook`, `compaction`, `tool`) boots the WHOLE app
 * through the product manifest with that one name in `off`, and each boot
 * proves three things:
 *
 * 1. the adopted `session.configure{operation: "compose"}` row carries
 *    exactly the typed `disabled: [{name, because}]` cascade with `because`
 *    equal to the root off name;
 * 2. the removed surface is really gone — the point registry, the handler
 *    table, the composed capability list, the input kinds and the tool face
 *    the model sees, per row;
 * 3. an input of the removed kind delivered after boot refuses typed
 *    `unknown_kind` with ZERO new facts (journal length unchanged).
 *
 * Clock and entropy are injected, so two boots of the same row journal
 * identical compose-row bytes (golden check on the `alarm` row). No sleeps:
 * every wait subscribes to the exact committed event with a bounded timeout.
 */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Bundle, Core } from "@oni/agent";
import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { ComposedGeneration } from "../src/composition/composed";
import { runAppEffect } from "../src/gateway";
import type { AppLedgerPlane } from "../src/composition/cluster-runtime";
import { assistantMessage } from "./helpers/assistant-message";
import { composeRowOf } from "./helpers/app-fixture";
import { planeOf } from "./helpers/ledger";
import { nextResidentTurn } from "./helpers/resident-turn";
import { residentSuite, fakeProviderModel } from "./helpers/resident-suite";
import { CHILD_WATCH } from "../src/bundles/child-activity/index";
import { spec as childSpec } from "./helpers/child-activity";

const suite = residentSuite();
const T0 = 1_700_000_000_000;

interface OffRow {
  readonly name: string;
  readonly off: readonly string[];
  /** The exact typed cascade the compose configure row must journal. */
  readonly disabled: readonly { name: string; because: string }[];
  /** The removed input kind a post-boot delivery must refuse `unknown_kind`. */
  readonly probeKind: string;
  readonly absentPoints?: readonly string[];
  readonly absentHandlers?: readonly string[];
  readonly absentCapabilities?: readonly string[];
  readonly absentInputs?: readonly string[];
  /** Names that must not reach the model's tool face on the booted turn. */
  readonly absentTools?: readonly string[];
}

/**
 * The measured product cascades on this manifest: `monitor`, `cron` and
 * `delegation-policy` require the alarm seam; `hook` requires `action` and
 * `hooks-json` requires `hook`; `delegation-policy` also requires the action
 * and tool seams; every tool bundle requires the tool seam (#1561);
 * nothing requires `compaction`.
 */
const ROWS: readonly OffRow[] = [
  {
    name: "alarm",
    off: ["alarm"],
    probeKind: "alarm",
    disabled: [
      { name: "alarm", because: "alarm" },
      { name: "monitor", because: "alarm" },
      { name: "child-activity", because: "alarm" },
      { name: "cron", because: "alarm" },
      { name: "delegation-policy", because: "alarm" },
    ],
    absentPoints: ["alarm.fired"],
    absentTools: ["monitor"],
  },
  {
    name: "action",
    off: ["action"],
    probeKind: "action",
    disabled: [
      { name: "action", because: "action" },
      { name: "hook", because: "action" },
      { name: "child-activity", because: "action" },
      { name: "hooks-json", because: "action" },
      { name: "delegation-policy", because: "action" },
    ],
    absentPoints: ["action.pre"],
    absentInputs: ["action"],
  },
  {
    name: "hook",
    off: ["hook"],
    probeKind: "hook",
    disabled: [
      { name: "hook", because: "hook" },
      { name: "hooks-json", because: "hook" },
    ],
    absentHandlers: ["hook/process", "hooks-json/secrets-guard"],
  },
  {
    name: "compaction",
    off: ["compaction"],
    probeKind: "compaction",
    disabled: [
      { name: "compaction", because: "compaction" },
      { name: "compaction-strategy", because: "compaction" },
    ],
    absentPoints: ["compaction.pre", "compaction.post"],
    absentCapabilities: ["compaction"],
  },
  {
    name: "tool",
    off: ["tool"],
    probeKind: "tool",
    disabled: [
      { name: "tool", because: "tool" },
      { name: "file", because: "tool" },
      { name: "bash", because: "tool" },
      { name: "eval", because: "tool" },
      { name: "monitor", because: "tool" },
      { name: "delegation-policy", because: "tool" },
      { name: "send-message", because: "tool" },
      { name: "provision", because: "tool" },
      { name: "completion", because: "tool" },
    ],
    absentPoints: ["tool.pre", "tool.post"],
    absentTools: ["eval", "bash", "read", "monitor", "send_message"],
  },
];

function residentSessionId(plane: AppLedgerPlane): string {
  const sessionId = plane.listSessions().find((row) => row.id !== "gateway-ingress")?.id;
  if (sessionId === undefined) throw new Error("no resident session");
  return sessionId;
}

/** Boots the whole app through the product manifest with `off` and runs one turn. */
async function bootWithOff(prefix: string, off: readonly string[], toolsSeen: string[][]) {
  let entropyCount = 0;
  const app = await suite.boot({
    config: suite.config(prefix, { off: [...off] }),
    clusterClock: "injected",
    sessionRuntime: { clock: () => T0, entropy: () => `cap-off-${++entropyCount}` },
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) =>
        Effect.sync(() => {
          toolsSeen.push(input.tools.map((tool) => tool.name));
          sink.onMessage(
            assistantMessage(input, {
              id: `cap-off-reply-${toolsSeen.length}`,
              text: "booted",
              createdAt: T0,
            }),
          );
          return { type: "stop" as const };
        }),
    },
  });
  const plane = await planeOf(app.runtime);
  const turn = nextResidentTurn(plane);
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, []);
  ws.send(JSON.stringify({ type: "message", eventId: "cap-off-turn", text: "boot probe" }));
  await turn;
  return { app, plane };
}

/** Delivers one input of a removed kind; returns the typed entity result. */
function deliverRemovedKind(
  app: Awaited<ReturnType<typeof bootWithOff>>["app"],
  sessionId: string,
  kind: string,
) {
  return runAppEffect(
    app.runtime,
    Effect.scoped(
      Effect.gen(function* () {
        const makeClient = yield* Core.SessionEntity.client;
        return yield* Effect.result(
          makeClient(sessionId).Deliver({
            kind,
            body: JSON.stringify({ content: "spurious" }),
            source: JSON.stringify({
              kind: "message",
              messageId: `${kind}-off-probe`,
              senderSessionId: sessionId,
              sourceActionId: `${kind}-off-probe`,
            }),
            idempotencyKey: `${kind}-off-probe-1`,
          }),
        );
      }),
    ),
  );
}

test.each([...ROWS])(
  "the app boots with the $name capability off: typed cascade journaled, surface gone, removed kind refused",
  async (row) => {
    const toolsSeen: string[][] = [];
    const { app, plane } = await bootWithOff(`cap-off-${row.name}-`, row.off, toolsSeen);
    // 1. The compose configure row journals exactly the typed cascade.
    const composeAction = await composeRowOf(app);
    const intent = composeAction.intent.value as { disabled?: OffRow["disabled"] };
    expect(intent.disabled).toEqual(row.disabled);
    // 2. The removed surface is really gone from the adopted composition.
    const generation = await runAppEffect(
      app.runtime,
      Effect.map(ComposedGeneration, (holder) => holder.current().generation),
    );
    for (const point of row.absentPoints ?? []) expect(generation.points).not.toContain(point);
    for (const handler of row.absentHandlers ?? [])
      expect([...generation.handlers.keys()]).not.toContain(handler);
    for (const capability of row.absentCapabilities ?? [])
      expect(generation.capabilities).not.toContain(capability);
    for (const kind of row.absentInputs ?? []) expect(generation.inputs).not.toContain(kind);
    expect(toolsSeen).toHaveLength(1);
    for (const tool of row.absentTools ?? []) expect(toolsSeen[0]).not.toContain(tool);
    // 3. A delivered input of the removed kind refuses typed with zero new facts.
    const sessionId = residentSessionId(plane);
    const before = sessionTree(sessionId, plane.sessionStore(sessionId).actions).length;
    const refusal = await deliverRemovedKind(app, sessionId, row.probeKind);
    expect(refusal).toMatchObject({ _tag: "Failure", failure: { code: "unknown_kind" } });
    expect(sessionTree(sessionId, plane.sessionStore(sessionId).actions)).toHaveLength(before);
  },
  40_000,
);

test("a bundle and a capability ride one off list: each cascade keeps its own root", async () => {
  const toolsSeen: string[][] = [];
  const { app } = await bootWithOff("cap-off-mixed-", ["monitor", "hook"], toolsSeen);
  const intent = (await composeRowOf(app)).intent.value as { disabled?: OffRow["disabled"] };
  expect(intent.disabled).toEqual([
    { name: "monitor", because: "monitor" },
    { name: "hook", because: "hook" },
    { name: "hooks-json", because: "hook" },
  ]);
  expect(toolsSeen[0]).not.toContain("monitor");
}, 40_000);

test("the app boots with the child-activity bundle off: typed cascade journaled, purpose gone, install refuses", async () => {
  const toolsSeen: string[][] = [];
  const { app } = await bootWithOff("cap-off-child-activity-", ["child-activity"], toolsSeen);
  const intent = (await composeRowOf(app)).intent.value as { disabled?: OffRow["disabled"] };
  expect(intent.disabled).toEqual([{ name: "child-activity", because: "child-activity" }]);
  const generation = await runAppEffect(
    app.runtime,
    Effect.map(ComposedGeneration, (holder) => holder.current().generation),
  );
  expect(generation.bundles).not.toContain("child-activity");
  expect([...generation.purposes.keys()]).not.toContain(CHILD_WATCH);
  // The bundle's one install door refuses typed before any source or cadence exists.
  await expect(app.childActivity.install(childSpec)).rejects.toMatchObject({ reason: "disabled" });
  // Nothing else composed out: the alarm plane and the monitor face stay.
  expect(generation.points).toContain("alarm.fired");
  expect(toolsSeen[0]).toContain("monitor");
}, 40_000);

test("an off name the manifest never declared refuses the boot typed: no runtime, no model call", async () => {
  const toolsSeen: string[][] = [];
  const boot = bootWithOff("cap-off-unknown-", ["not-a-capability"], toolsSeen);
  await expect(boot).rejects.toBeInstanceOf(Bundle.DefineRefused);
  await expect(boot).rejects.toMatchObject({ code: "unknown", name: "manifest", detail: "not-a-capability" });
  expect(toolsSeen).toEqual([]);
}, 40_000);

test("golden: the alarm row booted twice from pinned clock and entropy journals identical compose-row bytes", async () => {
  const first = await bootWithOff("cap-off-golden-", ["alarm"], []).then(({ app }) =>
    composeRowOf(app),
  );
  await suite.cleanup();
  const second = await bootWithOff("cap-off-golden-", ["alarm"], []).then(({ app }) =>
    composeRowOf(app),
  );
  expect(second).toEqual(first);
}, 80_000);
