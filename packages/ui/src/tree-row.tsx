import { Button as BaseButton } from "@base-ui/react/button";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { UI_NAMES } from "./names";

type TreeLevel = 0 | 1 | 2;

/**
 * Rows share one x: hierarchy is the group heading above a run of rows, not
 * indentation. Only a bare leaf (no group, no secondary line) still steps in
 * by `level`.
 */
const LEVEL: Record<TreeLevel, string> = {
  0: "pl-2",
  1: "pl-[calc(var(--spacing-inset)+var(--spacing-indent))]",
  2: "pl-[calc(var(--spacing-inset)+var(--spacing-indent)*2)]",
};

const ROW =
  "focus-ring w-full select-none rounded-md text-left text-label transition-quiet active:bg-active disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0";

const GROUP = "flex h-7 items-center gap-2 px-2 font-medium text-fg-subtle hover:text-fg-muted";
const SESSION = "grid min-h-11 grid-cols-[1rem_1fr] gap-x-2 gap-y-0.5 px-2 py-1.5";
const LEAF = "flex h-7 items-center gap-2 pr-2";

const SLOT = "flex size-4 shrink-0 items-center justify-center";

function wash(current: boolean): string {
  return current ? "bg-active text-fg" : "text-fg-muted hover:bg-hover";
}

function GroupLine({
  expanded,
  trailing,
  children,
}: {
  readonly expanded: boolean;
  readonly trailing: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <>
      <span className={SLOT}>
        <ChevronRight
          aria-hidden
          className={`size-3.5 transition-quiet motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
        />
      </span>
      <span className="min-w-0 truncate">{children}</span>
      {trailing != null && <span className="shrink-0 font-normal text-fg-faint">{trailing}</span>}
    </>
  );
}

function SessionLines({
  leading,
  secondary,
  trailing,
  children,
}: {
  readonly leading: ReactNode;
  readonly secondary: ReactNode;
  readonly trailing: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <>
      {/* pt-1 seats an 8px dot 4px into the box, on the title line's centre. */}
      <span className="row-span-2 flex size-4 items-start justify-center pt-1">{leading}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate">{children}</span>
        {trailing != null && (
          <span className="ml-auto shrink-0 text-fg-subtle text-meta tabular-nums">{trailing}</span>
        )}
      </span>
      <span className="min-w-0 truncate text-fg-subtle text-meta" data-secondary="">
        {secondary}
      </span>
    </>
  );
}

export function TreeRow({
  level = 0,
  current = false,
  expanded,
  leading,
  secondary,
  trailing,
  children,
  ...rest
}: {
  readonly level?: TreeLevel;
  readonly current?: boolean;
  /** Set only on a row that opens a group; the chevron reports it. */
  readonly expanded?: boolean | undefined;
  /** The glyph in the row's 16px slot; a group row's slot holds the chevron instead. */
  readonly leading?: ReactNode;
  readonly secondary?: ReactNode;
  /** After the text: beside the label on a group row, at the right edge on a session row. */
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
} & Omit<BaseButton.Props, "className" | "children" | "render" | "style">) {
  const group = expanded !== undefined;
  const double = !group && secondary != null;
  const shape = group ? GROUP : `${double ? SESSION : `${LEAF} ${LEVEL[level]}`} ${wash(current)}`;
  return (
    <BaseButton
      aria-current={current ? "true" : undefined}
      aria-expanded={expanded}
      className={`${ROW} ${shape}`}
      data-density={double ? "double" : "single"}
      data-level={level}
      data-ui={UI_NAMES.TreeRow}
      {...rest}
    >
      {group && (
        <GroupLine expanded={expanded} trailing={trailing}>
          {children}
        </GroupLine>
      )}
      {double && (
        <SessionLines leading={leading} secondary={secondary} trailing={trailing}>
          {children}
        </SessionLines>
      )}
      {!(group || double) && (
        <>
          <span className={SLOT}>{leading}</span>
          <span className="min-w-0 flex-1 truncate">{children}</span>
          {trailing}
        </>
      )}
    </BaseButton>
  );
}
