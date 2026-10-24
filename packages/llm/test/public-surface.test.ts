import { describe, expect, test } from "bun:test";
import ts from "typescript";
import type { Sink } from "../src";
import { LlmOperationFailure, InvalidProviderData } from "../src/errors";
import { apiError } from "./helpers/retry";

test("error values retain their machine tags", () => {
  expect(apiError({ message: "bad", isRetryable: false })._tag).toBe("APIError");
  expect(new LlmOperationFailure({ operation: "run", cause: "bad" }).message).toBe("run: bad");
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
      await Bun.file(new URL("../src/sink.ts", import.meta.url)).text(),
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
    const root = await import("../src");

    // When: the consumer reads the public runtime contract.
    const publicKeys = Object.keys(root).sort();

    // Then: only the call layer's entry points are exposed: the
    // port-shaped service factory, the pure classifier, the credential store,
    // the catalog seam, the one-attempt `run`, the modality fold and input-part
    // resolution, the speech-to-text port, and the typed errors. The `Llm`
    // tag is the agent core's; `Provider` stays inside the package.
    expect(publicKeys).toEqual([
      "APIError",
      "Auth",
      "AuthInvalidFileError",
      "AuthResolutionError",
      "Capability",
      "InvalidProviderData",
      "LlmOperationFailure",
      "LlmRunFailure",
      "ModelCatalogError",
      "ModelResolutionError",
      "ModelUnavailable",
      "ModelsDev",
      "NEAR_WINDOW_RATIO",
      "ProviderRow",
      "ProviderRowsError",
      "ProxyModelsError",
      "TransportFailure",
      "classifyFailure",
      "coerceApiError",
      "isContextOverflow",
      "makeLlmService",
      "makeStt",
      "readProviderRows",
      "resolveAuthFilePath",
      "resolveInputParts",
      "run",
    ]);
  });

  test("does not expose lower-level implementation helpers", async () => {
    // Given: a consumer imports the root package barrel.
    const root = await import("../src");

    // When: implementation helpers are checked on the root object.
    const removedExports = [
      "ProviderTransform",
      "fetchProxyModels",
      "enrichWithCatalog",
      "Message",
      "Processor",
      "Tool",
      "toModelMessages",
      // The tag and Layer are the agent core's and the composition root's.
      "Llm",
      "LlmLive",
      "Provider",
      "Retry",
      "renderBodyCause",
      "thrownAsError",
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
