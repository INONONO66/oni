import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bundle, Core } from "@openomni/agent";
import { LlmLive } from "../src/runtime";
import { L0Observation, type LedgerAction } from "@openomni/protocol";
type RunInput = Core.RunInput;
type Sink = Core.LlmSink;
import { Clock, Context, Effect, Layer } from "effect";
import {
  hooksJsonBundle,
  readHooksJson,
  SECRETS_GUARD_REF,
  secretsGuard,
} from "../src/bundles/hooks-json/index";
import { composedHolderOf, alarmPortsSlot } from "../src/composition/composed";
import { createWatchPlane } from "../src/composition/watch-plane";
import { gatewayRuntime, runAppEffect } from "../src/gateway";
import { appManifest } from "../src/manifest";
import { alarmDefinition } from "./helpers/alarm-definition";
import { gateRowPolicySeeds } from "../src/bundles/core-policy/index";
import { AppInvariantError } from "../src/invariant";
import { assistantMessage, requestToolStep, type AssistantMessageOptions } from "./helpers/assistant-message";
import { planeOf } from "./helpers/ledger";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextResidentTurn } from "./helpers/resident-turn";
import { Bus } from "./helpers/bus";
import { testToolsBundle } from "./helpers/app-fixture";
import { nextFrame } from "./helpers/ws";
import { z } from "zod";
import { isolated, isolatedLedger } from "../../../packages/agent/test/helpers/isolated";
import { executionReads } from "../../../packages/agent/test/helpers/execution-reads";
import { runAgentSync, testExecutor } from "../../../packages/agent/test/helpers/executor";
import { catalogLayer } from "../../../packages/agent/test/helpers/service-layers";
import { testClockRuntime } from "./helpers/effect";
import { eventSignal } from "./helpers/event-signal";
import { untilCommitted } from "./helpers/committed-state";
import { openResidentRequest } from "./helpers/open-resident-request";
import { testEntropy } from "./helpers/test-entropy";

/**
 * #1256 hooks-json: the product bundle compiling a hooks JSON file into gate
 * rows over the hook capability, wired through the REAL `appManifest ->
 * compose` boot (and `startOpenOmni` for the file path), fail-closed at every
 * refusal edge.
 */

const suite = residentSuite();

function expectRefusal(thunk: () => void, code: string) {
  expect(thunk).toThrow(AppInvariantError);
  expect(thunk).toThrow(expect.objectContaining({ code }));
}

type JournalActionRow = {
  readonly kind: LedgerAction.Kind;
  readonly intent: string;
};

const decisionSchema = z.object({
  verdict: z.string(),
  gate: z.object({
    verdict: z.string().optional(),
    output: z.object({ command: z.string().optional() }).optional(),
    consulted: z.array(z.object({
      ref: z.string(),
      payload: z.object({ verdict: z.string().optional(), reason: z.string().optional() }).optional(),
    })),
  }).optional(),
});

function decodeJournalJson<T extends z.ZodType>(serialized: string, schema: T): z.output<T> {
  return schema.parse(JSON.parse(serialized));
}

function expectedCommandRow<On extends "tool.pre", Action extends "gate" | "rewrite", How extends object>(id: string, on: On, action: Action, how: How, order: number) {
  return { id, on, when: {}, do: action, how, order };
}

function decisionRows(database: Database, point: string) {
  return database.query<{ intent: string }, [string]>(
    "SELECT intent FROM action WHERE kind = 'policy.decision' AND json_extract(intent, '$.hook') = ? ORDER BY ordinal ASC",
  ).all(point).map((row) => decodeJournalJson(row.intent, decisionSchema));
}

function sessionDecisions(config: ReturnType<typeof suite.config>, sessionId: string, point: string) {
  if (config.sessionsDir === undefined) throw new Error("suite config always sets sessionsDir");
  const database = new Database(join(config.sessionsDir, `${sessionId}.sqlite`), { readonly: true });
  try { return decisionRows(database, point); }
  finally { database.close(); }
}

function pendingToolMessage(input: RunInput, id: string, callID: string, tool: string, command: string) {
  return assistantMessage(input, {
    id, createdAt: Date.now(), reason: "tool-calls",
    parts: [{
      id: `${id}-tool`, sessionID: input.trace.sessionId, messageID: id,
      type: "tool", callID, tool, state: { status: "pending", input: { command } },
    }],
  });
}

function responseLlm(
  options: (input: RunInput) => AssistantMessageOptions,
  before?: (input: RunInput) => void,
) {
  return {
    resolveModel: fakeProviderModel,
    run: (input: RunInput, sink: Sink) => Effect.sync(() => {
      before?.(input);
      sink.onMessage(assistantMessage(input, options(input)));
      return { type: "stop" as const };
    }),
  };
}

function committedDecision(
  plane: Awaited<ReturnType<typeof planeOf>>,
  label: string,
  field: "verdict" | "hook",
  expected: string,
) {
  const signal = eventSignal<{ sessionId: string; id: string }>(label, 15_000);
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind !== "policy.decision") return;
    const node = plane.openKernel(event.sessionId).actionById(event.id);
    const intent = z.object({ verdict: z.string().optional(), hook: z.string().optional() }).safeParse(node?.intent.value);
    if (intent.success && intent.data[field] === expected)
      signal.resolve({ sessionId: event.sessionId, id: event.id });
  });
  return { signal, unsubscribe };
}

async function bootOwner(options: Parameters<typeof suite.boot>[0]) {
  const app = await suite.boot(options);
  const { plane, ws } = await ownerConnection(app);
  return { app, plane, ws };
}

async function ownerConnection(app: Awaited<ReturnType<typeof suite.boot>>, token?: string) {
  const plane = await planeOf(app.runtime);
  const ws = token === undefined
    ? await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, [])
    : await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", token]);
  return { plane, ws };
}

function composed(input?: {
  hooks?: Parameters<typeof hooksJsonBundle>[0];
  off?: readonly string[];
}) {
  return alarmDefinition().then((alarm) =>
    Bundle.composeSync(
      appManifest({
        alarm,
        wake: { close: () => undefined },
        alarms: () => undefined, tools: () => undefined,
        ...(input?.hooks === undefined ? {} : { hooks: input.hooks }),
        ...(input?.off === undefined ? {} : { off: input.off }),
      }),
    ),
  );
}

test("the four mapped events compile to rows on their points over hook/process", async () => {
  const generation = await composed({
    hooks: {
      PreToolUse: [
        { command: ["./guard.sh"], timeoutMs: 1_000 },
        { guard: "secrets-guard", fields: ["command"] },
      ],
      PostToolUse: [{ command: ["./audit.sh"], timeoutMs: 2_000 }],
      UserPromptSubmit: [{ command: ["./prompt.sh"], timeoutMs: 3_000 }],
      SessionStart: [{ command: ["./start.sh"], timeoutMs: 4_000 }],
    },
  });
  const hooksRows = generation.rows.filter((row) => row.id.startsWith("hooks-json/"));
  expect(hooksRows).toEqual([
    expectedCommandRow("hooks-json/tool.pre#1", "tool.pre", "gate", {
      ref: Bundle.HOOK_PROCESS_REF,
      params: { event: "PreToolUse", command: ["./guard.sh"], timeoutMs: 1_000 },
    }, 500),
    {
      id: "hooks-json/tool.pre#2",
      on: "tool.pre",
      when: {},
      do: "rewrite",
      // #1256 r3 H-3: a rewrite row declares its fields, validated against
      // the point registry at compile.
      how: {
        ref: SECRETS_GUARD_REF,
        fields: ["command"],
        params: { event: "PreToolUse", fields: ["command"] },
      },
      order: 501,
    },
    {
      id: "hooks-json/tool.post#1",
      on: "tool.post",
      when: {},
      // PostToolUse is audit-only: it annotates, it cannot block (#1256).
      do: "observe",
      how: {
        ref: Bundle.HOOK_PROCESS_REF,
        params: { event: "PostToolUse", command: ["./audit.sh"], timeoutMs: 2_000 },
      },
      order: 502,
    },
    {
      id: "hooks-json/prompt.pre#1",
      on: "prompt.pre",
      when: {},
      do: "gate",
      how: {
        ref: Bundle.HOOK_PROCESS_REF,
        params: { event: "UserPromptSubmit", command: ["./prompt.sh"], timeoutMs: 3_000 },
      },
      order: 503,
    },
    {
      id: "hooks-json/session.open#1",
      on: "session.open",
      when: {},
      do: "gate",
      how: {
        ref: Bundle.HOOK_PROCESS_REF,
        params: { event: "SessionStart", command: ["./start.sh"], timeoutMs: 4_000 },
      },
      order: 504,
    },
  ]);
  // Both handler registrations are composed: the capability's process target
  // and the bundle's in-process example transformer.
  expect(generation.handlers.has(Bundle.HOOK_PROCESS_REF)).toBe(true);
  expect(generation.handlers.has(SECRETS_GUARD_REF)).toBe(true);
});

