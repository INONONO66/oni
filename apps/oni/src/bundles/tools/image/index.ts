import { createHash } from "node:crypto";
import type { ToolExecutionContext } from "@oni/protocol";
import { z } from "zod";
import { Bundle, Core } from "@oni/agent";
import { boundTool, ToolCapabilityPort } from "../../seams";
import { ABSENT_MACHINE_PORTS, type MachineToolPortsSource } from "../core/ports";
const defineTool = Core.defineTool;
const ToolRefused = Core.ToolRefused;

/** What one image call asks for: the prompt, and optionally a size, a count and a model id. */
export interface ImageCall {
  readonly prompt: string;
  readonly size?: `${number}x${number}`;
  readonly n?: number;
  /** A model id on the port's configured provider; the port owns that provider's credential. */
  readonly model?: string;
}

/**
 * One image generation plus the session-owned output store its bytes land
 * in: the tool hands the model digest references, never bytes.
 */
export interface ImagePort {
  readonly generate: (call: ImageCall, signal: AbortSignal) => Promise<readonly { readonly bytes: Uint8Array; readonly mediaType: string }[]>;
  readonly putOutput: (sessionId: string, write: { readonly outputId: string; readonly bytes: Uint8Array; readonly mediaType: string }) => void;
}

/** The per-cell call budget: image calls cost money, so a cell gets fewer than it gets sub-model calls. */
const MAX_IMAGE_CALLS = 8;
/** The largest image one stored output may hold. */
const IMAGE_OUTPUT_MAX_BYTES = 25 * 1024 * 1024;

const IMAGE_TOOL_NAME = "image";

const Size = z.string().regex(/^[1-9]\d*x[1-9]\d*$/).pipe(z.templateLiteral([z.int(), "x", z.int()]));
const Input = z
  .object({
    prompt: z.string().min(1),
    size: Size.optional(),
    n: z.int().min(1).max(10).default(1),
    model: z.string().min(1).optional(),
  })
  .strict();
const Output = z.array(z.object({ kind: z.literal("image"), ref: z.string(), mediaType: z.string() }).strict());

function executeImage(image: ImagePort | undefined) {
  const spent = new Map<string, number>();
  return async (input: z.output<typeof Input>, ctx: ToolExecutionContext): Promise<z.output<typeof Output>> => {
    if (image === undefined) throw new ToolRefused(IMAGE_TOOL_NAME, "image port is not composed");
    const calls = spent.get(ctx.turnId) ?? 0;
    if (calls >= MAX_IMAGE_CALLS)
      throw new ToolRefused(IMAGE_TOOL_NAME, `the per-cell budget of ${MAX_IMAGE_CALLS} image calls is spent`);
    spent.set(ctx.turnId, calls + 1);
    const generated = await image.generate(
      {
        prompt: input.prompt,
        n: input.n,
        ...(input.size === undefined ? {} : { size: input.size }),
        ...(input.model === undefined ? {} : { model: input.model }),
      },
      ctx.signal,
    );
    const oversize = generated.find((candidate) => candidate.bytes.byteLength > IMAGE_OUTPUT_MAX_BYTES);
    if (oversize !== undefined)
      throw new ToolRefused(IMAGE_TOOL_NAME, `an image of ${oversize.bytes.byteLength} bytes exceeds the ${IMAGE_OUTPUT_MAX_BYTES}-byte output cap`);
    return generated.map(({ bytes, mediaType }) => {
      const ref = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      image.putOutput(ctx.sessionId, { outputId: ref, bytes, mediaType });
      return { kind: "image" as const, ref, mediaType };
    });
  };
}

function createImageTool(image: ImagePort | undefined) {
  return defineTool({
    name: IMAGE_TOOL_NAME,
    category: "execution",
    description:
      "Generate images from a prompt. Each image is stored as a session output and returned as {kind:\"image\", ref:\"sha256:…\", mediaType}; send the ref in a letter's image part. Options: size ({width}x{height}), n (images per call, default 1), model (an id on the configured provider's image surface).",
    input: Input,
    output: Output,
    visibility: { model: ["resident", "child"], cell: ["resident", "child"] },
    execute: executeImage(image),
    render: (_args, value) => JSON.stringify(value),
  });
}

/** The `image` bundle: one image generation per call, bytes stored as session outputs. */
export function imageBundle(ports: MachineToolPortsSource): Bundle.BundleContract<"image"> {
  return Bundle.define({
    name: "image",
    requires: [ToolCapabilityPort],
    tools: [boundTool(ports, ABSENT_MACHINE_PORTS, (live) => createImageTool(live.image))],
  });
}
