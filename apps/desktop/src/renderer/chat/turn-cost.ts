import { segmentTurns, type TranscriptNode, type TurnCost } from "@oni/ui";
import type { TurnMetadata } from "./message";

export function costOf(metadata: TurnMetadata | undefined): TurnCost | undefined {
  if (metadata?.startedAt === undefined || metadata.elapsedMs === undefined) return;
  return { at: clock(metadata.startedAt), elapsed: elapsed(metadata.elapsedMs) };
}

function clock(at: number): string {
  const local = new Date(at);
  return `${pad(local.getHours())}:${pad(local.getMinutes())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

function elapsed(ms: number): string {
  if (ms < SECOND) return `${Math.round(ms)}ms`;
  if (ms < MINUTE) return `${(ms / SECOND).toFixed(1)}s`;
  return `${Math.floor(ms / MINUTE)}m ${Math.round((ms % MINUTE) / SECOND)}s`;
}

export function costsByTurn(
  nodes: readonly TranscriptNode[],
  anchors: readonly { readonly nodeId: string; readonly cost: TurnCost }[],
): Readonly<Record<number, TurnCost>> {
  if (anchors.length === 0) return {};

  const turnOf = new Map<string, number>();
  for (const turn of segmentTurns(nodes)) {
    for (const part of turn.parts) {
      if (part.kind === "tools") {
        for (const call of part.calls) turnOf.set(call.id, turn.index);
        continue;
      }
      // A prose part is addressed `${nodeId}.${blockIndex}`; the anchor is the
      // node, so the prefix is what identifies it.
      turnOf.set(
        part.kind === "prose" ? part.id.slice(0, part.id.lastIndexOf(".")) : part.id,
        turn.index,
      );
    }
  }

  const costs: Record<number, TurnCost> = {};
  for (const { nodeId, cost } of anchors) {
    const index = turnOf.get(nodeId);
    if (index !== undefined) costs[index] = cost;
  }
  return costs;
}