test("H-2: a command entry with do:rewrite compiles the consulted rewrite row and seeds consult{rewrite}", async () => {
  const generation = await composed({
    hooks: {
      PreToolUse: [{ command: ["./mask.sh"], timeoutMs: 1_000, do: "rewrite", fields: ["command"] }],
      // UserPromptSubmit defaults its rewrite fields to the point's `body`.
      UserPromptSubmit: [{ command: ["./mask.sh"], timeoutMs: 2_000, do: "rewrite" }],
    },
  });
  const hooksRows = generation.rows.filter((row) => row.id.startsWith("hooks-json/"));
  expect(hooksRows).toEqual([
    expectedCommandRow("hooks-json/tool.pre#1", "tool.pre", "rewrite", {
      ref: Bundle.HOOK_PROCESS_REF,
      fields: ["command"],
      params: { event: "PreToolUse", command: ["./mask.sh"], timeoutMs: 1_000, fields: ["command"] },
    }, 500),
    {
      id: "hooks-json/prompt.pre#1",
      on: "prompt.pre",
      when: {},
      do: "rewrite",
      how: {
        ref: Bundle.HOOK_PROCESS_REF,
        fields: ["body"],
        params: { event: "UserPromptSubmit", command: ["./mask.sh"], timeoutMs: 2_000, fields: ["body"] },
      },
      order: 501,
    },
  ]);
  // The live policy plane seeds the consult verdict WITH the rewrite flag —
  // hook/process is a consultant, so a transform seed would refuse the
  // generation (unknown_ref) and the external rewrite could never execute.
  expect(
    gateRowPolicySeeds({ rows: hooksRows, handlers: generation.handlers }).map(
      (seed) => seed.verdict.value,
    ),
  ).toEqual([
    {
      type: "consult",
      ref: Bundle.HOOK_PROCESS_REF,
      rewrite: true,
      config: { event: "PreToolUse", command: ["./mask.sh"], timeoutMs: 1_000, fields: ["command"] },
    },
    {
      type: "consult",
      ref: Bundle.HOOK_PROCESS_REF,
      rewrite: true,
      config: { event: "UserPromptSubmit", command: ["./mask.sh"], timeoutMs: 2_000, fields: ["body"] },
    },
  ]);
  // Misdeclared command rewrites refuse typed at bundle compile, fail-closed.
  expectRefusal(
    () => hooksJsonBundle({ PreToolUse: [{ command: ["./x"], timeoutMs: 1_000, do: "rewrite" }] }),
    "missing_rewrite_fields",
  );
  expectRefusal(
    () => hooksJsonBundle({
      SessionStart: [{ command: ["./x"], timeoutMs: 1_000, do: "rewrite", fields: ["body"] }],
    }),
    "session_start_rewrite",
  );
  expectRefusal(
    () => hooksJsonBundle({ PreToolUse: [{ command: ["./x"], timeoutMs: 1_000, fields: ["command"] }] }),
    "invalid_config",
  );
});

test("no hooks config composes the bundle with zero rows and the action input admitted", async () => {
  const generation = await composed();
  expect(generation.bundles).toEqual([
    "file", "bash", "eval", "monitor", "cron", "hooks-json", "delegation-policy", "approval-policy",
    "send-message", "provision", "completion", "compaction-summarizer", "compaction-strategy",
  ]);
  expect(generation.rows.filter((row) => row.id.startsWith("hooks-json/"))).toEqual([]);
  expect(generation.inputs).toEqual(["action"]);
  expect(Object.keys(generation.kinds)).toEqual(["action"]);
});

test("readHooksJson refuses an unmapped event, non-JSON bytes and an unreadable path, each typed", () => {
  const dir = suite.tempDir("hooks-json-read-");
  const unmapped = join(dir, "unmapped.json");
  writeFileSync(unmapped, JSON.stringify({ Notification: [{ command: ["./x"] }] }));
  // M-4: each source is a typed refusal, rather than a prose-only failure.
  expectRefusal(() => readHooksJson(unmapped), "unmapped_event");
  expect(() => readHooksJson(unmapped)).toThrow(/Notification/);
  const invalid = join(dir, "invalid.json");
  writeFileSync(invalid, "not json");
  expectRefusal(() => readHooksJson(invalid), "not_json");
  expectRefusal(() => readHooksJson(join(dir, "absent.json")), "unreadable_path");
  const badShape = join(dir, "bad-shape.json");
  writeFileSync(badShape, JSON.stringify({ PreToolUse: [{ command: [] }] }));
  expectRefusal(() => readHooksJson(badShape), "invalid_config");
  // A guard entry on a tool event without declared fields, and any guard on
  // the no-rewrite SessionStart point, each refuse typed at bundle compile.
  expectRefusal(
    () => hooksJsonBundle({ PreToolUse: [{ guard: "secrets-guard" }] }),
    "missing_rewrite_fields",
  );
  expectRefusal(
    () => hooksJsonBundle({ SessionStart: [{ guard: "secrets-guard" }] }),
    "session_start_rewrite",
  );
  // The default call bound applies when the file omits timeoutMs.
  const defaults = join(dir, "defaults.json");
  writeFileSync(defaults, JSON.stringify({ PreToolUse: [{ command: ["./guard.sh"] }] }));
  expect(readHooksJson(defaults)).toEqual({
    PreToolUse: [{ command: ["./guard.sh"], timeoutMs: 5_000 }],
  });
});

test("secretsGuard masks secret-shaped tokens recursively and leaves clean values byte-identical", () => {
  const input = {
    command: "curl -H 'x-key: sk-abcdef123456789' https://api",
    nested: { aws: "AKIAABCDEFGHIJKLMNOP", note: "plain text stays" },
    list: ["ghp_0123456789abcdefghij", 42, null, true],
  };
  expect(secretsGuard(input, null)).toEqual({
    command: "curl -H 'x-key: [redacted]' https://api",
    nested: { aws: "[redacted]", note: "plain text stays" },
    list: ["[redacted]", 42, null, true],
  });
  expect(secretsGuard("no secrets here", null)).toBe("no secrets here");
});

test("off cascades: action roots hook and hooks-json off; hook roots hooks-json off", async () => {
  const offAction = await composed({ off: ["action"] });
  expect(offAction.disabled).toEqual([
    { name: "action", because: "action" },
    { name: "hook", because: "action" },
    { name: "hooks-json", because: "action" },
    // #1258: delegation-policy requires the action seam, so it cascades too.
    { name: "delegation-policy", because: "action" },
  ]);
  expect(offAction.inputs).toEqual([]);
  const offHook = await composed({ off: ["hook"] });
  expect(offHook.disabled).toEqual([
    { name: "hook", because: "hook" },
    { name: "hooks-json", because: "hook" },
  ]);
  expect(offHook.bundles).toEqual([
    "file", "bash", "eval", "monitor", "cron", "delegation-policy", "approval-policy",
    "send-message", "provision", "completion", "compaction-summarizer", "compaction-strategy",
  ]);
});

