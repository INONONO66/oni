/**
 * #1305 end-to-end projection: a tool result far over the budget commits as a
 * bounded row referencing stored bytes; the full output reads back whole
 * through the kernel and `Inspect.toolOutput`; the budget folds from
 * `session.configure{settings.toolOutputBudgetBytes}` with the core default
 * when absent.
 */
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { canonicalDigest, canonicalJson, type LedgerAction, type PlainValue } from "@openomni/protocol";
import { useMemoryStores, testNow } from "../../store/helpers/storage";
import { actionPayloadBytes } from "../../../src/core/store/action-hash";
import { L0Write } from "../../../src/core/store/session-file";
import { materializeSession, adoptWriter } from "../../store/helpers/session";
import { testExecutor } from "../../helpers/executor";
import { allowAllPolicy } from "../../helpers/compiled-policy";
import { isolated } from "../../helpers/isolated";
import { toolOutput as inspectToolOutput } from "../../../src/inspect";
import { configureAction } from "../../../src/core/store/fence";
import { consumptionSettings } from "../../../src/core/commit";
import { DEFAULT_TOOL_OUTPUT_BUDGET_BYTES } from "../../../src/core/tool-output";
import type { ExecutionLedger } from "../../../src/core/gate/decide";

const SESSION = "projection-session";

const stores = useMemoryStores();

let entropySeq = 0;

function kernelLedger(
  authority: { sessionId: string; owner: string; fence: number },
  mode: "projecting" | "baseline" = "projecting",
): ExecutionLedger {
  const sessionId = authority.sessionId;
  const base: ExecutionLedger = {
    commit: (action: LedgerAction.Append) =>
      Effect.suspend(() => {
        const row = stores.kernel.row(sessionId);
        return stores.kernel
          .commit({
            sessionId,
            owner: authority.owner,
            fence: authority.fence,
            now: testNow(),
            expectedRevision: row.revision,
            actions: [action],
            state: row.state,
          })
          .pipe(
            Effect.map((committed) => {
              const receipt = committed.receipts[0];
              if (receipt === undefined) throw new Error("missing receipt");
              return receipt;
            }),
          );
      }),
    resultFor: (id) => stores.kernel.resultFor(sessionId, id),
  };
  if (mode === "baseline") return base;
  return {
    ...base,
    toolOutputBudgetBytes: () =>
      consumptionSettings(stores.kernel, sessionId).toolOutputBudgetBytes ?? DEFAULT_TOOL_OUTPUT_BUDGET_BYTES,
    putToolOutput: (write) => stores.kernel.putToolOutput(write),
    toolOutput: (outputId) => stores.kernel.toolOutput(outputId),
  };
}

function toolExecutor(
  authority: { sessionId: string; owner: string; fence: number },
  mode: "projecting" | "baseline" = "projecting",
) {
  return testExecutor({
    policy: allowAllPolicy,
    ledger: kernelLedger(authority, mode),
    observations: { publish: () => undefined },
    identity: { sessionId: authority.sessionId, role: "resident", parentActionId: null },
    clock: testNow,
    entropy: () => `projection-${++entropySeq}`,
    random: () => 0,
  });
}

function plainObject(value: PlainValue | undefined): Record<string, PlainValue> {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected object value");
  return value;
}

function allRows(sessionId: string = SESSION): LedgerAction.Node[] {
  const rows: LedgerAction.Node[] = [];
  let afterRevision = 0;
  for (;;) {
    const page = stores.kernel.historyPage(sessionId, { afterRevision, limit: 256 });
    rows.push(...page.actions);
    if (page.nextRevision === null) return rows;
    afterRevision = page.nextRevision;
  }
}

function resultRows(sessionId: string = SESSION): LedgerAction.Node[] {
  return allRows(sessionId).filter(
    (action) => action.kind === "tool" && plainObject(action.effect.value).phase === "result",
  );
}

