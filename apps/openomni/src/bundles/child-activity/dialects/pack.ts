import type { ChildLifecycleEvidence, TranscriptRef } from "@openomni/protocol";
import { z } from "zod";

const ScreenPattern = z
  .string()
  .min(2)
  .refine((pattern) => {
    if (!pattern.startsWith("^") || !pattern.endsWith("$")) return false;
    try {
      new RegExp(pattern);
      return true;
    } catch (error) {
      if (error instanceof SyntaxError) return false;
      throw error;
    }
  }, "expected a valid anchored regular expression");

export const Manifest = z.strictObject({
  id: z.string().min(1),
  versions: z.string().min(1),
  commands: z.array(z.string().min(1)).min(1),
  screen: z.strictObject({
    permission_prompt: z.array(ScreenPattern).min(1),
    idle_prompt: z.array(ScreenPattern).min(1),
    working: z.array(ScreenPattern).min(1),
  }),
  capabilities: z.strictObject({
    live: z.enum(["hooks", "extension", "none"]),
    transcript: z.enum(["jsonl", "sqlite", "none"]),
    permission_decision: z.boolean(),
    correlated_launch: z.boolean(),
  }),
});
export type Manifest = z.infer<typeof Manifest>;

interface EvidenceContext {
  readonly child: string;
  readonly turn: string;
}

export interface LiveContext extends EvidenceContext {
  readonly lastSeq: number;
}

export interface TranscriptContext extends EvidenceContext {
  readonly ref: TranscriptRef;
}

export interface Launch {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface LaunchInput {
  readonly sessionId: string;
  readonly liveConfigPath?: string;
}

export interface SubmitRecipe {
  readonly writes: readonly [
    { readonly kind: "text"; readonly value: string },
    { readonly kind: "enter" },
  ];
  readonly enterDelayMs: number;
  readonly stallWindowMs: number;
  readonly refuseWhenWaiting: boolean;
}

export interface DialectPack {
  readonly manifest: Manifest;
  readonly launch?: (input: LaunchInput) => Launch;
  readonly live?: (line: string, context: LiveContext) => ChildLifecycleEvidence;
  readonly transcript?: (record: string, context: TranscriptContext) => ChildLifecycleEvidence;
  readonly submit: (text: string) => SubmitRecipe;
}

export type ScreenState = keyof Manifest["screen"];

/**
 * Match anchored regexes against trimmed bottom non-empty rows only. Order is
 * permission_prompt > working > idle_prompt; unmatched screens remain unknown.
 */
export function matchScreen(manifest: Manifest, screen: string): ScreenState | undefined {
  const rows = screen
    .split("\n")
    .map((row) => row.trim())
    .filter((row) => row.length > 0)
    .slice(-20);
  for (const state of ["permission_prompt", "working", "idle_prompt"] as const) {
    if (manifest.screen[state].some((pattern) => rows.some((row) => new RegExp(pattern).test(row))))
      return state;
  }
  return undefined;
}

export class DialectDecodeError extends Error {
  constructor(
    readonly source: "live" | "transcript",
    readonly code: "malformed" | "stale_seq" | "unsupported",
    /** A `stale_seq` refusal names the refused sequence so the consumer can match the earlier receipt. */
    readonly detail?: { readonly seq?: number },
  ) {
    super(`${source}: ${code}`);
    this.name = "DialectDecodeError";
  }
}
