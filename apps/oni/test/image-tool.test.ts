import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { PlainObject } from "@oni/protocol";
import { composeImage, createImagePort } from "../src/composition/image";
import type { ImageCall, ImagePort } from "../src/bundles/tools/image/index";
import { toolPorts } from "../src/gateway";
import { dispatcherFixture } from "./helpers/dispatcher-fixture";
import { runEffect } from "./helpers/effect";
import { executor } from "./helpers/executor";
import { dispatchModelTool } from "./helpers/tool-dispatch";
import { bundleTools, testToolPorts } from "./helpers/tool-ports";

const IMAGE_TOOL_NAME = "image";
const MAX_IMAGE_CALLS = 8;
const IMAGE_OUTPUT_MAX_BYTES = 25 * 1024 * 1024;
const RESIDENT = { role: "resident", sessionId: "image-session" } as const;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 9]);

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** An image port that records every call and stored output and answers with the given images. */
function recordingPort(images: readonly { bytes: Uint8Array; mediaType: string }[]) {
  const calls: { call: ImageCall; signal: AbortSignal }[] = [];
  const stored: { sessionId: string; write: Parameters<ImagePort["putOutput"]>[1] }[] = [];
  const port: ImagePort = {
    generate: async (call, signal) => {
      calls.push({ call, signal });
      return images;
    },
    putOutput: (sessionId, write) => {
      stored.push({ sessionId, write });
    },
  };
  return { port, calls, stored };
}

describe("the image tool", () => {
  it("stores each generated image as a session output and returns digest references", async () => {
    const { port, calls, stored } = recordingPort([
      { bytes: PNG, mediaType: "image/png" },
      { bytes: JPEG, mediaType: "image/jpeg" },
    ]);
    const result = await dispatchModelTool(IMAGE_TOOL_NAME, { image: port }, RESIDENT)({ prompt: "a red circle" });
    const expected = [
      { kind: "image", ref: digest(PNG), mediaType: "image/png" },
      { kind: "image", ref: digest(JPEG), mediaType: "image/jpeg" },
    ];
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(expected);
    expect(result.content).toBe(JSON.stringify(expected));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.call).toEqual({ prompt: "a red circle", n: 1 });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(stored).toEqual([
      { sessionId: RESIDENT.sessionId, write: { outputId: digest(PNG), bytes: PNG, mediaType: "image/png" } },
      { sessionId: RESIDENT.sessionId, write: { outputId: digest(JPEG), bytes: JPEG, mediaType: "image/jpeg" } },
    ]);
  });

  it("passes size, count and the model id override through to the port", async () => {
    const { port, calls } = recordingPort([{ bytes: PNG, mediaType: "image/png" }]);
    const result = await dispatchModelTool(IMAGE_TOOL_NAME, { image: port }, RESIDENT)({
      prompt: "a square",
      size: "1024x768",
      n: 3,
      model: "gpt-image-1-mini",
    });
    expect(result.isError).toBeUndefined();
    expect(calls[0]?.call).toEqual({ prompt: "a square", n: 3, size: "1024x768", model: "gpt-image-1-mini" });
  });

  it("refuses malformed input before the port sees it", async () => {
    const { port, calls } = recordingPort([]);
    const dispatch = dispatchModelTool(IMAGE_TOOL_NAME, { image: port }, RESIDENT);
    const malformed: PlainObject[] = [
      { prompt: "" },
      { prompt: "p", size: "0x0" },
      { prompt: "p", size: "1.5x2" },
      { prompt: "p", size: "1024" },
      { prompt: "p", n: 0 },
      { prompt: "p", n: 11 },
      { prompt: "p", n: 1.5 },
      { prompt: "p", model: "" },
      { prompt: "p", extra: true },
    ];
    for (const input of malformed) {
      expect(await dispatch(input)).toMatchObject({ isError: true, errorKind: "invalid_input" });
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses typed when the image port is not composed", async () => {
    expect(await dispatchModelTool(IMAGE_TOOL_NAME, { image: undefined }, RESIDENT)({ prompt: "p" })).toMatchObject({
      isError: true,
      errorKind: "precondition_failed",
      content: "image refused: image port is not composed",
    });
  });

  it("refuses an image over the output cap without storing any of the call's images", async () => {
    const oversize = new Uint8Array(IMAGE_OUTPUT_MAX_BYTES + 1);
    const { port, stored } = recordingPort([
      { bytes: PNG, mediaType: "image/png" },
      { bytes: oversize, mediaType: "image/png" },
    ]);
    expect(await dispatchModelTool(IMAGE_TOOL_NAME, { image: port }, RESIDENT)({ prompt: "p" })).toMatchObject({
      isError: true,
      errorKind: "precondition_failed",
      content: `image refused: an image of ${IMAGE_OUTPUT_MAX_BYTES + 1} bytes exceeds the ${IMAGE_OUTPUT_MAX_BYTES}-byte output cap`,
    });
    expect(stored).toHaveLength(0);
  });

  it("surfaces a port failure as an error result, never as data", async () => {
    const port: ImagePort = {
      generate: async () => {
        throw new Error("image failed: provider on fire");
      },
      putOutput: () => undefined,
    };
    expect(await dispatchModelTool(IMAGE_TOOL_NAME, { image: port }, RESIDENT)({ prompt: "p" })).toMatchObject({
      isError: true,
      content: expect.stringContaining("provider on fire"),
    });
  });

  it("is visible to the resident and a child at both doors", () => {
    const [tool] = bundleTools(testToolPorts).filter((definition) => definition.name === IMAGE_TOOL_NAME);
    expect(tool?.visibility).toEqual({ model: ["resident", "child"], cell: ["resident", "child"] });
    expect(tool?.category).toBe("execution");
  });

  it(`serves ${MAX_IMAGE_CALLS} calls per cell, then refuses that cell without invoking the port`, async () => {
    const { port, calls } = recordingPort([{ bytes: PNG, mediaType: "image/png" }]);
    const dispatcher = dispatcherFixture(bundleTools({ ...testToolPorts, image: port }), { executor });
    let nextId = 0;
    const run = (cellId: string) =>
      runEffect(
        dispatcher.executeCell(
          { id: `cell:${cellId}:${++nextId}`, tool: IMAGE_TOOL_NAME, input: { prompt: "p" } },
          { sessionId: RESIDENT.sessionId, turnId: cellId },
        ),
      );
    const refusal = {
      isError: true,
      errorKind: "precondition_failed",
      content: `image refused: the per-cell budget of ${MAX_IMAGE_CALLS} image calls is spent`,
    };
    for (let i = 1; i <= MAX_IMAGE_CALLS; i++) expect((await run("cell-a")).isError).toBeUndefined();
    expect(await run("cell-a")).toMatchObject(refusal);
    expect(calls).toHaveLength(MAX_IMAGE_CALLS);
    for (let i = 1; i <= MAX_IMAGE_CALLS; i++) expect((await run("cell-b")).isError).toBeUndefined();
    expect(await run("cell-b")).toMatchObject(refusal);
    expect(await run("cell-a")).toMatchObject(refusal);
    expect(calls).toHaveLength(2 * MAX_IMAGE_CALLS);
  });
});