test("without the hook capability the bundle refuses at compose as seam_missing", () => {
  const compose = () =>
    Bundle.composeSync(
      Bundle.Manifest.define({ capabilities: [], bundles: [hooksJsonBundle()], off: [] }),
    );
  expect(compose).toThrow(Bundle.ComposeRefused);
  expect(compose).toThrow(expect.objectContaining({ code: "seam_missing" }));
});

test("a guard rewrite row seeds the live transform; a command gate row seeds the consult verdict (H-1)", async () => {
  const guarded = await composed({
    hooks: { PreToolUse: [{ guard: "secrets-guard", fields: ["command"] }] },
  });
  const seeds = gateRowPolicySeeds({
    rows: guarded.rows.filter((row) => row.id.startsWith("hooks-json/")),
    handlers: guarded.handlers,
  });
  expect(seeds).toEqual([
    {
      name: "hooks-json/tool.pre#1",
      kind: "tool",
      phase: "pre",
      priority: 500,
      match: { encodingVersion: 1, value: {} },
      verdict: {
        encodingVersion: 1,
        value: {
          type: "transform",
          ref: SECRETS_GUARD_REF,
          config: { event: "PreToolUse", fields: ["command"] },
        },
      },
    },
  ]);
  const command = await composed({
    hooks: { PreToolUse: [{ command: ["./guard.sh"], timeoutMs: 1_000 }] },
  });
  // #1256 r2 H-1: the command gate row seeds the consult verdict — the named
  // async service the compiled snapshot resolves through `hook/process`.
  expect(
    gateRowPolicySeeds({
      rows: command.rows.filter((row) => row.id.startsWith("hooks-json/")),
      handlers: command.handlers,
    }),
  ).toEqual([
    {
      name: "hooks-json/tool.pre#1",
      kind: "tool",
      phase: "pre",
      priority: 500,
      match: { encodingVersion: 1, value: {} },
      verdict: {
        encodingVersion: 1,
        value: {
          type: "consult",
          ref: Bundle.HOOK_PROCESS_REF,
          config: { event: "PreToolUse", command: ["./guard.sh"], timeoutMs: 1_000 },
        },
      },
    },
  ]);
});

test("startOpenOmni compiles the Owner's hooks file at boot and seeds its row into the catalog", async () => {
  const dir = suite.tempDir("hooks-json-boot-");
  const hooksPath = join(dir, "hooks.json");
  writeFileSync(
    hooksPath,
    JSON.stringify({ PreToolUse: [{ guard: "secrets-guard", fields: ["command"] }] }),
  );
  const config = suite.config("hooks-json-boot-state-", { hooksPath });
  await suite.boot({ config, llm: { resolveModel: fakeProviderModel } });
  if (config.catalogPath === undefined) throw new Error("suite config always sets catalogPath");
  const database = new Database(config.catalogPath, { readonly: true });
  try {
    const names = database
      .query<{ name: string }, []>(
        "SELECT DISTINCT name FROM policy WHERE name LIKE 'hooks-json/%'",
      )
      .all()
      .map((row) => row.name);
    expect(names).toEqual(["hooks-json/tool.pre#1"]);
  } finally {
    database.close();
  }
});

test("a hooks file with an unmapped event refuses the boot before any listener exists", async () => {
  const dir = suite.tempDir("hooks-json-refuse-");
  const hooksPath = join(dir, "hooks.json");
  writeFileSync(hooksPath, JSON.stringify({ Stop: [{ command: ["./x"] }] }));
  const config = suite.config("hooks-json-refuse-state-", { hooksPath });
  // M-4: the TYPED refusal object crosses the boot boundary — class, code and
  // the offending event name, not a prose match.
  const boot = suite.boot({ config, llm: { resolveModel: fakeProviderModel } });
  await expect(boot).rejects.toBeInstanceOf(AppInvariantError);
  await expect(boot).rejects.toThrow(expect.objectContaining({ code: "unmapped_event" }));
  await expect(boot).rejects.toThrow(/Stop/);
});

/**
 * One deterministic run through the REAL index.ts wiring: boot with every
 * bundle on (pinned clock, counting entropy), run one turn, then swap the
 * composed holder to the `off: ["hook"]` composition — exactly what
 * `provision{bundle_disable}`'s recompose commit does — and run the next
 * turn. Rotation is strictly between turns; the adoption journals the
 * cascade. Returns the turn session's full journal chain.
 */
async function offCascadeConfigureRows(prefix: string) {
  let counter = 0;
  const config = suite.config(prefix);
  const watch = createWatchPlane();
  const onManifest = appManifest({ alarm: watch.contract, wake: watch.wake, alarms: () => undefined, tools: () => undefined });
  const offManifest = appManifest({ alarm: watch.contract, wake: watch.wake, alarms: () => undefined, tools: () => undefined, off: ["hook"] });
  const holder = composedHolderOf({
    manifest: onManifest,
    generation: Bundle.composeSync(onManifest),
  }, alarmPortsSlot());
  let calls = 0;
  const runtime = gatewayRuntime({
    observations: Bus,
    composed: holder,
    ...(config.catalogPath === undefined ? {} : { catalogPath: config.catalogPath }),
    ...(config.sessionsDir === undefined ? {} : { sessionsDir: config.sessionsDir }),
    now: () => 1_700_000_000_000,
    clusterClock: "injected",
    entropy: testEntropy(() => `e-${++counter}`),
    llm: Layer.unwrap(
      Effect.map(Layer.build(LlmLive), (live) =>
        Layer.succeed(Core.Llm, {
          ...Context.get(live, Core.Llm),
          resolveModel: fakeProviderModel,
          run: (input: RunInput, sink: Sink) =>
            Effect.sync(() => {
              calls += 1;
              sink.onMessage(
                assistantMessage(input, {
                  id: `hook-reply-${calls}`,
                  text: `ready ${calls}`,
                  createdAt: 1_700_000_000_000,
                }),
              );
              return { type: "stop" as const };
            }),
        }),
      ),
    ),
  });
  const app = await suite.boot({ config, runtime });
  const { plane, ws } = await ownerConnection(app);
  const reply1 = nextResidentTurn(plane);
  ws.send(JSON.stringify({ type: "message", eventId: "hooks-on-turn", text: "warm" }));
  expect(await reply1).toMatchObject({ text: "ready 1" });
  // The recompose commit: the Owner's off-list now cascades hook off.
  holder.swap({ manifest: offManifest, generation: Bundle.composeSync(offManifest) });
  const reply2 = nextResidentTurn(plane);
  ws.send(JSON.stringify({ type: "message", eventId: "hooks-off-turn", text: "go" }));
  expect(await reply2).toMatchObject({ text: "ready 2" });
  const sessions = plane
    .listSessions()
    .filter((row) => row.role === "resident" && row.id !== "gateway-ingress");
  expect(sessions).toHaveLength(1);
  const sessionId = sessions[0]?.id ?? "";
  // The adopted generation dropped the cascaded bundle.
  const adopted = plane.openKernel(sessionId).latestGenerationFor(sessionId);
  expect([...adopted.bundles].sort()).toEqual([
    "approval-policy", "bash", "compaction-strategy", "compaction-summarizer", "completion", "cron",
    "delegation-policy", "eval", "file", "monitor", "provision", "send-message",
  ]);
  if (config.sessionsDir === undefined) throw new Error("suite config always sets sessionsDir");
  const database = new Database(join(config.sessionsDir, `${sessionId}.sqlite`), {
    readonly: true,
  });
  try {
    return database
      .query<
        {
          id: string;
          ts: number;
          parent_id: string | null;
          kind: string;
          intent: string;
          effect: string;
          ordinal: number;
          action_hash: string;
        },
        [string]
      >(
        "SELECT id, ts, parent_id, kind, intent, effect, ordinal, action_hash FROM action WHERE session_id = ? ORDER BY ordinal ASC",
      )
      .all(sessionId);
  } finally {
    database.close();
  }
}