function runTool(
  authority: { sessionId: string; owner: string; fence: number },
  value: PlainValue,
  mode: "projecting" | "baseline" = "projecting",
) {
  const executor = toolExecutor(authority, mode);
  return executor.run(
    { kind: "tool", op: "emit", intent: {}, effect: { category: "query" } },
    () => Effect.succeed(value),
  );
}

describe("tool output projection through the durable gate (#1305)", () => {
  it("a 1 MB result commits as a bounded row whose ref reads back whole", () =>
    isolated(
      Effect.gen(function* () {
        materializeSession(stores.kernel, SESSION);
        const authority = adoptWriter(stores.kernel, SESSION);
        // Baseline session: the same 1 MB result through a ledger WITHOUT
        // output ports — no projection — measured for the before/after pairs.
        // 1_000_000 bytes, not 1 MiB: the unprojected baseline rows must still
        // fit the 1 MiB row cap (#1347) with their framing.
        const BASELINE = "projection-baseline";
        materializeSession(stores.kernel, BASELINE);
        const baselineAuthority = adoptWriter(stores.kernel, BASELINE);
        const bigText = "m".repeat(1_000_000);
        const value: PlainValue = { status: "ok", output: bigText };
        const baseline = yield* runTool(baselineAuthority, value, "baseline");
        expect(baseline.terminal).toBe("executed");
        const baselineRow = resultRows(BASELINE).at(-1);
        if (baselineRow === undefined) throw new Error("missing baseline row");
        const outcome = yield* runTool(authority, value);
        expect(outcome.terminal).toBe("executed");
        if (outcome.terminal !== "executed") throw new Error("not executed");
        // The in-memory outcome handed back to the body's caller is full-size.
        expect(plainObject(outcome.value).output).toBe(bigText);

        const row = resultRows().at(-1);
        if (row === undefined) throw new Error("missing result row");
        const effect = plainObject(row.effect.value);
        // The committed row is bounded: well under the budget, never 1 MB.
        const beforeBytes = Buffer.byteLength(canonicalJson(baselineRow.effect.value), "utf8");
        const afterBytes = Buffer.byteLength(canonicalJson(row.effect.value), "utf8");
        // The read-plane event (one serialized history-page action node) is
        // what a page/stream consumer receives for this row.
        const eventBefore = Buffer.byteLength(JSON.stringify(baselineRow), "utf8");
        const eventAfter = Buffer.byteLength(JSON.stringify(row), "utf8");
        // #1305 evidence: the measured byte pairs the PR quotes.
        console.log(`row bytes before projection: ${beforeBytes}; after: ${afterBytes}`);
        console.log(`event bytes before projection: ${eventBefore}; after: ${eventAfter}`);
        expect(afterBytes).toBeLessThan(DEFAULT_TOOL_OUTPUT_BUDGET_BYTES);
        expect(eventAfter).toBeLessThan(eventBefore);
        // Replay identity: resultHash stays the digest of the FULL value.
        expect(effect.resultHash).toBe(canonicalDigest(value));
        const ref = plainObject(plainObject(effect.result).outputRef);
        expect(ref.mediaType).toBe("application/json");
        expect(ref.bytes).toBe(Buffer.byteLength(canonicalJson(value), "utf8"));
        const outputId = ref.outputId;
        if (typeof outputId !== "string") throw new Error("missing outputId");
        expect(outputId).toBe(canonicalDigest(value));

        // Kernel read-back: the stored bytes are the full canonical JSON.
        const stored = stores.kernel.toolOutput(outputId);
        if (stored === undefined) throw new Error("output not stored");
        expect(new TextDecoder().decode(stored.bytes)).toBe(canonicalJson(value));

        // Inspect read model resolves the same identifier, typed.
        const inspected = inspectToolOutput(stores.kernel, outputId);
        if (inspected.kind !== "output") throw new Error("expected output");
        if (typeof ref.bytes !== "number") throw new Error("missing ref bytes");
        expect(inspected.bytes).toBe(ref.bytes);
        expect(inspected.mediaType).toBe("application/json");
        expect(inspected.text).toBe(canonicalJson(value));
        expect(inspectToolOutput(stores.kernel, `sha256:${"00".repeat(32)}`)).toEqual({
          kind: "unknown_output",
          outputId: `sha256:${"00".repeat(32)}`,
        });

        // A repeated identical result re-projects to the SAME identifier.
        const again = yield* runTool(authority, value);
        expect(again.terminal).toBe("executed");
        const rows = resultRows();
        const lastRef = plainObject(plainObject(plainObject(rows.at(-1)?.effect.value).result).outputRef);
        expect(lastRef.outputId).toBe(outputId);
      }),
    ));

  it("#1347 a 2 MiB result commits through the projecting executor with every row at or under the 1 MiB cap", () =>
    isolated(
      Effect.gen(function* () {
        materializeSession(stores.kernel, SESSION);
        const authority = adoptWriter(stores.kernel, SESSION);
        const value: PlainValue = { status: "ok", output: "m".repeat(2_097_152) };
        const before = allRows().length;
        const outcome = yield* runTool(authority, value);
        expect(outcome.terminal).toBe("executed");
        if (outcome.terminal !== "executed") throw new Error("not executed");
        expect(outcome.value).toEqual(value);

        // The run's rows: the tool row AND the tool.post policy.decision row
        // (whose gate `output` records the result) are both bounded by the
        // projection, so none approaches the row cap.
        const rows = allRows().slice(before);
        expect(rows.map((row) => row.kind)).toEqual(["policy.decision", "tool", "policy.decision", "tool"]);
        for (const row of rows) expect(actionPayloadBytes(row)).toBeLessThanOrEqual(L0Write.DEFAULT_ROW_BYTE_CAP);
        const post = rows.find((row) => row.kind === "policy.decision" && plainObject(row.intent.value).hook === "tool.post");
        if (post === undefined) throw new Error("missing tool.post decision");
        const gate = plainObject(plainObject(post.intent.value).gate);
        const ref = plainObject(plainObject(plainObject(gate.output).result).outputRef);
        expect(ref.outputId).toBe(canonicalDigest(value));
        const toolRef = plainObject(plainObject(plainObject(resultRows().at(-1)?.effect.value).result).outputRef);
        expect(toolRef.outputId).toBe(canonicalDigest(value));
        expect(stores.kernel.toolOutput(canonicalDigest(value))?.bytes.byteLength).toBe(
          Buffer.byteLength(canonicalJson(value), "utf8"),
        );
      }),
    ));

  it("the budget folds from generation settings; absent means the 32768-byte core default", () =>
    isolated(
      Effect.gen(function* () {
        materializeSession(stores.kernel, SESSION);
        const authority = adoptWriter(stores.kernel, SESSION);
        const smallValue: PlainValue = { status: "ok", output: "s".repeat(1_000) };
        // Under the default budget: the row carries the value verbatim.
        const first = yield* runTool(authority, smallValue);
        expect(first.terminal).toBe("executed");
        const verbatim = resultRows().at(-1);
        expect(plainObject(plainObject(verbatim?.effect.value).result)).toEqual(smallValue);

        // Pin a 200-byte budget through the configure settings row (#1253 fold).
        const parentId = stores.kernel.latestAction(SESSION)?.id ?? null;
        yield* kernelLedger(authority).commit(
          configureAction({
            id: `${SESSION}:configure-budget`,
            sessionId: SESSION,
            parentId,
            operation: "compose",
            snapshot: stores.kernel.latestGenerationFor(SESSION),
            settings: { steering: "all", followUp: "all", toolOutputBudgetBytes: 200 },
            at: testNow(),
          }),
        );
        expect(consumptionSettings(stores.kernel, SESSION).toolOutputBudgetBytes).toBe(200);
        const second = yield* runTool(authority, smallValue);
        expect(second.terminal).toBe("executed");
        const projected = resultRows().at(-1);
        const ref = plainObject(plainObject(plainObject(projected?.effect.value).result).outputRef);
        expect(ref.outputId).toBe(canonicalDigest(smallValue));
        expect(ref.bytes).toBe(Buffer.byteLength(canonicalJson(smallValue), "utf8"));
      }),
    ));
});
