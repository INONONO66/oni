import { Button as BaseButton } from "@base-ui/react/button";
import { Input as BaseInput } from "@base-ui/react/input";
import { Search, X } from "lucide-react";
import { type ReactNode, type Ref, useId } from "react";
import { UI_NAMES } from "./names";
import { IconButton } from "./primitives/button";
import { ScrollArea } from "./primitives/scroll-area";
import { Text } from "./primitives/surface";

/**
 * The sidebar column's rows, top to bottom: a nav of 28px items directly
 * under the strip, a section whose 32px header can turn into a search field, and a
 * footer over a hairline. Every height is measured from the reference console
 * (docs/desktop-shell.md); the words in them are the app's.
 */

export function SidebarNav({ children }: { readonly children: ReactNode }) {
  return (
    <nav
      aria-label="Main"
      className="flex shrink-0 flex-col gap-px px-2 py-1"
      data-ui={UI_NAMES.SidebarNav}
    >
      {children}
    </nav>
  );
}

/**
 * One destination: a 16px glyph at the frame's 1.5px line and a label on a 28px
 * row, the row's full width wherever it sits (the nav's column, the footer's row).
 */
export function NavItem({
  icon,
  active = false,
  children,
  ...rest
}: {
  readonly icon: ReactNode;
  readonly active?: boolean;
  readonly children: ReactNode;
} & Omit<BaseButton.Props, "className" | "children" | "render" | "style">) {
  return (
    <BaseButton
      aria-current={active ? "page" : undefined}
      className={`focus-ring [&_svg]:glyph-stroke flex h-7 w-full select-none items-center gap-2 rounded-sm px-2 font-medium text-label transition-quiet motion-reduce:transition-none [&_svg]:size-4 [&_svg]:shrink-0 ${
        active ? "bg-hover text-fg" : "text-fg-muted hover:bg-hover hover:text-fg"
      }`}
      data-ui={UI_NAMES.NavItem}
      {...rest}
    >
      {icon}
      <span className="truncate">{children}</span>
    </BaseButton>
  );
}

/** The column's main region: it takes whatever height the rows above leave. */
export function SidebarSection({ children }: { readonly children: ReactNode }) {
  return <div className="mt-3 flex min-h-0 flex-1 flex-col">{children}</div>;
}

/**
 * The section's scrolling body: the rows under the header, on the nav's own
 * rhythm (1px apart, 8px in), taking the section's remaining height. The
 * consumer lays its tree inside; this owns only the scroll and the spacing.
 */
export function SectionList({ children }: { readonly children: ReactNode }) {
  return (
    <ScrollArea className="flex-1" contentClassName="flex flex-col gap-px px-2 pb-2">
      {children}
    </ScrollArea>
  );
}

/**
 * The section's title row, or — while searching — its search field.
 *
 * One 32px row, one control. At rest the label sits on the `pl-4` text x and
 * the control is a magnifier; searching swaps the label for the field (drawn by
 * the consumer through `SectionSearchInput`, because the query and its
 * keyboard semantics are the consumer's), pulls the inset to `pl-2` so the
 * caret lands where the label's first glyph was, and turns the control into
 * a close. `resultLabel` is the ambient count under the row while filtering.
 */
export function SectionHeader({
  label,
  searching,
  onSearchingChange,
  searchLabel,
  resultLabel,
  children,
}: {
  readonly label: string;
  readonly searching: boolean;
  readonly onSearchingChange: (searching: boolean) => void;
  /** The accessible name of the open-search control; the consumer names what is searched. */
  readonly searchLabel: string;
  readonly resultLabel?: string | undefined;
  /** The search field, rendered only while `searching`. */
  readonly children?: ReactNode;
}) {
  return (
    <div data-ui={UI_NAMES.SectionHeader}>
      <div
        className={`flex h-8 items-center gap-1 px-2 pb-1 ${searching ? "pl-2" : "pl-4"}`}
        data-searching={searching ? "" : undefined}
      >
        {searching ? (
          children
        ) : (
          <Text className="truncate font-semibold" level="label" tone="fg">
            {label}
          </Text>
        )}
        <IconButton
          className="ml-auto"
          data-ui={UI_NAMES.SectionHeaderToggle}
          label={searching ? "Close search" : searchLabel}
          onClick={() => onSearchingChange(!searching)}
          size="sm"
        >
          {searching ? <X /> : <Search />}
        </IconButton>
      </div>
      {resultLabel !== undefined && (
        <Text aria-live="polite" as="p" className="px-4 pb-1" level="meta" numeric tone="faint">
          {resultLabel}
        </Text>
      )}
    </div>
  );
}

/**
 * The section header's search field: blank, autofocused, set exactly like the
 * label it replaced so the swap moves nothing but the caret. Headless-backed
 * and data-blind — it owns the combobox wiring and nothing about the data.
 */
export function SectionSearchInput({
  label,
  placeholder,
  value,
  onValueChange,
  onKeyDown,
  inputRef,
  controlsId,
  activeDescendantId,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  readonly inputRef: Ref<HTMLInputElement>;
  /** The element this field filters, for `aria-controls`. */
  readonly controlsId: string;
  readonly activeDescendantId?: string | undefined;
}) {
  const id = useId();
  return (
    <>
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <BaseInput
        aria-activedescendant={activeDescendantId}
        aria-autocomplete="list"
        aria-controls={controlsId}
        aria-expanded={value.length > 0}
        autoComplete="off"
        autoFocus
        className="min-w-0 flex-1 bg-transparent px-2 font-medium text-fg text-meta caret-fg outline-none selection:bg-accent selection:text-accent-fg placeholder:text-fg-faint"
        id={id}
        onKeyDown={onKeyDown}
        onValueChange={onValueChange}
        placeholder={placeholder}
        ref={inputRef}
        role="combobox"
        type="text"
        value={value}
      />
    </>
  );
}

/** The column's bottom row, above a hairline. */
export function SidebarFooter({ children }: { readonly children: ReactNode }) {
  return (
    <div
      className="flex shrink-0 items-center gap-1 border-line border-t-[0.5px] p-2"
      data-ui={UI_NAMES.SidebarFooter}
    >
      {children}
    </div>
  );
}