test("capability-removed one-turn gate: the cascade is journaled in session.configure and the bytes are golden-stable", async () => {
  const first = await offCascadeConfigureRows("hooks-json-off-a-");
  await suite.cleanup();
  const second = await offCascadeConfigureRows("hooks-json-off-b-");
  // The compose adoption row records the cascade with its root `because`.
  const composeIntent = z.object({
    operation: z.string().optional(),
    disabled: z.array(z.object({ name: z.string(), because: z.string() })).optional(),
  });
  const compose = first
    .map((row) => decodeJournalJson(row.intent, composeIntent))
    .find((intent) => intent.operation === "compose");
  expect(compose?.disabled).toEqual([
    { name: "hook", because: "hook" },
    { name: "hooks-json", because: "hook" },
  ]);
  // Golden-stable: two runs from pinned clock/entropy journal identical bytes.
  expect(second).toEqual(first);
});

/** The scripted hook: denies any decision input containing the argv trigger (default "forbidden"). */
const PROMPT_HOOK_SCRIPT = `
const trigger = process.argv[2] ?? "forbidden";
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let cut;
  while ((cut = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 1);
    if (line.length === 0) continue;
    const request = JSON.parse(line);
    const result = JSON.stringify(request.decisionInput).includes(trigger)
      ? { type: "gate", verdict: "deny", reason: "hook_refused" }
      : { type: "gate", verdict: "allow" };
    console.log(JSON.stringify({ id: request.id, result }));
  }
}
`;

function commandHookConfig(
  directoryPrefix: string,
  statePrefix: string,
  scriptName: string,
  body: string,
  event: "UserPromptSubmit" | "SessionStart" = "UserPromptSubmit",
  args: string[] = [],
) {
  const dir = suite.tempDir(directoryPrefix);
  const script = join(dir, scriptName);
  writeFileSync(script, body);
  const hooksPath = join(dir, "hooks.json");
  writeFileSync(hooksPath, JSON.stringify({ [event]: [{ command: [process.execPath, script, ...args], timeoutMs: 30_000 }] }));
  return suite.config(statePrefix, { hooksPath });
}

test("H-1/M-2 e2e: a UserPromptSubmit command hook gates the REAL prompt path and journals durable policy.decision rows", async () => {
  const config = commandHookConfig("hooks-json-e2e-", "hooks-json-e2e-state-", "prompt-hook.js", PROMPT_HOOK_SCRIPT);
  let calls = 0;
  const { plane, ws } = await bootOwner({
    config,
    llm: responseLlm(() => ({ id: `hook-e2e-${calls}`, text: `ok ${calls}`, createdAt: Date.now() }), () => { calls += 1; }),
  });

  // Subscribe to the exact committed fact BEFORE sending: the denied prompt's
  // durable policy.decision row (fail-closed consult verdict folded to deny).
  const { signal: denied, unsubscribe } = committedDecision(plane, "denied policy.decision", "verdict", "deny");
  try {
    ws.send(JSON.stringify({ type: "message", eventId: "hook-deny", text: "read the forbidden file" }));
    const denial = await denied.promise;

    // The denied prompt never reached the model; the next allowed one does.
    const reply = nextResidentTurn(plane);
    ws.send(JSON.stringify({ type: "message", eventId: "hook-allow", text: "hello there" }));
    expect(await reply).toMatchObject({ text: "ok 1" });
    expect(calls).toBe(1);

    // Durable evidence: the session chain holds BOTH decisions — the hook's
    // deny (with its reason and consulted payload) and the later allow.
    if (config.sessionsDir === undefined) throw new Error("suite config always sets sessionsDir");
    const database = new Database(join(config.sessionsDir, `${denial.sessionId}.sqlite`), { readonly: true });
    try {
      const decisions = decisionRows(database, "prompt.pre");
      expect(decisions.map((decision) => decision.verdict)).toEqual(["deny", "allow"]);
      const denyGate = decisions[0]?.gate;
      expect(denyGate?.consulted.map(({ ref, payload }) => [ref, payload?.verdict, payload?.reason])).toEqual([
        [Bundle.HOOK_PROCESS_REF, "deny", "hook_refused"],
      ]);
      const allowGate = decisions[1]?.gate;
      expect(allowGate?.consulted.map(({ ref, payload }) => [ref, payload?.verdict])).toEqual([
        [Bundle.HOOK_PROCESS_REF, "allow"],
      ]);
    } finally {
      database.close();
    }
  } finally {
    unsubscribe();
  }
});

test("C-1: a SessionStart hook denying tools.add fails the facade configure op fail-closed", async () => {
  const config = commandHookConfig("hooks-json-configure-", "hooks-json-configure-state-", "configure-hook.js", PROMPT_HOOK_SCRIPT, "SessionStart", ["tools.add"]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      // The turn HOLDS at the model boundary: the session facade (tools.add)
      // exists only while a live turn is registered.
      run: (input: RunInput, sink: Sink) =>
        Effect.promise(async () => {
          entered.resolve();
          await release.promise;
          sink.onMessage(
            assistantMessage(input, { id: "cfg-1", text: "ok 1", createdAt: Date.now() }),
          );
          return { type: "stop" as const };
        }),
    },
  });
  const { plane, ws } = await ownerConnection(app);
  const reply = nextResidentTurn(plane);
  ws.send(JSON.stringify({ type: "message", eventId: "cfg-1", text: "hello" }));
  await entered.promise;
  try {
    const row = plane.listSessions().find((session) => session.id !== "gateway-ingress");
    if (row === undefined) throw new Error("missing resident session");
    const handle = app.sessions.get(row.id);
    if (handle === undefined) throw new Error("missing live session");
    const before = plane.openKernel(row.id).latestGenerationFor(row.id).generation;
    // The hook consults on session.open and denies the tools.add op: the
    // facade configure fails typed, and NO generation advance is committed.
    // M-4: assert the typed failure's _tag and machine fields via Effect.flip,
    // never String(rejection).
    const refusal = await runAppEffect(app.runtime, Effect.flip(handle.tools.add([])));
    expect(refusal).toMatchObject({
      _tag: "AgentFailure",
      operation: "session.configure",
      cause: "denied",
    });
    expect(plane.openKernel(row.id).latestGenerationFor(row.id).generation).toBe(before);
  } finally {
    release.resolve();
  }
  expect(await reply).toMatchObject({ text: "ok 1" });
});

test("H-3 e2e: a UserPromptSubmit secrets-guard rewrite of body reaches the model", async () => {
  const dir = suite.tempDir("hooks-json-rewrite-");
  const hooksPath = join(dir, "hooks.json");
  // UserPromptSubmit guard defaults to the point registry's `body` field.
  writeFileSync(hooksPath, JSON.stringify({ UserPromptSubmit: [{ guard: "secrets-guard" }] }));
  const config = suite.config("hooks-json-rewrite-state-", { hooksPath });
  const seen: string[] = [];
  const { plane, ws } = await bootOwner({
    config,
    llm: responseLlm(() => ({ id: "rw-1", text: "done", createdAt: Date.now() }), (input) => { seen.push(JSON.stringify(input)); }),
  });
  const reply = nextResidentTurn(plane);
  const secret = "use sk-abcdef123456789 to call the api";
  ws.send(JSON.stringify({ type: "message", eventId: "rw-turn", text: secret }));
  expect(await reply).toMatchObject({ text: "done" });
  // The REWRITTEN body is what the model read: the secret never crossed the
  // model boundary, and the delivered turn input carries the masked bytes.
  const transcript = seen.join("\n");
  expect(transcript).toContain("[redacted]");
  expect(transcript).not.toContain("sk-abcdef123456789");
});

