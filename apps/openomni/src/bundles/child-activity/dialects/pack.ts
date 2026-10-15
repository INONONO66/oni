import type { ChildLifecycleEvidence, TranscriptRef } from "@openomni/protocol";
import { z } from "zod";

export const Manifest = z.strictObject({
  id: z.string().min(1),
  versions: z.string().min(1),
  commands: z.array(z.string().min(1)).min(1),
  screen: z.strictObject({
    permission_prompt: z.array(z.string().min(1)).min(1),
    idle_prompt: z.array(z.string().min(1)).min(1),
    working: z.array(z.string().min(1)).min(1),
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
  readonly launch: (sessionId: string, hooksConfigPath: string) => Launch;
  readonly live: (line: string, context: LiveContext) => ChildLifecycleEvidence;
  readonly transcript: (record: string, context: TranscriptContext) => ChildLifecycleEvidence;
  readonly submit: (text: string) => SubmitRecipe;
}

export class DialectDecodeError extends Error {
  constructor(
    readonly source: "live" | "transcript",
    readonly code: "malformed" | "stale_seq" | "unsupported",
  ) {
    super(`${source}: ${code}`);
    this.name = "DialectDecodeError";
  }
}
