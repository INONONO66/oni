import { useCallback, useState } from "react";
import { UI_NAMES } from "../names";
import { EpochRule } from "../primitives/epoch-rule";
import { anchorId } from "./anchor";
import { AttachmentRow } from "./attachment-row";
import { MarkdownBlockView } from "./markdown-block";
import type { TranscriptNode, TranscriptTool, TurnCost } from "./model";
import { spacingClass } from "./spacing";
import { ToolGroup } from "./tool-rows";
import { type Turn, type TurnPart, partKind, segmentTurns } from "./turns";

const TURN_GAP_CLASS = spacingClass("prose", "user");

const EMPTY: ReadonlySet<string> = new Set<string>();

/** Open tool payloads, together with the session they were opened in. */
export type Expansion = { readonly session: string; readonly open: ReadonlySet<string> };

export function expansionFor(held: Expansion, session: string): ReadonlySet<string> {
  return held.session === session ? held.open : EMPTY;
}
import { Voice } from "./voice";

export function Timeline({
  nodes,
  costs = {},
  sessionId,
  emptyLabel = "No turns in this session yet.",
}: {
  readonly nodes: readonly TranscriptNode[];
  /** Per-turn time and elapsed, shown on hover or focus only. */
  readonly costs?: Readonly<Record<number, TurnCost>>;
  /** Scopes tool-expansion state, so switching sessions does not carry it. */
  readonly sessionId: string;
  /** The empty state's sentence. The surface's words, with a neutral default. */
  readonly emptyLabel?: string;
}) {
  const turns = segmentTurns(nodes);

  const [state, setState] = useState<Expansion>(() => ({ session: sessionId, open: EMPTY }));
  const expanded = expansionFor(state, sessionId);
  if (expanded !== state.open) setState({ session: sessionId, open: expanded });

  const onToggle = useCallback((id: string) => {
    setState((was) => {
      const next = new Set(was.open);
      if (!next.delete(id)) next.add(id);
      return { session: was.session, open: next };
    });
  }, []);

  if (turns.length === 0) {
    return (
      <Voice className="text-voice-ambient" data-ui={UI_NAMES.Timeline} voice="meta">
        {emptyLabel}
      </Voice>
    );
  }

  return (
    <div
      className="flex flex-col"
      data-session={sessionId}
      data-transcript
      data-ui={UI_NAMES.Timeline}
    >
      {turns.map((turn, index) => (
        <TurnView
          cost={costs[turn.index]}
          expanded={expanded}
          first={index === 0}
          key={turn.id}
          onToggle={onToggle}
          turn={turn}
        />
      ))}
    </div>
  );
}

const AGENT_PART: ReadonlySet<TurnPart["kind"]> = new Set<TurnPart["kind"]>([
  "prose",
  "tools",
  "epoch",
  "attachment",
]);

function TurnView({
  turn,
  cost,
  first,
  expanded,
  onToggle,
}: {
  readonly turn: Turn;
  readonly cost: TurnCost | undefined;
  readonly first: boolean;
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
}) {
  let row = 0;
  const nextAnchor = () => {
    row += 1;
    return anchorId(turn.index, row);
  };

  const answered = turn.parts.some((part) => AGENT_PART.has(part.kind));

  return (
    <div data-turn={turn.index} data-ui={UI_NAMES.Turn}>
      {turn.parts.map((part, index) => {
        const previous = turn.parts[index - 1];
        const gap =
          previous === undefined
            ? first
              ? ""
              : TURN_GAP_CLASS
            : spacingClass(partKind(previous), partKind(part));

        return (
          <PartView
            anchor={nextAnchor}
            className={gap}
            expanded={expanded}
            key={part.id}
            onToggle={onToggle}
            part={part}
          />
        );
      })}
      {answered && cost !== undefined && <TurnTime cost={cost} />}
    </div>
  );
}

function TurnTime({ cost }: { readonly cost: TurnCost }) {
  return (
    <Voice
      className={`block text-voice-ambient ${TIME_GAP_CLASS}`}
      data-turn-time
      data-ui={UI_NAMES.TurnMeta}
      voice="meta"
    >
      {cost.at} · {cost.elapsed}
    </Voice>
  );
}

const TIME_GAP_CLASS = spacingClass("prose", "tools");

function PartView({
  part,
  className,
  anchor,
  expanded,
  onToggle,
}: {
  readonly part: TurnPart;
  readonly className: string;
  readonly anchor: () => string;
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
}) {
  if (part.kind === "epoch") {
    return (
      <div className={className} data-anchor={anchor()}>
        <EpochRule label={part.label} meta={part.at} />
      </div>
    );
  }

  if (part.kind === "user") {
    return (
      <div
        className={`flex justify-end ${className}`}
        data-anchor={anchor()}
        data-ui={UI_NAMES.TurnPrompt}
        data-user-message
      >
        <div className="flex max-w-[82%] flex-col items-end">
          <Voice className="pb-1 text-voice-ambient" voice="meta">
            you
          </Voice>
          <div className="flex min-w-0 max-w-full flex-col items-end gap-2">
            {part.content.map((node) =>
              node.kind === "attachment" ? (
                <AttachmentRow attachment={node} key={node.id} />
              ) : (
                <Voice as="p" className="whitespace-pre-wrap text-left" key={node.id} voice="prose">
                  {node.text}
                </Voice>
              ),
            )}
          </div>
        </div>
      </div>
    );
  }

  if (part.kind === "attachment") {
    return (
      <div className={className} data-anchor={anchor()}>
        <AttachmentRow attachment={part} />
      </div>
    );
  }

  if (part.kind === "tools") {
    return (
      <ToolGroup
        anchorFor={() => anchor()}
        calls={part.calls}
        className={className}
        elapsed={groupElapsed(part.calls)}
        expandedIds={expanded}
        key={part.id}
        onToggle={onToggle}
      />
    );
  }

  return (
    <div className={className} data-anchor={anchor()} data-ui={UI_NAMES.TurnResponse}>
      <MarkdownBlockView block={part.block} streamingTail={part.streamingTail} />
    </div>
  );
}

function groupElapsed(calls: readonly TranscriptTool[]): string | undefined {
  if (calls.some((call) => call.status === "running" || call.status === "waiting")) {
    return undefined;
  }
  const durations: string[] = [];
  for (const call of calls) {
    if (call.duration === undefined) return undefined;
    durations.push(call.duration);
  }
  if (durations.length === 0) return undefined;
  return sumDurations(durations);
}

function sumDurations(durations: readonly string[]): string | undefined {
  let ms = 0;
  for (const duration of durations) {
    const match = /^([\d.]+)(ms|s)$/.exec(duration);
    if (match === null) return undefined;
    ms += Number(match[1]) * (match[2] === "s" ? 1000 : 1);
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}
