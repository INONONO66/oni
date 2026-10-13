import { toolOutputRefSchema } from "@openomni/protocol";
import { runAgentSync } from "./helpers/executor";
import { catalogLayer } from "./helpers/service-layers";
import { Effect, Fiber } from "effect";
import { isolated } from "./helpers/isolated";
import { describe, expect, it } from "bun:test";
import { AgentInvariantViolation } from "../src/core/ports/failure";
import { defineTool, eraseTool, projectTools, ToolRefused, toolInputSchema } from "../src/core/loop/tool";
import { createDispatcher } from "../src/plugins/tool";
import { recordingExecutor } from "./helpers/effect-g2";
import { valueTool } from "./helpers/query-tool";
import { z } from "zod";

function dispatcher(definitions: readonly import("@openomni/protocol").AnyToolDefinition[]) {
  return runAgentSync(createDispatcher({ executor: recordingExecutor().executor }).pipe(Effect.provide(catalogLayer(definitions))));
}

/** A dispatcher wired with in-memory tool output projection ports. */
function projectingDispatcher(
  definitions: readonly import("@openomni/protocol").AnyToolDefinition[],
  budgetBytes = 32_768,
) {
  const stored = new Map<string, { bytes: Uint8Array; mediaType?: string }>();
  const dispatch = runAgentSync(
    createDispatcher({
      executor: recordingExecutor().executor,
      toolOutput: {
        budgetBytes,
        put: (write) => {
          if (!stored.has(write.outputId))
            stored.set(write.outputId, { bytes: write.bytes, ...(write.mediaType === undefined ? {} : { mediaType: write.mediaType }) });
        },
      },
    }).pipe(Effect.provide(catalogLayer(definitions))),
  );
  return { dispatch, stored };
}

const OUTPUT_MARKER = /\n\[output (sha256:[0-9a-f]{64}): (\d+) bytes; read with tool_output\("(sha256:[0-9a-f]{64})"\)\]$/;

const OutputRef = toolOutputRefSchema();

function parsedRef(details: import("@openomni/protocol").PlainValue | undefined) {
  return OutputRef.parse(z.object({ outputRef: OutputRef }).parse(details).outputRef);
}

function definition(options: {
  readonly name?: string;
  readonly category?: "query" | "execution";
  readonly execute?: () => Promise<string>;
  readonly render?: (value: string) => string;
}) {
  return valueTool({
    name: options.name ?? "echo",
    description: "Echo a value",
    ...(options.category === undefined ? {} : { category: options.category }),
    execute: options.execute ?? (async () => "ok"),
    ...(options.render === undefined ? {} : { render: options.render }),
  });
}

const context = { sessionId: "session-1", turnId: "turn-1" };
const call = { id: "call-1", tool: "echo", input: { value: "input" } };