describe("the composed image port", () => {
  const generated = [{ bytes: PNG, mediaType: "image/png" }];

  function composed() {
    const requests: Parameters<Parameters<typeof createImagePort>[0]["generate"]>[0][] = [];
    const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
    const generate = createImagePort(
      {
        generate: (request) => {
          requests.push(request);
          return Effect.succeed(generated);
        },
      },
      { provider: "openai" },
      () => {
        const id = ids.shift();
        if (id === undefined) throw new Error("out of ids");
        return id;
      },
    );
    return { generate, requests };
  }

  it("runs every call under its own trace and leaves optional fields absent", async () => {
    const { generate, requests } = composed();
    expect(await runEffect(generate({ prompt: "a dog" }))).toBe(generated);
    expect(await runEffect(generate({ prompt: "a cat" }))).toBe(generated);
    expect(requests).toEqual([
      { prompt: "a dog", traceId: "00000000000040008000000000000001" },
      { prompt: "a cat", traceId: "00000000000040008000000000000002" },
    ]);
  });

  it("keeps a model id override on the configured provider and forwards size and count", async () => {
    const { generate, requests } = composed();
    await runEffect(generate({ prompt: "a fox", model: "gpt-image-1-mini", size: "512x512", n: 2 }));
    expect(requests).toEqual([
      {
        prompt: "a fox",
        traceId: "00000000000040008000000000000001",
        model: { provider: "openai", id: "gpt-image-1-mini" },
        size: "512x512",
        n: 2,
      },
    ]);
  });
});

describe("the composed image generator", () => {
  const services = { observations: { publish: () => undefined }, now: () => 0 };

  it("falls back to the bundled rows, which refuse an unknown provider typed before any call", async () => {
    const image = composeImage({ imageRows: undefined }, services);
    await expect(
      runEffect(image.generate({ prompt: "p", traceId: "t", model: { provider: "nowhere", id: "m" } })),
    ).rejects.toMatchObject({ _tag: "ModelResolutionError", reason: "provider_not_found", provider: "nowhere" });
  });

  it("uses the configured rows, which refuse typed when none names an image model", async () => {
    const image = composeImage({ imageRows: [] }, services);
    await expect(runEffect(image.generate({ prompt: "p", traceId: "t" }))).rejects.toMatchObject({
      _tag: "ModelResolutionError",
      reason: "model_not_found",
    });
  });
});

describe("the gateway image bridge", () => {
  const runtime = { runPromise: runEffect } as never;
  const base = {
    completion: (() => Effect.succeed({})) as never,
    messages: { ingest: () => Effect.succeed({}) } as never,
    now: () => 0,
    id: () => "fixed",
  };

  it("leaves the port absent when no image door is composed", () => {
    expect(toolPorts(runtime, base).image).toBeUndefined();
  });

  it("runs generate through the app runtime and hands putOutput through untouched", async () => {
    const generated = [{ bytes: JPEG, mediaType: "image/jpeg" }];
    const seen: ImageCall[] = [];
    const putOutput: ImagePort["putOutput"] = () => undefined;
    const ports = toolPorts(runtime, {
      ...base,
      image: {
        generate: (call) => {
          seen.push(call);
          return Effect.succeed(generated);
        },
        putOutput,
      },
    });
    expect(await ports.image?.generate({ prompt: "p", n: 1 }, new AbortController().signal)).toBe(generated);
    expect(seen).toEqual([{ prompt: "p", n: 1 }]);
    expect(ports.image?.putOutput).toBe(putOutput);
  });
});
