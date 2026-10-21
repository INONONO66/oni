import { canonicalDigest, Message } from "@oni/protocol";
import { z } from "zod";
import { latestCompactionAnchorId } from "./candidate";
import { AgentInvariantViolation } from "../../core/api";

export type CanonicalConversationEntry = Message.WithParts;

/** The evidence one executed compaction leaves behind, including its reconstruction recipe. */
export const CompactionRecord = z.object({
  summary: z.string(),
  firstKeptEntryId: z.string(),
  tokensBefore: z.number(),
  discarded: z
    .object({
      firstEntryId: z.string(),
      lastEntryId: z.string(),
      count: z.number().int(),
      sha256: z.string(),
    })
    .strict()
    .readonly(),
  revert: z
    .object({
      removedEntries: z.array(Message.WithParts).readonly(),
      priorAnchorEntryId: z.string().nullable(),
    })
    .strict()
    .readonly(),
}).readonly();
export type CompactionRecord = z.infer<typeof CompactionRecord>;

interface CompactionPlan {
  readonly projection: readonly CanonicalConversationEntry[];
  readonly record: CompactionRecord;
}

export function createCompactionPlan(
  prior: readonly CanonicalConversationEntry[],
  replacement: readonly CanonicalConversationEntry[],
  tokensBefore: number,
): CompactionPlan {
  const originals = structuredClone(prior);
  const { count: shared, first: sharedFirst } = sharedSuffix(originals, replacement);
  const finalOriginal = originals.at(-1);
  if (finalOriginal === undefined) {
    throw new AgentInvariantViolation("compaction requires original history");
  }
  // A full rewrite still retains one unchanged atomic entry. Replace an
  // elided same-ID copy rather than introducing duplicate entry identities.
  const projection =
    shared > 0
      ? replacement
      : [...replacement.filter((entry) => entry.info.id !== finalOriginal.info.id), finalOriginal];
  const suffixLength = Math.max(1, shared);
  const firstKept = sharedFirst ?? finalOriginal;
  const removedEntries = originals.slice(0, originals.length - suffixLength);
  const firstRemoved = removedEntries[0];
  const lastRemoved = removedEntries.at(-1);
  if (firstRemoved === undefined || lastRemoved === undefined) {
    throw new AgentInvariantViolation("compaction projection must discard at least one prior entry");
  }

  return {
    projection,
    record: {
      summary: compactionSummary(replacement),
      firstKeptEntryId: firstKept.info.id,
      tokensBefore,
      discarded: {
        firstEntryId: firstRemoved.info.id,
        lastEntryId: lastRemoved.info.id,
        count: removedEntries.length,
        sha256: canonicalDigest(removedEntries),
      },
      revert: {
        removedEntries,
        priorAnchorEntryId: latestCompactionAnchorId(removedEntries) ?? null,
      },
    },
  };
}

export function restoreCompactionProjection(
  projection: readonly CanonicalConversationEntry[],
  record: CompactionRecord,
): CanonicalConversationEntry[] {
  if (canonicalDigest(record.revert.removedEntries) !== record.discarded.sha256) {
    throw new AgentInvariantViolation("compaction revert payload digest mismatch");
  }
  const firstKeptIndex = projection.findIndex((entry) => entry.info.id === record.firstKeptEntryId);
  if (firstKeptIndex < 0)
    throw new AgentInvariantViolation("compaction projection no longer contains first kept entry");

  return [...record.revert.removedEntries, ...projection.slice(firstKeptIndex)];
}

function sharedSuffix(
  prior: readonly CanonicalConversationEntry[],
  replacement: readonly CanonicalConversationEntry[],
): { readonly count: number; readonly first: CanonicalConversationEntry | undefined } {
  let count = 0;
  let first: CanonicalConversationEntry | undefined;
  while (count < prior.length && count < replacement.length) {
    const before = prior[prior.length - count - 1];
    const after = replacement[replacement.length - count - 1];
    if (
      before === undefined ||
      after === undefined ||
      canonicalDigest(before) !== canonicalDigest(after)
    ) {
      break;
    }
    first = before;
    count += 1;
  }
  return { count, first };
}

function compactionSummary(entries: readonly CanonicalConversationEntry[]): string {
  for (const entry of entries) {
    for (const part of entry.parts) {
      if (part.type !== "text" || part.metadata?.compactionAnchor !== true) continue;
      const body = part.metadata.anchorBody;
      return typeof body === "string" ? body : part.text;
    }
  }
  return "";
}
