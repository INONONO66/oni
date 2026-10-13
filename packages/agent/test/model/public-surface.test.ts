import { describe, expect, test } from "bun:test";
import ts from "typescript";
import type { Sink } from "../../src/model";
import { Llm } from "../../src/model/services";
import { AgentFailure, InvalidProviderData } from "../../src/model/errors";
import { apiError } from "./helpers/retry";
import { Context } from "effect";

test("LLM service and error values retain their machine tags", () => {
  const service = { run: (): never => { throw new Error("fixture"); }, resolveModel: (): never => { throw new Error("fixture"); } };
  expect(Llm.key).toBe("@openomni/agent/Llm");
  expect(Context.get(Context.make(Llm, service), Llm)).toBe(service);
  expect(apiError({ message: "bad", isRetryable: false })._tag).toBe("APIError");
  expect(new AgentFailure({ operation: "run", cause: "bad" }).message).toBe("run: bad");
  expect(
    new InvalidProviderData({
      operation: "provider.data",
      cause: "invalid",
      message: "invalid provider data",
    })._tag,
  ).toBe("InvalidProviderData");
});

describe("model barrel public surface", () => {
  test("967 public sink excludes fact tap", async () => {
    const callbacks = {
      onMessage: true,
      onToolCall: true,
      onToolResult: true,
    } satisfies Record<keyof Sink, true>;
    const source = ts.createSourceFile(
      "sink.ts",
      await Bun.file(new URL("../../src/model/sink.ts", import.meta.url)).text(),
      ts.ScriptTarget.Latest,
      true,
    );

    // When: TypeScript parses the callback members (not comments or prose).
    const contract = source.statements
      .filter(ts.isInterfaceDeclaration)
      .find((node) => node.name.text === "Sink");

    // Then: only retained callbacks are public; the typed map is exhaustive too.
    expect(contract?.members.map((member) => member.name?.getText(source)).sort()).toEqual(
      Object.keys(callbacks).sort(),
    );
  });

  test("exposes the package contract", async () => {
    // Given: a consumer imports the root package barrel.
    const root = await import("../../src/model");

    // When: the consumer reads the public runtime contract.
    const publicKeys = Object.keys(root).sort();

    // Then: only package-level namespaces and entry points are exposed.
    // `Run` (Outcome vocabulary) moved here from protocol; `Sink` is type-only.
    expect(publicKeys).toEqual([
      "APIError",
      "AgentFailure",
      "Auth",
      "AuthInvalidFileError",
      "AuthResolutionError",
      "InvalidProviderData",
      "Llm",
      "LlmLive",
      "LlmRunFailure",
      "ModelCatalogError",
      "ModelResolutionError",
      "ModelsDev",
      "Provider",
      "ProxyModelsError",
      "Retry",
      "TransportFailure",
      "accumulateUsage",
      "coerceApiError",
      "observeRetry",
      "run",
      "selectModel",
    ]);
  });

  test("does not expose lower-level implementation helpers", async () => {
    // Given: a consumer imports the root package barrel.
    const root = await import("../../src/model");

    // When: implementation helpers are checked on the root object.
    const removedExports = [
      "ProviderTransform",
      "fetchProxyModels",
      "enrichWithCatalog",
      "Message",
      "Processor",
      "Tool",
      "toModelMessages",
      // Unexported by the dead-surface audit: no production consumer
      // imported these from the root barrel (internals still use them —
      // e.g. the stream fold reaches TokenTracker by deep import).
      "NamedError",
      "TokenTracker",
    ] as const;

    // Then: internal helpers remain available only through deep imports.
    for (const exportName of removedExports) {
      expect(Reflect.ownKeys(root).includes(exportName)).toBe(false);
    }
  });
});