/** A hook that always answers a REWRITE on its consulted command (gate) row. */
const REWRITE_RESPONSE_SCRIPT = `
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let cut;
  while ((cut = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 1);
    if (line.length === 0) continue;
    const request = JSON.parse(line);
    const result = { type: "rewrite", fields: { body: "scrubbed" } };
    console.log(JSON.stringify({ id: request.id, result }));
  }
}
`;

test("H-3 e2e: a hook response incompatible with its row folds to deny with one recorded fact", async () => {
  const config = commandHookConfig("hooks-json-incompatible-", "hooks-json-incompatible-state-", "rewrite-hook.js", REWRITE_RESPONSE_SCRIPT);
  let calls = 0;
  const { plane, ws } = await bootOwner({
    config,
    llm: responseLlm(() => ({ id: "inc-1", text: "never", createdAt: Date.now() }), () => { calls += 1; }),
  });
  // Subscribe to the committed denial BEFORE sending (no timing luck).
  const { signal: denied, unsubscribe } = committedDecision(plane, "incompatible denial", "verdict", "deny");
  try {
    ws.send(JSON.stringify({ type: "message", eventId: "inc-turn", text: "hello" }));
    const denial = await denied.promise;
    const node = plane.openKernel(denial.sessionId).actionById(denial.id);
    const decision = z
      .object({
        verdict: z.literal("deny"),
        gate: z.object({
          facts: z.array(z.object({ code: z.string() })),
          consulted: z.array(z.object({ ref: z.string() })),
        }),
      })
      .parse(node?.intent.value);
    // The rewrite-shaped answer on a gate row is incompatible: ONE recorded
    // fact, folded to deny — never "missing verdict => allow".
    const effect = z.object({ reason: z.string() }).parse(node?.effect.value);
    expect(effect.reason).toBe("incompatible_response");
    expect(decision.gate.facts.map((fact) => fact.code)).toEqual(["incompatible_response"]);
    expect(decision.gate.consulted.map((entry) => entry.ref)).toEqual([Bundle.HOOK_PROCESS_REF]);
    // The denied prompt never reached the model.
    expect(calls).toBe(0);
  } finally {
    unsubscribe();
  }
});

test("H-3 e2e: a PreToolUse secrets-guard rewrite of bash.command reaches the executor", async () => {
  const generation = await composed({
    hooks: { PreToolUse: [{ guard: "secrets-guard", fields: ["command"] }] },
  });
  const guardHandler = generation.handlers.get(SECRETS_GUARD_REF);
  if (guardHandler === undefined)
    throw new Error("composed secrets-guard transformer missing");
  const transformer = guardHandler as Core.NamedTransformer;
  if (typeof transformer.apply !== "function")
    throw new Error("composed secrets-guard transformer missing");
  const apply = transformer.apply;
  const registry: Core.HandlerTable = {
    ...Core.KERNEL_POLICY_REGISTRY,
    transformers: [
      ...Core.KERNEL_POLICY_REGISTRY.transformers,
      { name: SECRETS_GUARD_REF, apply },
    ],
  };
  const seeds = gateRowPolicySeeds({
    rows: generation.rows.filter((row) => row.id.startsWith("hooks-json/")),
    handlers: generation.handlers,
  });
  await isolated(Effect.gen(function* () {
    const id = "hooks-json-bash-rewrite";
    const kernel = isolatedLedger().kernel;
    const executed: string[] = [];
    const definition = Core.defineTool({
      name: "bash", description: "Run a command", category: "query",
      input: z.object({ command: z.string() }), output: z.string(),
      visibility: { model: ["resident"], cell: ["resident"] },
      execute: async ({ command }) => { executed.push(command); return command; },
      render: (_input, output) => output,
    });
    const materialized = yield* kernel.materialize({
      actionId: `${id}:configure`,
      at: 100,
      system: { blocks: [], preset: "" },
      policyGeneration: 1,
      parentId: null,
      role: "resident",
      tools: [],
      id,
    });
    const lease = yield* kernel.adoptFence({
      sessionId: id,
      owner: id,
      fence: materialized.row.fence + 1,
    });
    let sequence = 0;
    const executor = testExecutor({
      policy: Core.compilePolicySnapshot({
        registry,
        generation: 1,
        rows: [
          ...Core.SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })),
          ...seeds.map((seed) => ({ ...seed, generation: 1 })),
        ],
      }),
      identity: { parentActionId: `${id}:configure`, role: "resident", sessionId: id },
      random: () => 0,
      observations: { publish: () => undefined },
      entropy: () => `${id}:${++sequence}`,
      clock: () => 100,
      ledger: {
        ...executionReads(kernel, id),
        commit: (action) =>
          kernel.commit({
            state: "running",
            actions: [action],
            now: 100,
            expectedRevision: kernel.row(id).revision,
            fence: lease.fence,
            owner: id,
            sessionId: id,
          }).pipe(Effect.map(({ receipts }) => {
            const receipt = receipts[0];
            if (receipt === undefined) throw new Error("missing receipt");
            return receipt;
          })),
      },
    });
    const dispatcher = runAgentSync(
      Bundle.createDispatcher({ executor }).pipe(Effect.provide(catalogLayer([definition]))),
    );
    const result = yield* dispatcher.execute(
      { id: "bash-call", tool: "bash", input: { command: "curl -H 'x-key: sk-abcdef123456789' https://api" } },
      { sessionId: id, turnId: "turn" },
    );
    // The EXECUTOR received the rewritten bytes: the admitted intent row
    // carries the masked command and the original as `originalArgs`.
    expect(executed).toEqual(["curl -H 'x-key: [redacted]' https://api"]);
    expect(result).toMatchObject({ content: "curl -H 'x-key: [redacted]' https://api" });
  }));
});

/**
 * Holds its FIRST request past the deadline and PUSHES a barrier receipt
 * (HTTP POST to argv[2]) once it holds; SIGUSR2 flushes the held reply.
 * The test synchronizes on the push and on committed facts — no file
 * polling, no fixed sleeps (#1256 r4 H-1).
 */
const LATE_SCRIPT = `
const barrier = process.argv[2];
const held = [];
let first = true;
const flushHeld = () => {
  for (const id of held.splice(0)) console.log(JSON.stringify({ id, result: { type: "gate", verdict: "allow" } }));
};
process.on("SIGUSR2", flushHeld);
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let cut;
  while ((cut = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 1);
    if (line.length === 0) continue;
    const request = JSON.parse(line);
    if (first) {
      first = false;
      held.push(request.id);
      await fetch(barrier, { method: "POST", body: JSON.stringify({ pid: process.pid, id: request.id }) });
      continue;
    }
    console.log(JSON.stringify({ id: request.id, result: { type: "gate", verdict: "allow" } }));
  }
}
`;

