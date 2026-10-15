import type { ComponentProps, ReactNode } from "react";
import { Composer } from "./composer";
import { UI_NAMES } from "./names";
import { ScrollArea } from "./primitives/scroll-area";
import { Panel } from "./primitives/surface";
import { Sidebar } from "./sidebar";
import { TabStrip } from "./tab-strip";
import type { PendingApproval, TranscriptNode, TurnCost } from "./timeline/model";
import { Timeline } from "./timeline/timeline";
import { Voice } from "./timeline/voice";

export function Console({
  shell,
  strip,
  sidebar,
  content,
  transcript,
  emptyLabel,
}: {
  readonly shell: ConsoleShell;
  readonly strip: ConsoleStrip;
  readonly sidebar: ReactNode;
  readonly content?: ReactNode;
  readonly transcript?: ConsoleTranscript | undefined;
  readonly emptyLabel?: string | undefined;
}) {
  const active = strip.tabs.find((tab) => tab.active);
  return (
    <Sidebar
      data-density="shell"
      floating={shell.sidebarFloating}
      onFloatingChange={shell.onSidebarFloatingChange}
      onToggle={shell.onToggleSidebar}
      onWidthCommit={shell.onSidebarWidthCommit}
      open={shell.sidebarOpen}
      width={shell.sidebarWidth}
    >
      <TabStrip {...strip} />
      <Sidebar.Gap />
      <Sidebar.Container>{sidebar}</Sidebar.Container>
      <Panel
        as="main"
        className="mr-2 mb-2 flex min-w-0 flex-1 flex-col transition-[margin-left] duration-base ease-frame group-data-[sidebar-state=collapsed]/sidebar:ml-2 group-data-[resizing]/sidebar:duration-0 motion-reduce:transition-none"
        edge="box"
        tone="bg"
      >
        <div
          className="flex min-h-0 flex-1 flex-col"
          {...(active === undefined
            ? {}
            : {
                role: "tabpanel",
                id: `tab-panel-${active.id}`,
                "aria-labelledby": `tab-${active.id}`,
              })}
        >
          {content === undefined ? (
            <ConsoleContent emptyLabel={emptyLabel} transcript={transcript} />
          ) : (
            content
          )}
        </div>
      </Panel>
    </Sidebar>
  );
}

export function ConsoleContent({
  transcript,
  emptyLabel,
  children,
  header,
}: {
  readonly header?: ReactNode;
  readonly transcript?: ConsoleTranscript | undefined;
  readonly emptyLabel?: string | undefined;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-ui={UI_NAMES.ConsoleContent}>
      {header}
      <ScrollArea
        className="flex-1"
        contentClassName="mx-auto w-full max-w-measure px-section pt-4 pb-section"
        pinToEnd={transcript !== undefined}
      >
        {transcript === undefined ? (
          (children ?? (
            <Voice className="text-voice-ambient" voice="meta">
              {emptyLabel}
            </Voice>
          ))
        ) : (
          <Timeline
            costs={transcript.costs}
            emptyLabel={emptyLabel}
            nodes={transcript.nodes}
            sessionId={transcript.id}
          />
        )}
      </ScrollArea>
      {transcript !== undefined &&
        transcript.onDraftChange !== undefined &&
        transcript.onSubmit !== undefined && (
          <Composer
            disabled={transcript.composerDisabled}
            hint={transcript.composerHint}
            meta={transcript.composerMeta}
            onApprove={transcript.onApprove}
            onDeny={transcript.onDeny}
            onNext={transcript.onNextApproval}
            onStop={transcript.onStop}
            onSubmit={transcript.onSubmit}
            onValueChange={transcript.onDraftChange}
            pending={transcript.pending}
            sending={transcript.sending}
            value={transcript.draft ?? ""}
          />
        )}
    </div>
  );
}

/** The frame's state: the app owns it, persists it, and hands it down. */
export interface ConsoleShell {
  readonly sidebarOpen: boolean;
  /** Collapsed but revealed by hover as an overlay. Transient: never persisted. */
  readonly sidebarFloating: boolean;
  /** Already clamped by `clampSidebarWidth`. */
  readonly sidebarWidth: number;
  /** Open ↔ collapsed; while floating, this pins the overlay open. */
  readonly onToggleSidebar: () => void;
  readonly onSidebarFloatingChange: (floating: boolean) => void;
  readonly onSidebarWidthCommit: (width: number) => void;
}

export type ConsoleStrip = ComponentProps<typeof TabStrip>;

interface ConsoleTranscript {
  /** The key transcript expansion state is remembered under. */
  readonly id: string;
  readonly nodes: readonly TranscriptNode[];
  readonly costs?: Readonly<Record<number, TurnCost>>;
  readonly draft?: string;
  readonly onDraftChange?: ((value: string) => void) | undefined;
  readonly onSubmit?: (() => void) | undefined;
  /** Interrupt the turn in flight. The composer's primary action while sending. */
  readonly onStop?: (() => void) | undefined;
  readonly sending?: boolean;
  /** No wire behind the field. `composerHint` is where the surface says why. */
  readonly composerDisabled?: boolean;
  readonly composerHint?: string | undefined;
  readonly composerMeta?: string | undefined;
  readonly pending?: readonly PendingApproval[];
  readonly onApprove?: ((toolId: string) => void) | undefined;
  readonly onDeny?: ((toolId: string) => void) | undefined;
  readonly onNextApproval?: (() => void) | undefined;
}