describe("tool dispatcher public contract", () => {
  it("records admission before acting and never acts before the commit resolves", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const reached = Promise.withResolvers<void>();
          const released = Promise.withResolvers<void>();
          let bodies = 0;
          const recording = recordingExecutor({
            onCommit: async () => {
              reached.resolve();
              await released.promise;
            },
          });
          const dispatch = runAgentSync(createDispatcher({ executor: recording.executor }).pipe(Effect.provide(catalogLayer([
              definition({
                execute: async () => {
                  bodies += 1;
                  return "result";
                },
              }),
            ]))));
          const running = yield* Effect.forkScoped(dispatch.execute(call, context));
          yield* Effect.promise(() => reached.promise).pipe(Effect.timeout("5 seconds"));
          expect(recording.committed[0]?.kind).toBe("policy.decision");
          expect(bodies).toBe(0);
          released.resolve();
          expect(yield* Fiber.join(running)).toMatchObject({ content: "result" });
          expect(bodies).toBe(1);
        }),
      ),
    ));
  it("rejects empty metadata and non-object input schemas", () => {
    expect(() => definition({ name: " " })).toThrow(AgentInvariantViolation);
    expect(() =>
      defineTool({
        name: "scalar",
        description: "Scalar input",
        category: "query",
        input: z.string(),
        output: z.string(),
        visibility: { model: ["resident"], cell: [] },
        execute: async (value: string) => value,
        render: (_input: string, value: string) => value,
      }),
    ).toThrow(AgentInvariantViolation);
    expect(() =>
      defineTool({
        name: "described",
        description: " ",
        category: "query",
        input: z.object({}),
        output: z.string(),
        visibility: { model: [], cell: [] },
        execute: async () => "ok",
        render: (_input: Record<string, never>, value: string) => value,
      }),
    ).toThrow(AgentInvariantViolation);
  });

  it("projects model and session specifications from definitions", () => {
    const query = definition({});
    const execution = definition({ name: "run", category: "execution" });

    expect(toolInputSchema(eraseTool(query))).toMatchObject({ type: "object" });
    expect(projectTools([eraseTool(query)]).specs[0]).toMatchObject({ name: "echo", safe: true });
    expect(projectTools([eraseTool(query)]).specs[0]).not.toHaveProperty("placement");
    expect(projectTools([eraseTool(execution)]).specs[0]).toMatchObject({ name: "run", safe: false });
    expect(projectTools([eraseTool(execution)]).session[0]).toMatchObject({ name: "run", category: "execution" });
  });

  it("classifies missing tools and invalid inputs without invoking a tool", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          let executions = 0;
          const dispatch = dispatcher([
            definition({
              execute: () => {
                executions += 1;
                return Promise.resolve("ok");
              },
            }),
          ]);

          const rejected = [
            { id: "missing-call", tool: "missing", input: call.input },
            { ...call, id: "invalid-call", input: {} },
          ];
          const wave = yield* dispatch.executeWave(rejected, context);
          for (const [index, rejectedCall] of rejected.entries()) {
            for (const result of [wave[index], yield* dispatch.execute(rejectedCall, context), yield* dispatch.executeCell(rejectedCall, context)]) {
              expect(result).toMatchObject({
                id: rejectedCall.id, toolCallId: rejectedCall.id, toolName: rejectedCall.tool,
                isError: true, errorKind: index === 0 ? "unregistered_tool" : "invalid_input",
              });
            }
          }
          expect(executions).toBe(0);
        }),
      ),
    ));

  it("distinguishes explicit refusal from execution failure", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const refused = dispatcher([
            definition({
              execute: async () => {
                throw new ToolRefused("echo", "unavailable");
              },
            }),
          ]);
          const failure = new Error("TOOL_FAILURE_SENTINEL");
          const recording = recordingExecutor();
          const failed = runAgentSync(createDispatcher({ executor: recording.executor }).pipe(Effect.provide(catalogLayer([
            definition({ execute: () => Promise.reject(failure) }),
          ]))));

          expect(yield* refused.execute(call, context)).toMatchObject({
            isError: true,
            errorKind: "precondition_failed",
          });
          for (const result of [
            yield* failed.execute(call, context),
            yield* failed.executeCell({ ...call, id: "cell-failure" }, context),
          ]) {
            expect(result).toMatchObject({
              isError: true,
              errorKind: "execution_failed",
              content: String(failure),
            });
          }
          const terminals = recording.committed.flatMap((action) => {
            const parsed = z.object({
              phase: z.literal("result"),
              terminal: z.literal("executed"),
              evidence: z.object({ failures: z.array(z.object({
                tag: z.literal("ToolBodyFailed"), tool: z.string(), cause: z.string(),
              })) }),
              toolResult: z.object({ errorKind: z.string() }).optional(),
            }).safeParse(action.effect.value);
            return parsed.success ? [parsed.data] : [];
          });
          expect(terminals).toHaveLength(2);
          for (const terminal of terminals) {
            expect(terminal.evidence.failures).toEqual([
              { tag: "ToolBodyFailed", tool: "echo", cause: String(failure) },
            ]);
          }
          expect(terminals.flatMap((terminal) => terminal.toolResult === undefined ? [] : [terminal.toolResult.errorKind])).toEqual(["execution_failed"]);
        }),
      ),
    ));

  it("returns typed cell output and projects oversized model output to a stored ref (#1305)", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const output = "x".repeat(40_000);
          const { dispatch, stored } = projectingDispatcher([
            definition({ execute: async () => output, render: (value: string) => value }),
          ]);

          const cell = yield* dispatch.executeCell(call, context);
          const model = yield* dispatch.execute(call, context);

          // The cell door keeps typed data untouched — projection is model-facing.
          expect(cell.structuredContent).toBe(output);
          const marker = OUTPUT_MARKER.exec(model.content);
          if (marker === null) throw new Error(`missing output marker: ${model.content.slice(-120)}`);
          expect(marker[1]).toBe(marker[3]);
          expect(Number(marker[2])).toBe(40_000);
          expect(Buffer.byteLength(model.content, "utf8")).toBeLessThanOrEqual(32_768);
          const preview = model.content.slice(0, marker.index);
          expect(output.startsWith(preview)).toBe(true);
          // Full bytes are stored once under the identifier, readable back whole.
          const ref = parsedRef(model.details);
          expect(ref.outputId).toBe(marker[1] ?? "");
          expect(ref.bytes).toBe(40_000);
          expect(ref.mediaType).toBe("text/plain");
          expect(ref.preview).toBe(preview);
          const full = stored.get(ref.outputId);
          if (full === undefined) throw new Error("output bytes not stored");
          expect(new TextDecoder().decode(full.bytes)).toBe(output);
          // A repeated identical output dedupes on the digest key.
          yield* dispatch.execute(call, context);
          expect(stored.size).toBe(1);
        }),
      ),
    ));

  it("a render within the budget passes through untouched — no ref, no store write (#1305)", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const output = "y".repeat(40_000);
          const { dispatch, stored } = projectingDispatcher(
            [definition({ execute: async () => output, render: (value: string) => value })],
            100_000,
          );
          const model = yield* dispatch.execute(call, context);
          expect(model.content).toBe(output);
          expect(model.details).toBeUndefined();
          expect(stored.size).toBe(0);
        }),
      ),
    ));

  it("a dispatcher composed without projection ports renders verbatim (cell/catalog door)", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const output = "z".repeat(40_000);
          const dispatch = dispatcher([
            definition({ execute: async () => output, render: (value: string) => value }),
          ]);
          const model = yield* dispatch.execute(call, context);
          expect(model.content).toBe(output);
          expect(model.details).toBeUndefined();
        }),
      ),
    ));

  it.each([
    "\u{1F600}".repeat(25_000),
    `a${"\u{1F600}".repeat(25_000)}`,
    "\u00e9".repeat(40_000),
    "\u4e2d".repeat(40_000),
  ])("R3 multibyte projection never splits a code point and reports exact bytes (#1305)", (output: string) =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const { dispatch, stored } = projectingDispatcher([definition({ execute: async () => output })]);
          const cell = yield* dispatch.executeCell(call, context);
          const model = yield* dispatch.execute(call, context);
          expect(cell.structuredContent).toBe(output);
          expect(model.isError).toBeUndefined();
          expect(Buffer.byteLength(model.content, "utf8")).toBeLessThanOrEqual(32_768);
          // A lossy encode round-trip would mangle a split code point.
          expect(Buffer.from(model.content, "utf8").toString("utf8")).toBe(model.content);
          const marker = OUTPUT_MARKER.exec(model.content);
          if (marker === null) throw new Error("missing output marker");
          expect(Number(marker[2])).toBe(Buffer.byteLength(output, "utf8"));
          const preview = model.content.slice(0, marker.index);
          expect(output.startsWith(preview)).toBe(true);
          const ref = parsedRef(model.details);
          expect(ref.preview).toBe(preview);
          const full = stored.get(ref.outputId);
          if (full === undefined) throw new Error("output bytes not stored");
          expect(new TextDecoder().decode(full.bytes)).toBe(output);
        }),
      ),
    ));

  it("R3 Unicode boundary keeps a code-point-safe preview and the ref marker through the dispatcher", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const output = `a${"\u{1F600}".repeat(25_000)}`;
          const { dispatch, stored } = projectingDispatcher([definition({ execute: async () => output })]);
          const model = yield* dispatch.execute(call, context);
          const marker = OUTPUT_MARKER.exec(model.content);
          if (marker === null) throw new Error("missing output marker");
          const preview = model.content.slice(0, marker.index);
          // The preview ends on a whole emoji, never inside its surrogate pair.
          expect(Buffer.from(preview, "utf8").toString("utf8")).toBe(preview);
          expect(output.startsWith(preview)).toBe(true);
          expect(Number(marker[2])).toBe(Buffer.byteLength(output, "utf8"));
          expect(stored.has(marker[1] ?? "")).toBe(true);
          expect((yield* dispatch.executeCell(call, context)).structuredContent).toBe(output);
        }),
      ),
    ));
});