test("H-3 e2e: a hook reply that lands after its call timed out re-enters through the production late door and closes STALE past the compaction head", async () => {
  const dir = suite.tempDir("hooks-json-late-");
  const script = join(dir, "late-hook.js");
  writeFileSync(script, LATE_SCRIPT);
  // The child-receipt barrier: the child POSTS here the moment it HOLDS its
  // first request — a push the test awaits, never a poll.
  const heldRequest = Promise.withResolvers<{ pid: number; id: string }>();
  const barrier = Bun.serve({
    port: 0,
    fetch: async (request) => {
      heldRequest.resolve(z.object({ pid: z.number(), id: z.string() }).parse(await request.json()));
      return new Response("ok");
    },
  });
  suite.defer(() => void barrier.stop(true));
  const hooksPath = join(dir, "hooks.json");
  writeFileSync(
    hooksPath,
    JSON.stringify({
      UserPromptSubmit: [
        // Ten minutes: wall time can never fire this deadline inside the test
        // window — only the injected TestClock below can, which PROVES the
        // deadline runs on the injected clock (#1256 r5 H-2).
        { command: [process.execPath, script, `http://127.0.0.1:${barrier.port}/`], timeoutMs: 600_000 },
      ],
    }),
  );
  const config = suite.config("hooks-json-late-state-", {
    hooksPath,
    compactionSummarizer: false,
  });
  // #1256 r5 H-2: the call deadline runs on an injected TestClock — it fires
  // only when this test advances it, never on wall time.
  const clock = testClockRuntime();
  suite.defer(() => clock.dispose());
  const hookClock = await clock.run(Clock.clockWith(Effect.succeed));
  // A real mid-run compaction (#1256 r5 H-3): once `constrained` flips, the
  // provider reports a 700-token context at 650 used, so the production run
  // compacts between attempts — the committed head the late cursor is stale
  // against.
  let calls = 0;
  let constrained = false;
  let constrainedCalls = 0;
  const app = await suite.boot({
    config,
    hookClock,
    llm: {
      resolveModel: (model) =>
        Effect.map(fakeProviderModel(model), (resolved) => ({
          limit: { context: constrained ? 700 : 100_000 },
          ...resolved,
        })),
      run: (input: RunInput, sink: Sink) =>
        Effect.sync(() => {
          calls += 1;
          if (constrained) constrainedCalls += 1;
          const reply: AssistantMessageOptions = {
            call: calls,
            reason: constrained && constrainedCalls === 1 ? "tool-calls" : "stop",
            text: `pong ${calls} ${"filler ".repeat(30)}`,
            tokens: constrained
              ? { cache: { read: 0, write: 0 }, reasoning: 0, output: 1, input: 650 }
              : undefined,
          };
          sink.onMessage(
            assistantMessage(input, reply),
          );
          return { type: "stop" as const };
        }),
    },
  });
  const { plane, ws } = await ownerConnection(app);
  // Subscribe BEFORE acting: the late reply must surface as a committed row
  // sourced hook.late — the one `deliver` door, never this turn's decision.
  const lateRow = eventSignal<{ sessionId: string; id: string }>("hook.late action row", 15_000);
  const denied = eventSignal<string>("timed-out prompt denial", 15_000);
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    const node = plane.openKernel(event.sessionId).actionById(event.id);
    const rendered = JSON.stringify({ intent: node?.intent.value ?? null, effect: node?.effect?.value ?? null });
    if (rendered.includes("hook.late")) lateRow.resolve({ sessionId: event.sessionId, id: event.id });
    if (event.kind === "policy.decision" && rendered.includes('"verdict":"deny"')) denied.resolve(event.sessionId);
  });
  try {
    // Turn 1: the hook HOLDS the call past its deadline — fail-closed deny.
    ws.send(JSON.stringify({ type: "message", eventId: "late-hold", text: "hold me please" }));
    // Ordered barriers, all pushes: the child's receipt (it HOLDS request
    // #1), THEN the deadline — advanced deterministically on the injected
    // TestClock, so the call times out exactly when this test says so — THEN
    // the committed deny decision (the settled timeout's fact). Only after
    // all three does the flush happen, so the held reply is late BY
    // CONSTRUCTION: no wall-clock is anywhere in the ordering.
    const held = await heldRequest.promise;
    await clock.adjust(600_000);
    const sessionId = await denied.promise;
    const kernel = () => plane.openKernel(sessionId);
    // Seed turns, then the constrained turn: the production run executes a
    // REAL compaction (committed head) while the first hook reply stays held.
    for (let index = 0; index < 6; index += 1) {
      const reply = nextResidentTurn(plane);
      ws.send(
        JSON.stringify({ type: "message", eventId: `late-seed-${index}`, text: `seed ${index} ${"filler ".repeat(30)}` }),
      );
      await reply;
    }
    constrained = true;
    const compacted = nextResidentTurn(plane);
    ws.send(JSON.stringify({ type: "message", eventId: "late-compact", text: "compact now" }));
    await compacted;
    constrained = false;
    await untilCommitted(() => kernel().compactionHead(sessionId) > 0, "compaction never executed");
    const head = kernel().compactionHead(sessionId);
    // AFTER the compaction, the flush: the held reply traverses the
    // production late door (`deliverLate` → entity Deliver) as an action row.
    process.kill(held.pid, "SIGUSR2");
    const row = await lateRow.promise;
    expect(row.sessionId).toBe(sessionId);
    const node = kernel().actionById(row.id);
    const rendered = JSON.stringify({ intent: node?.intent.value ?? null, effect: node?.effect?.value ?? null });
    // The row is sourced hook.late; its content carries the hook ref, the
    // typed late result and the CALL-time after cursor.
    expect(rendered).toContain("hook.late");
    expect(rendered).toContain(Bundle.HOOK_PROCESS_REF);
    expect(rendered).toContain('\\"type\\":\\"gate\\"');
    // The committed intent carries the CALL-time cursor — captured at turn 1,
    // strictly BEHIND the executed compaction head.
    const intentAfter = z.object({ after: z.number().optional() }).parse(node?.intent.value).after;
    if (typeof intentAfter !== "number") throw new Error("late row intent missing its after cursor");
    expect(intentAfter).toBeLessThan(head);
    // The next boundary closes it STALE: a consumedStale fact on the turn
    // chain, zero ordinary delivery, an empty pending fold. (The pending
    // followUp action wakes the entity's own drain; the extra prompt below
    // only guarantees a boundary has run before the assertions read the file.)
    const closing = nextResidentTurn(plane);
    ws.send(JSON.stringify({ type: "message", eventId: "late-close", text: "after the flush" }));
    await closing;
    if (config.sessionsDir === undefined) throw new Error("fixture config missing sessionsDir");
    const database = new Database(join(config.sessionsDir, `${sessionId}.sqlite`), { readonly: true });
    try {
      const actions = database.query<JournalActionRow, []>(
        "SELECT kind, intent FROM action ORDER BY ordinal ASC",
      ).all();
      const delivered = z.object({ deliveryId: z.string().optional() });
      const terminal = z.object({ consumedStale: z.array(z.string()).optional() });
      expect(actions.filter(({ intent }) => decodeJournalJson(intent, delivered).deliveryId === row.id)).toEqual([]);
      expect(actions
        .filter(({ kind }) => kind === "turn")
        .some(({ intent }) => decodeJournalJson(intent, terminal).consumedStale?.includes(row.id)))
        .toBe(true);
    } finally {
      database.close();
    }
    expect(kernel().pendingMessages(sessionId)).toEqual([]);
  } finally {
    unsubscribe();
  }
}, 30_000);

/** Logs its PID at startup, then answers allow to every request. */
const PID_LOG_SCRIPT = `
const fs = require("node:fs");
fs.appendFileSync(process.argv[2], process.pid + "\\n");
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let cut;
  while ((cut = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 1);
    if (line.length === 0) continue;
    const request = JSON.parse(line);
    console.log(JSON.stringify({ id: request.id, result: { type: "gate", verdict: "allow" } }));
  }
}
`;

