import { Button as BaseButton } from "@base-ui/react/button";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { UI_NAMES } from "./names";

type TreeLevel = 0 | 1 | 2;

/**
 * Depth is padding, and nothing else: no spine, no elbow, no dot. Three
 * levels, one `--spacing-indent` step apart, so the tree's whole hierarchy is
 * stated by where each row's text starts.
 */
const LEVEL: Record<TreeLevel, string> = {
  0: "pl-2",
  1: "pl-[calc(var(--spacing-inset)+var(--spacing-indent))]",
  2: "pl-[calc(var(--spacing-inset)+var(--spacing-indent)*2)]",
};

/**
 * One line of the tree: 28px tall, the label truncated, the row's own fill
 * only when it is the current one. A row that can open (`expanded` is a
 * boolean) leads with a chevron that turns; a leaf has no glyph at all, so a
 * closed group and a leaf differ by the one mark that means something.
 *
 * A group row reads as a heading, not as a sibling of the rows it opens: the
 * meta size, the faint tone, no fill of its own. The reference console labels
 * its groups the same way, so the eye lands on the sessions and reads the
 * group name only when it wants the boundary.
 */
function height(double: boolean, group: boolean): string {
  if (double) return "min-h-7 py-1.5";
  return group ? "h-6" : "h-7";
}

function tone(current: boolean, group: boolean): string {
  if (group) return "text-fg-faint text-meta hover:text-fg-muted";
  if (current) return "bg-raised font-medium text-fg text-label";
  return "text-fg text-label hover:bg-hover";
}
export function TreeRow({
  level = 0,
  current = false,
  expanded,
  secondary,
  trailing,
  children,
  ...rest
}: {
  readonly level?: TreeLevel;
  readonly current?: boolean;
  readonly secondary?: ReactNode;
  /** Rendered after the text block, centered on the row's full height. */
  readonly trailing?: ReactNode;
  /** Set only on a row that opens a group; the chevron reports it. */
  readonly expanded?: boolean | undefined;
  readonly children: ReactNode;
} & Omit<BaseButton.Props, "className" | "children" | "render" | "style">) {
  return (
    <BaseButton
      aria-current={current ? "true" : undefined}
      aria-expanded={expanded}
      className={`focus-ring flex w-full select-none items-center gap-1.5 rounded-sm pr-2 text-left transition-quiet active:bg-active disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 ${tone(
        current,
        expanded !== undefined,
      )} ${height(secondary != null, expanded !== undefined)} ${LEVEL[level]}`}
      data-density={secondary == null ? "single" : "double"}
      data-level={level}
      data-ui={UI_NAMES.TreeRow}
      {...rest}
    >
      {expanded !== undefined && (
        <ChevronRight
          aria-hidden
          className={`size-3 transition-quiet motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
        />
      )}
      <span className="min-w-0 flex-1 truncate">
        {children}
        {secondary != null && (
          <span className="block truncate text-fg-muted text-meta" data-secondary="">
            {secondary}
          </span>
        )}
      </span>
      {trailing}
    </BaseButton>
  );
}
