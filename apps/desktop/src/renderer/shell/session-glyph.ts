import type { StatusGlyph } from "@oni/ui";
import type { ComponentProps } from "react";
import type { SessionPhase } from "../state/store";

const GLYPH: Record<SessionPhase, ComponentProps<typeof StatusGlyph>> = {
  queued: { tone: "progress", shape: "ring" },
  running: { tone: "progress", shape: "spinner" },
  waiting_approval: { tone: "attention", shape: "dot-pulse" },
  waiting_input: { tone: "attention", shape: "dot-pulse" },
  interrupted: { tone: "muted", shape: "pause" },
  completed: { tone: "success", shape: "check" },
  failed: { tone: "destructive", shape: "cross" },
  idle: { tone: "muted", shape: "hollow" },
  archived: { tone: "faint", shape: "hollow" },
};

export function sessionGlyphProps(phase: SessionPhase | null): ComponentProps<typeof StatusGlyph> {
  return phase === null ? { tone: "muted", shape: "hollow" } : GLYPH[phase];
}