test("H-1 e2e: a steering prompt denied mid-turn is refused at the RUN boundary and journals the deny", async () => {
  const config = commandHookConfig("hooks-json-boundary-", "hooks-json-boundary-state-", "prompt-hook.js", PROMPT_HOOK_SCRIPT);
  let calls = 0;
  let residentSessionId: string | undefined;
  let steer: (sessionId: string) => Promise<{ readonly seq: number; readonly existed: boolean }> = () =>
    Promise.reject(new Error("steer door wired after boot"));
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input: RunInput, sink: Sink) =>
        Effect.promise(async () => {
          calls += 1;
          residentSessionId = input.trace.sessionId;
          if (calls === 1) {
            // Mid-turn: push a steer-delivery prompt through the entity's one
            // deliver door and AWAIT its receipt — the delivery row is journaled
            // before this model step returns, so the after_tools boundary of
            // THIS turn must drain it through the run's own policy port.
            await steer(input.trace.sessionId);
            sink.onMessage(pendingToolMessage(input, "boundary-step-1", "boundary-call-1", "bash", "echo boundary"));
            return { type: "stop" as const };
          }
          sink.onMessage(
            assistantMessage(input, { id: "boundary-step-2", text: "never reached", createdAt: Date.now() }),
          );
          return { type: "stop" as const };
        }),
    },
  });
  const plane = await planeOf(app.runtime);
  steer = (sessionId: string) =>
    runAppEffect(
      app.runtime,
      Effect.scoped(
        Effect.gen(function* () {
          const makeClient = yield* Core.SessionEntity.client;
          return yield* makeClient(sessionId).Deliver({
            kind: "prompt",
            body: JSON.stringify({ content: "the forbidden steer", delivery: "steer" }),
            source: JSON.stringify({ kind: "test.steer" }),
            idempotencyKey: "boundary-steer-1",
          });
        }),
      ),
    );
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, []);
  const terminal = nextResidentTurn(plane, 15_000);
  ws.send(JSON.stringify({ type: "message", eventId: "boundary-open", text: "hello boundary" }));
  const outcome = await terminal;
  // The refusal happened MID-TURN at the run boundary (#1256 r3): the model
  // ran once; the denied steering failed the turn, step two never fired.
  expect(calls).toBe(1);
  expect(JSON.stringify(outcome)).toContain("hook_refused");
  // Durable evidence: the deny decision names the consulted hook process.
  if (config.sessionsDir === undefined) throw new Error("suite config always sets sessionsDir");
  const sessionId = residentSessionId;
  if (sessionId === undefined) throw new Error("the model step never ran");
  const decisions = sessionDecisions(config, sessionId, "prompt.pre");
  const deny = decisions.find((decision) => decision.verdict === "deny");
  expect(deny?.gate?.consulted.map(({ ref, payload }) => [ref, payload?.verdict, payload?.reason])).toEqual([
    [Bundle.HOOK_PROCESS_REF, "deny", "hook_refused"],
  ]);
});

test("M-2 e2e: two rows with the same command and different timeouts spawn ONE PID in the real boot; teardown kills it", async () => {
  const dir = suite.tempDir("hooks-json-pid-");
  const script = join(dir, "pid-hook.js");
  writeFileSync(script, PID_LOG_SCRIPT);
  const pidLog = join(dir, "pids.log");
  const hooksPath = join(dir, "hooks.json");
  // One PID per distinct COMMAND per generation: timeouts are per-call
  // parameters, never pool identity (#1256 r3 M-2).
  writeFileSync(
    hooksPath,
    JSON.stringify({
      UserPromptSubmit: [
        { command: [process.execPath, script, pidLog], timeoutMs: 10_000 },
        { command: [process.execPath, script, pidLog], timeoutMs: 30_000 },
      ],
    }),
  );
  const config = suite.config("hooks-json-pid-state-", { hooksPath });
  const { plane, ws } = await bootOwner({
    config,
    llm: responseLlm(() => ({ id: "pid-1", text: "pong", createdAt: Date.now() })),
  });
  const { signal: decided, unsubscribe } = committedDecision(plane, "pid-count decision", "hook", "prompt.pre");
  try {
    const reply = nextResidentTurn(plane);
    ws.send(JSON.stringify({ type: "message", eventId: "pid-turn", text: "ping" }));
    const decision = await decided.promise;
    expect(await reply).toMatchObject({ text: "pong" });
    // BOTH rows consulted on the one prompt decision...
    const node = plane.openKernel(decision.sessionId).actionById(decision.id);
    const parsed = z
      .object({ gate: z.object({ consulted: z.array(z.object({ ref: z.string() })) }) })
      .parse(node?.intent.value);
    expect(parsed.gate.consulted.map((entry) => entry.ref)).toEqual([
      Bundle.HOOK_PROCESS_REF,
      Bundle.HOOK_PROCESS_REF,
    ]);
    // ...yet each live generation spawned exactly ONE PID for the command.
    // Two sessions hold a generation here (gateway-ingress + the resident), so
    // TWO distinct rows with the same command yield 2 PIDs, never 4: the pool
    // key is the command identity, not the per-call timeout (#1256 r3 M-2).
    const sessions = plane.listSessions();
    expect(sessions).toHaveLength(2);
    const pids = readFileSync(pidLog, "utf8").trim().split("\n").map(Number);
    expect(pids).toHaveLength(sessions.length);
    expect(new Set(pids).size).toBe(pids.length);
    for (const pid of pids) expect(Number.isInteger(pid)).toBe(true);
    // The generation Scopes own the PIDs: teardown (the rotation finalizer
    // path) kills ALL of them.
    await suite.cleanup();
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    unsubscribe();
  }
});

/** The scripted rewrite hook: masks the bash command via the consulted rewrite row. */
const REWRITE_HOOK_SCRIPT = `
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let cut;
  while ((cut = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 1);
    if (line.length === 0) continue;
    const request = JSON.parse(line);
    const result = { type: "rewrite", fields: { command: "echo rewritten-by-hook" } };
    console.log(JSON.stringify({ id: request.id, result }));
  }
}
`;

test("H-2 e2e: an external PreToolUse rewrite reaches the REAL dispatched executor and journals the rewrite", async () => {
  const dir = suite.tempDir("hooks-json-rewrite-");
  const script = join(dir, "rewrite-hook.js");
  writeFileSync(script, REWRITE_HOOK_SCRIPT);
  const hooksPath = join(dir, "hooks.json");
  writeFileSync(
    hooksPath,
    JSON.stringify({
      PreToolUse: [
        { command: [process.execPath, script], timeoutMs: 30_000, do: "rewrite", fields: ["command"] },
      ],
    }),
  );
  const config = suite.config("hooks-json-rewrite-state-", { hooksPath });
  // The REAL executor: a registered tool whose execute records what it was
  // handed — the proof the consulted rewrite reached the dispatch, not a
  // synthetic evaluation.
  const executed: { command: string }[] = [];
  const bashTool = Core.eraseTool(
    Core.defineTool({
      name: "maskable",
      description: "test maskable executor",
      category: "query",
      visibility: { model: ["resident"], cell: [] },
      input: z.object({ command: z.string() }),
      output: z.string(),
      execute: (input) => {
        executed.push(input);
        return Promise.resolve(input.command);
      },
      render: (_input, result) => result,
    }),
  );
  let calls = 0;
  let residentSessionId: string | undefined;
  const app = await suite.boot({
    config,
    bundles: [testToolsBundle([bashTool])],
    llm: {
      resolveModel: fakeProviderModel,
      run: (input: RunInput, sink: Sink) =>
        Effect.sync(() => {
          calls += 1;
          residentSessionId = input.trace.sessionId;
          if (calls === 1) {
            sink.onMessage(pendingToolMessage(input, "rewrite-step-1", "rewrite-call-1", "maskable", "curl -H 'x-key: sk-abcdef123456789' https://api"));
            return { type: "stop" as const };
          }
          sink.onMessage(
            assistantMessage(input, { id: "rewrite-step-2", text: "rewritten done", createdAt: Date.now() }),
          );
          return { type: "stop" as const };
        }),
    },
  });
  const { plane, ws } = await ownerConnection(app);
  const terminal = nextResidentTurn(plane, 15_000);
  ws.send(JSON.stringify({ type: "message", eventId: "rewrite-open", text: "run the curl" }));
  expect(await terminal).toMatchObject({ text: "rewritten done" });
  // The EXECUTOR saw the consultant's rewritten value, never the secret.
  expect(executed).toEqual([{ command: "echo rewritten-by-hook" }]);
  expect(calls).toBe(2);
  // Durable evidence: the tool.pre policy.decision row records the consulted
  // rewrite — allow verdict, hook/process consulted, rewritten gate output.
  if (config.sessionsDir === undefined) throw new Error("suite config always sets sessionsDir");
  const sessionId = residentSessionId;
  if (sessionId === undefined) throw new Error("the model step never ran");
  const decisions = sessionDecisions(config, sessionId, "tool.pre");
  expect(decisions).toHaveLength(1);
  expect(decisions[0]?.verdict).toBe("allow");
  expect(decisions[0]?.gate?.verdict).toBe("allow");
  expect(decisions[0]?.gate?.output?.command).toBe("echo rewritten-by-hook");
  expect(decisions[0]?.gate?.consulted).toEqual([
    expect.objectContaining({ ref: Bundle.HOOK_PROCESS_REF }),
  ]);
}, 30_000);

