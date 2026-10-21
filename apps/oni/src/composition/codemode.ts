import { createCodemode, type RunOptions } from "@oni/codemode";
import { Inspect } from "@oni/agent";
import { MachinesFailure } from "@oni/machines";
import { Core } from "@oni/agent";
const forkInvocation = Core.forkInvocation;
const AgentFailure = Core.AgentFailure;
type InvocationFrame = Core.InvocationFrame;
import { Effect, Exit, type Scope } from "effect";
import type { MachineHost } from "@oni/machines";
import { Machine, toolResultText } from "@oni/protocol";

/** Bind product dispatch; interpreter state and cell provenance live in codemode. */
export type ComposedCodemode = Effect.Success<ReturnType<typeof createCodemode>>;

function bindings(frame: InvocationFrame, id: () => string): NonNullable<RunOptions["bindings"]> {
  return {
    boundary() {
      const { executor } = frame;
      return (call, body) => Effect.gen(function* () {
        if (!call.name.startsWith("codemode.")) return yield* body();
        const result = yield* executor.run(
          {
            kind: "tool",
            op: call.name,
            intent: call.arguments,
            effect: {
              category:
                call.name === "codemode.read" ||
                call.name === "codemode.ls" ||
                call.name === "codemode.listMachines" ||
                call.name === "codemode.screen"
                  ? "query"
                  : call.name === "codemode.findMachine"
                    ? "mutation"
                  : "execution",
            },
          },
          () => body().pipe(Effect.mapError((error) => new AgentFailure({ operation: call.name, cause: String(error) }))),
        );
        return result.terminal === "executed"
          ? Machine.ToolCallResult.parse(result.value)
          : { status: "failed" as const, error: result.reason };
      }).pipe(Effect.mapError((error) => new MachinesFailure({ operation: call.name, cause: String(error) })));
    },
    tools(tenant) {
      const { cell: dispatcher } = frame;
      return (call) => Effect.gen(function* () {
        const result = yield* dispatcher.executeCell(
            {
              id: `cell:${call.cellId}:${id()}`,
              tool: call.name,
              input: call.arguments,
            },
            { sessionId: tenant, turnId: call.cellId },
        );
        // D5 (assumed: tool result split — content / details / structuredContent):
        // the cell consumes typed data, never the model text.
        return Machine.ToolCallResult.parse(
          result.isError
            ? { status: "failed", error: toolResultText(result) }
            : { status: "completed", value: result.structuredContent },
        );
      }).pipe(
        // #1258: the cell door throws on a policy refusal (tool.ts
        // finishResult); the cell consumes it as the typed failed result —
        // a denied send is the contracted refusal, never an IPC defect.
        Effect.catchDefect((defect) =>
          defect instanceof Error && defect.name === "ToolRefused"
            ? Effect.succeed(Machine.ToolCallResult.parse({ status: "failed", error: defect.message }))
            : Effect.die(defect),
        ),
        Effect.mapError((error) => new MachinesFailure({ operation: call.name, cause: String(error) })),
      );
    },
  };
}

/**
 * #1305: the app's `tool_output` read source — a tenant's stored output
 * resolved from its own session file; unknown identifiers answer undefined
 * (codemode maps that to the typed `unknown_output`).
 */
export function sessionOutputsSource(
  openKernel: (sessionId: string) => Core.SessionHandleStore.SessionKernel,
): (sessionId: string, outputId: string) => { readonly text: string; readonly bytes: number; readonly mediaType?: string } | undefined {
  return (sessionId, outputId) => {
    const inspected = Inspect.toolOutput(openKernel(sessionId), outputId);
    return inspected.kind === "output"
      ? {
          text: inspected.text,
          bytes: inspected.bytes,
          ...(inspected.mediaType === undefined ? {} : { mediaType: inspected.mediaType }),
        }
      : undefined;
  };
}

export function composeCodemode(
  machines: MachineHost,
  sources: {
    readonly id: () => string;
    readonly selfMachineId?: string;
    /** #1305: resolve a tenant's stored tool output for the prelude's `tool_output`. */
    readonly outputs?: (sessionId: string, outputId: string) => { readonly text: string; readonly bytes: number; readonly mediaType?: string } | undefined;
  },
): Effect.Effect<ComposedCodemode, never, Scope.Scope> {
  return Effect.gen(function* () {
    const outputs = sources.outputs;
    const mode = yield* createCodemode({
      id: sources.id,
      machines,
      self: sources.selfMachineId ?? "self",
      ...(outputs === undefined
        ? {}
        : { toolOutput: (tenant: string, outputId: string) => Effect.sync(() => outputs(tenant, outputId)) }),
    });
    return {
      ...mode,
      cell: {
        ...mode.cell,
        run: (code, tenant, options = {}) => {
          const owned = forkInvocation("eval.cell");
          let owners = 0;
          const ownership = { interrupt: () => owned.close("interrupted"), retain() {
            const release = owned.frame.generation.retain();
            owners += 1;
            return () => {
              release();
              owners -= 1;
              if (owners === 0) owned.close("settled");
            };
          } };
          return owned.frame.generation.provide(mode.cell.run(code, tenant, {
            ...options, ownership, bindings: bindings(owned.frame, sources.id),
          })).pipe(Effect.onExit((exit) => Effect.sync(() => {
            if (owners === 0) owned.close(Exit.isFailure(exit) ? "interrupted" : "settled");
          })));
        },
      },
    };
  });
}
