import type { PartKind } from "./spacing";
import type {
  TranscriptAssistant,
  TranscriptAttachment,
  TranscriptEpoch,
  TranscriptMarkdown,
  TranscriptNode,
  TranscriptPrompt,
  TranscriptTool,
} from "./model";

/**
 * Segmenting the flat ledger into the parts the column actually draws.
 *
 * The one structural claim this file makes is CHRONOLOGY: tool calls are shown
 * where they happened, not gathered into a per-turn appendix. If the agent read
 * a file, said something, then ran a test, the column shows read → text → test.
 * Sorting all the work to the top of the turn would be tidier and would be a
 * lie about the order the agent thought in, which is the one thing a transcript
 * exists to preserve.
 *
 * That is why a prose part SPLITS a tool group. Adjacency in the data is the
 * only thing that makes two calls one block; a sentence between them means they
 * were two separate pieces of work and they are drawn that way.
 */

/** One prose block of an agent answer, addressed on its own. */
interface ProsePart {
  readonly kind: "prose";
  readonly id: string;
  readonly block: TranscriptMarkdown;
  /** The tail of a streaming answer — the one place a caret may blink. */
  readonly streamingTail: boolean;
}

/** A run of adjacent tool calls, with nothing between them. */
interface ToolsPart {
  readonly kind: "tools";
  readonly id: string;
  readonly calls: readonly TranscriptTool[];
}

interface UserPart {
  readonly kind: "user";
  readonly id: string;
  readonly content: readonly (TranscriptPrompt | TranscriptAttachment)[];
}

interface EpochPart {
  readonly kind: "epoch";
  readonly id: string;
  readonly label: string;
  readonly at: string;
}

export type TurnPart = UserPart | ProsePart | ToolsPart | EpochPart | TranscriptAttachment;

/**
 * A turn: one user message and everything the agent did in reply.
 *
 * An epoch is its own turn with no parts but itself, because it belongs to
 * neither the exchange above nor the one below — it is a fact about the ledger
 * between them.
 */
export interface Turn {
  readonly id: string;
  /** 1-based, for anchors. Epoch pseudo-turns take a number too, so the
      numbering stays positional and countable down the column. */
  readonly index: number;
  readonly parts: readonly TurnPart[];
}

/** `PartKind` for spacing, derived rather than stored so the two cannot drift. */
export function partKind(part: TurnPart): PartKind {
  return part.kind === "attachment" ? "tools" : part.kind;
}

/**
 * Split the ledger into turns, and each turn into parts in ARRIVAL ORDER.
 *
 * A new turn opens on a user message or an epoch, and on nothing else. Agent
 * output that arrives with no prompt above it (a resumed session, a
 * self-initiated run) lands in a leading turn with no user part — the column
 * simply starts with the response, which is what happened.
 */
export function segmentTurns(nodes: readonly TranscriptNode[]): readonly Turn[] {
  const turns: Turn[] = [];
  let parts: TurnPart[] = [];
  let index = 0;

  const flush = () => {
    if (parts.length === 0) return;
    index += 1;
    turns.push({ id: `turn-${index}`, index, parts });
    parts = [];
  };

  for (const node of nodes) {
    if (node.kind === "epoch") {
      flush();
      parts = [epochPart(node)];
      flush();
      continue;
    }

    if (node.kind === "prompt" || (node.kind === "attachment" && node.promptId !== undefined)) {
      const id = node.promptId ?? node.id;
      const open = parts[parts.length - 1];
      if (open?.kind === "user" && open.id === id) {
        parts[parts.length - 1] = { ...open, content: [...open.content, node] };
      } else {
        flush();
        parts.push({ kind: "user", id, content: [node] });
      }
      continue;
    }

    if (node.kind === "attachment") {
      parts.push(node);
      continue;
    }

    if (node.kind === "tool") {
      // Adjacency is the ONLY thing that groups: extend the open tool part if
      // one is directly above, otherwise start a new one. A prose part between
      // two calls therefore ends the first group by construction, with no rule
      // needed to say so.
      // Indexed rather than `.at(-1)`: `Array.prototype.at` is ES2022 and the
      // renderer compiles against `lib: ES2021`, so `.at` type-errors in
      // `apps/desktop` while resolving fine here. `noUncheckedIndexedAccess`
      // makes this `TurnPart | undefined`, which is exactly what the optional
      // chain below already expects.
      const open = parts[parts.length - 1];
      if (open?.kind === "tools") {
        parts[parts.length - 1] = { ...open, calls: [...open.calls, node] };
      } else {
        parts.push({ kind: "tools", id: `tools-${node.id}`, calls: [node] });
      }
      continue;
    }

    parts.push(...prosePartsOf(node));
  }

  flush();
  return turns;
}

function epochPart(node: TranscriptEpoch): EpochPart {
  return { kind: "epoch", id: node.id, label: node.label, at: node.at };
}

/** Each markdown block is its own part, so paragraphs take the 6px step. */
function prosePartsOf(node: TranscriptAssistant): readonly ProsePart[] {
  return node.blocks.map((block, at) => ({
    kind: "prose",
    id: `${node.id}.${at}`,
    block,
    streamingTail: node.streaming && at === node.blocks.length - 1,
  }));
}