// ─── H-3(b) e2e: manifest rotation while a captured old turn is live ────────

/** Logs `<pid> <request-json>` per consulted request, then answers allow. */
const PID_REQUEST_LOG_SCRIPT = `
const fs = require("node:fs");
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let cut;
  while ((cut = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 1);
    if (line.length === 0) continue;
    const request = JSON.parse(line);
    fs.appendFileSync(process.argv[2], process.pid + " " + line + "\\n");
    console.log(JSON.stringify({ id: request.id, result: { type: "gate", verdict: "allow" } }));
  }
}
`;

test("H-3(b) e2e: a real generation rotation mid-turn — the old turn keeps its captured hook PID, the next turn uses the new one, the old PID is reclaimed", async () => {
  const dir = suite.tempDir("hooks-json-rotate-");
  const script = join(dir, "rotate-hook.js");
  writeFileSync(script, PID_REQUEST_LOG_SCRIPT);
  const requestLog = join(dir, "requests.log");
  const hooksPath = join(dir, "hooks.json");
  writeFileSync(
    hooksPath,
    JSON.stringify({
      PreToolUse: [{ command: [process.execPath, script, requestLog], timeoutMs: 30_000 }],
    }),
  );
  const TOKEN = "hooks-rotate";
  const config = suite.config("hooks-json-rotate-state-", {
    hooksPath,
    wsToken: TOKEN,
    compactionSummarizer: false,
  });
  const probeTool = Core.eraseTool(
    Core.defineTool({
      name: "probe",
      description: "test probe executor",
      category: "query",
      visibility: { model: ["resident"], cell: [] },
      input: z.object({ note: z.string() }),
      output: z.string(),
      execute: (input) => Promise.resolve(input.note),
      render: (_input, result) => result,
    }),
  );
  let calls = 0;
  // The app spawns its hook children IN THIS PROCESS: capturing `exited` at
  // spawn time is the exit signal, subscribed before any retirement — process
  // reap is then awaited, never probed.
  const spawnExits = new Map<number, Promise<number>>();
  const nativeSpawn = Bun.spawn;
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    const child = nativeSpawn(...args);
    spawnExits.set(child.pid, child.exited);
    return child;
  }) as typeof Bun.spawn;
  suite.defer(() => {
    Bun.spawn = nativeSpawn;
  });
  const app = await suite.boot({
    config,
    bundles: [testToolsBundle([probeTool])],
    llm: {
      resolveModel: fakeProviderModel,
      run: (input: RunInput, sink: Sink) =>
        Effect.sync(() => {
          calls += 1;
          if (calls === 1)
            requestToolStep(input, sink, {
              id: "rotate-disable",
              tool: "provision",
              input: { operation: { op: "bundle_disable", args: { name: "monitor" } } },
            });
          else if (calls === 2)
            requestToolStep(input, sink, {
              id: "rotate-old-probe",
              tool: "probe",
              input: { note: "old-turn-probe" },
            });
          else if (calls === 3)
            sink.onMessage(
              assistantMessage(input, { id: "rotate-t1", text: "turn one done", createdAt: Date.now() }),
            );
          else if (calls === 4)
            requestToolStep(input, sink, {
              id: "rotate-new-probe",
              tool: "probe",
              input: { note: "new-turn-probe" },
            });
          else
            sink.onMessage(
              assistantMessage(input, { id: "rotate-t2", text: "turn two done", createdAt: Date.now() }),
            );
          return { type: "stop" as const };
        }),
    },
  });
  const { plane, ws } = await ownerConnection(app, TOKEN);
  const residentId = () => plane.listSessions().find((row) => row.id !== "gateway-ingress")?.id;
  const lastTerminal = (sessionId: string) =>
    plane.openKernel(sessionId).getSnapshot(sessionId).turns.at(-1)?.terminal?.kind;
  // Turn 1: the provision call consults the OLD generation's hook PID, then
  // suspends on Owner consent.
  ws.send(JSON.stringify({ type: "message", eventId: "rotate-turn-1", text: "disable monitor" }));
  const openRequest = () => {
    const sessionId = residentId();
    if (sessionId === undefined) return undefined;
    return openResidentRequest(plane, sessionId);
  };
  await untilCommitted(() => openRequest() !== undefined, "bundle_disable consent never opened");
  const sessionId = residentId();
  if (sessionId === undefined) throw new Error("no resident session");
  const generationBefore = plane.openKernel(sessionId).latestGenerationFor(sessionId).generation;
  const request = openRequest();
  if (request === undefined) throw new Error("missing consent request");
  // Owner approval: the app recomposes; the RUNNING turn keeps its captured
  // generation (and with it the captured hook consultant process).
  const receipt = nextFrame(ws, (frame) => frame.type === "receipt" && frame.inputId === "rotate-answer");
  ws.send(
    JSON.stringify({
      type: "request_answer",
      inputId: "rotate-answer",
      request,
      decision: "approve",
      credential: TOKEN,
    }),
  );
  await receipt;
  await untilCommitted(() => lastTerminal(sessionId) === "result", "turn one never finished");
  expect(calls).toBe(3);
  // The old turn ran BOTH its consults (pre- and post-rotation) on ONE pid:
  // the captured consultant, not the recomposed generation's new process.
  const lines = () =>
    readFileSync(requestLog, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const cut = line.indexOf(" ");
        return { pid: Number(line.slice(0, cut)), request: line.slice(cut + 1) };
      });
  const pidFor = (needle: string) => {
    const hits = lines().filter((entry) => entry.request.includes(needle));
    expect(hits.length).toBeGreaterThan(0);
    const pids = new Set(hits.map((entry) => entry.pid));
    expect(pids.size).toBe(1);
    const [pid] = pids;
    if (pid === undefined || !Number.isInteger(pid)) throw new Error(`bad pid for ${needle}`);
    return pid;
  };
  const oldPid = pidFor("bundle_disable");
  expect(pidFor("old-turn-probe")).toBe(oldPid);
  // The old turn ended, releasing its capture; the swap itself commits at the
  // NEXT adoption (the compose configure rides turn 2's start), and THAT
  // closes the old generation Scope — the rotation finalizer kills the
  // captured hook process.
  ws.send(JSON.stringify({ type: "message", eventId: "rotate-turn-2", text: "probe again" }));
  await untilCommitted(() => calls >= 5, "turn two never ran");
  await untilCommitted(() => lastTerminal(sessionId) === "result", "turn two never finished");
  const oldExit = spawnExits.get(oldPid);
  if (oldExit === undefined) throw new Error("old hook PID was not spawned in this process");
  const reaped = eventSignal<number>("old generation hook PID reclaimed", 10_000);
  oldExit.then(reaped.resolve, reaped.reject);
  await reaped.promise;
  // The exit signal is the reap fact: the PID is gone.
  expect(() => process.kill(oldPid, 0)).toThrow();
  // Turn 2 ran on the recomposed generation: a NEW hook process served it.
  const newPid = pidFor("new-turn-probe");
  expect(newPid).not.toBe(oldPid);
  expect(() => process.kill(newPid, 0)).not.toThrow();
  expect(plane.openKernel(sessionId).latestGenerationFor(sessionId).generation).toBe(
    generationBefore + 1,
  );
}, 40_000);