describe("D5 tool result split producers", () => {
  const structuredTool = eraseTool(defineTool({
    name: "echo",
    description: "Returns structured data",
    category: "query",
    input: z.object({ value: z.string() }).strict(),
    output: z.object({ answer: z.number(), note: z.string() }).strict(),
    visibility: { model: ["resident"], cell: ["resident"] },
    execute: async () => ({ answer: 42, note: "n" }),
    render: (_input, value) => `answer=${value.answer}`,
  }));

  it("model door carries rendered content plus structuredContent; the cell door carries typed data only", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const dispatch = dispatcher([structuredTool]);
          const model = yield* dispatch.execute(call, context);
          expect(model.content).toBe("answer=42");
          expect(model.structuredContent).toEqual({ answer: 42, note: "n" });
          expect(model.details).toBeUndefined();
          const cell = yield* dispatch.executeCell({ ...call, id: "cell-structured" }, context);
          expect(cell.structuredContent).toEqual({ answer: 42, note: "n" });
          expect(cell.content).toBeUndefined();
        }),
      ),
    ));

  it("oversize structured data is dropped from structuredContent while content keeps the truncated render", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const blob = "x".repeat(300_000);
          const { dispatch } = projectingDispatcher([eraseTool(defineTool({
            name: "echo",
            description: "Returns oversize structured data",
            category: "query",
            input: z.object({ value: z.string() }).strict(),
            output: z.object({ blob: z.string() }).strict(),
            visibility: { model: ["resident"], cell: ["resident"] },
            execute: async () => ({ blob }),
            render: (_input, value) => value.blob,
          }))]);
          const model = yield* dispatch.execute(call, context);
          expect(model.structuredContent).toBeUndefined();
          expect(model.isError).toBeUndefined();
          expect(Buffer.byteLength(model.content, "utf8")).toBeLessThanOrEqual(32_768);
          expect(model.content).toContain("[output sha256:");
        }),
      ),
    ));

  it("a failed call carries the error text as content and the errorKind as details", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const dispatch = dispatcher([definition({ execute: async () => { throw new ToolRefused("echo", "nope"); } })]);
          const model = yield* dispatch.execute(call, context);
          expect(model).toMatchObject({
            isError: true,
            errorKind: "precondition_failed",
            content: "echo refused: nope",
            details: { errorKind: "precondition_failed" },
          });
          expect(model.structuredContent).toBeUndefined();
        }),
      ),
    ));
});
