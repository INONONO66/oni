# Console forms

## Contract

`src/styles.css` owns the console's achromatic surfaces, single blue accent,
Pretendard type scale, spacing, radii and focus treatment. Forms use that
existing system in both `[data-theme="light"]` and the default dark theme.
Application routing, record state and wire decisions remain in desktop.

## Tokens

- Surfaces: `bg`, `sunken`, `raised`; interaction fills: `hover`, `active`.
- Text: `fg`, `fg-muted`; primary action: `accent` with `accent-fg`.
- Type: `display` for the view title, `title` for sections, `body` for controls,
  `label` for secondary evidence and hints.
- Geometry: `rounded-md`, the existing 4px utility spacing steps, `section`
  padding and the `measure` content width. No new palette or type tokens.
- Focus: the shared `focus-ring` utility. Selection and status also have text,
  not just color.

## Primitives

`Field` binds a visible label and optional help text to one native control.
Field errors appear below that control in the existing foreground label tone,
with `aria-invalid` and `aria-describedby` linking the error and any help text.
`Input`, `Select` and `Textarea` retain native keyboard and form semantics.
Controls fill their available width and shrink inside a narrow container.
`ActionButton` defaults to a non-submitting button; only an explicit submit
button saves. Primary, secondary and destructive variants share geometry.
Disabled, pressed, hover and keyboard focus states stay visible.
All primitive addresses come from `src/names.ts`.

## Composition and scrolling

The sidebar column (`sidebar-nav.tsx`, `tree-row.tsx`) stacks four rows and
lands every first glyph or label on one x, 8px of column inset plus 8px of
row inset. `SidebarHeader` is a 44px row: brand at the left, actions at the
right, the collapse toggle last. `SidebarNav` holds 28px `NavItem`s, each a
14px glyph at the 1.5px line and a `label` weight 500 text, `bg-active` when
`aria-current="page"`. `SidebarSection` takes the remaining height: a 28px
`SectionHeader` whose label gives way to `SectionSearchInput` on the same x
when its one control turns from magnifier to close, and a `SectionList` that
owns the scroll and the 1px row rhythm. `TreeRow` draws three shapes from its
props: a group row (`expanded` set) with a chevron in the 16px slot, the label,
and a `trailing` count in `fg-faint`; a two-line session row (`secondary` set)
on a `1rem 1fr` grid, minimum 44px tall, the `leading` glyph seated on the
title line, the title with `trailing` right-aligned in tabular `meta`, and the
`secondary` line under it in `fg-subtle`; and a bare leaf that alone steps in
by `level`. `SidebarFooter` is the last row, padded 8px over a 0.5px hairline;
the consumer fills it (desktop puts its gateway status row there).

`ConsoleContent` retains the existing bounded `ScrollArea` as the view's
vertical scroll owner. Record sections stack in schema order. Related pairs
use two columns when room permits and one column at narrow widths. Action
groups wrap. Event IDs, digests and reasons wrap rather than widen the ledger.
The ledger uses a semantic table with disclosure elements for evidence.

## States and accessibility

Loading, offline, empty and refused operations render next to their view.
Refusals persist inline. Pending session proposals have a labeled approval
affordance and cannot be enabled by editing. Mutation controls remain disabled
until the server mutation and authoritative reread settle.
Destructive removal requires confirmation and offers a keep action.
The delivery controls remain exactly two independent axes: target and kind.
Native disclosure, select and button behavior provides keyboard alternatives.
No new animation is introduced.

## Verification boundary

The test-only automation preview composes the actual desktop views and shared
primitives over a schema-checked fixture WebSocket. Production code contains
no fixture data. Desktop and narrow captures cover both themes, the editor
end, expanded ledger evidence and approval state. The fixed console type
scale is retained at narrow widths; this is a desktop window, not a separate
mobile product.
