# Desktop shell

## Production build and CI smoke

The desktop production tuple is `electron-vite 5.0.0` with the workspace's Vite
`8.2.2`; the build was verified on 2026-09-08 with Bun 1.4.1 and emitted
`dist/main/index.js`, `dist/preload/index.cjs`, and `dist/renderer/index.html`.
The resolved build uses Vite 8.2.2 successfully despite electron-vite's older
peer declaration; keep the tuple pinned and re-check it when either changes.

CI builds once in `prepare`, restores `workspace-dist.tar`, and runs one
production Electron smoke when the selected plan includes `desktopApp` or `ui`.
The smoke uses Playwright `_electron` and Linux Xvfb; it does not rebuild.

Tab composition landed on `feat/desktop-tabs` (2026-09-07); menu-driven
tab commands, DOM and screenshots were verified then. Raw Cmd+T/Cmd+W keystroke
delivery is not yet proved because the macOS session was locked during QA. The
frame geometry below follows the shipped source in `packages/ui/src` and
`apps/desktop/src/main/window.ts`; when the two disagree, the code is the truth.

## Internals cleanup (PR #1047)

`refactor/desktop-cleanup` reorganizes renderer internals without changing the
shipped shell: every UI contract, glyph, density rule and behavior described
below stays as it is, and no `packages/ui` source, test or CSS changes.

`state/selectors.ts` owns three read-only derivations: `sessionIndex`, a
`Map` per immutable session-array snapshot (`WeakMap`-keyed, so it holds no state
and no clock), `historyMenuEntries` and `placeTitle`. App resolves the active
session, tab titles and glyphs and history-menu titles through that index, and
`use-search.ts` resolves search fields through it. `session-tree.tsx` and
`session-list.tsx` still build their own per-render maps from the same array;
they are unchanged.

`state/session-actions.ts` holds the three session mutations that App and tests
call: `setSessionTitleIfPlaceholder`, `setSessionPhase` and
`setSessionAttention`, moved out of `store.ts` verbatim. `store.ts` keeps every
other command and every location transition; `activePlace` and `tabTitle` are
gone because App reads `activeTab(state)?.place` and `placeTitle` directly.

`chat/session-content.tsx` owns the SDK binding. `useSessionChats` is called by
App, so one Chat per session lives for App's lifetime, its transport reference
updates in the same layout-effect phase as before, and `chat.stop()` runs only on
App teardown. `SessionContent` renders the active session's transcript and
composer; only that panel is keyed by tab id. Send, title, draft, approval and
stop ordering are unchanged (`test/session-content.test.tsx` drives Approve and
Deny through a real Chat and asserts the approval id and decision).

App's hook sequence is main's: it still subscribes to the whole store, reads
`Date.now()` on every render so relative times refresh on the same cadence, and
calls `useChatEndpoint` before its search/focus refs and `useShellLifecycle`.
Callback identities, focus effects, scroll behavior and preference writes are
untouched. `orderByAttention` classifies each session once and reuses the kind
for its score and its group; scores, tie order and the held-order reducer are
unchanged. The unused idle-threshold helper (`IDLE_BOUNDARY_MS`,
`idleBoundaryReached`) and its two tests are removed; every other existing
assertion stays.

### Files touched

Paths are relative to `apps/desktop`. Everything else under `apps/desktop` and
all of `packages/ui` is byte-identical to main.

| File | Change |
| --- | --- |
| `src/renderer/app.tsx` | Chat cache, transport forwarding and the session panel move to `chat/session-content.tsx`; place, titles and glyphs read through `state/selectors.ts`. |
| `src/renderer/chat/session-content.tsx` | New: `useSessionChats`, `SessionContent`. |
| `src/renderer/state/selectors.ts` | New: `sessionIndex`, `historyMenuEntries`, `placeTitle`. |
| `src/renderer/state/session-actions.ts` | New: the three session mutations, unchanged bodies. |
| `src/renderer/state/store.ts` | Exports `ClientState`; drops the moved functions and the private `titleOf`. |
| `src/renderer/attention/{index,order,stability}.ts` | Kind computed once per session in `orderByAttention`; idle helper removed from `stability.ts` and the barrel. |
| `src/renderer/shell/use-search.ts` | Field lookup through `sessionIndex`; explicit reducer result types; one comment. |
| `test/*` | Imports follow the moved functions; `activePlace` callers read `activeTab(state)?.place`; idle-helper tests removed; `session-content.test.tsx` added. |

## Ownership

| Layer | Owns |
| --- | --- |
| `apps/desktop/src/main` | `BrowserWindow`: `hiddenInset`, traffic lights at `{x:16,y:12}` (three 12px lights with two 8px gaps: `16 + 3*12 + 2*8 = 68` is `--spacing-traffic-safe`, plus 8 is `--spacing-strip-inset-darwin` 76, where the strip zone's content starts), min `400x600`, background by `nativeTheme` (`#0A0A0C` / `#EFEFF0`, same as `--color-sunken`), bounds persisted to `userData/window-bounds.json` 500ms after the last move (never while minimized/maximized), `backgroundThrottling` off until `ready-to-show` then on. `window-bounds.ts` parses the file fail-closed to the default. |
| `apps/desktop/src/renderer/state` | One TanStack Store: sessions, drafts, tabs with independent `{place, history:{entries,cursor}}`, active id, closed snapshots, project collapse, and sidebar state. Plain commands own immutable location transitions; no mirrored global route/selection/history. App owns search-aware floating dismissal. `shell-preferences.ts` persists only `openomni:sidebar-width` / `openomni:sidebar-open`, restored before paint. |
| Main Menu / preload / renderer commands | Main owns tab/history accelerators and dispatches to the live application-window owner, including detached DevTools and native-menu focus. The import-free preload API owns `shell:command` and its command union; `onShellCommand` exposes values only with an exact disposer. App subscribes once per mount and calls `dispatchShellCommand` through its attention/reveal/focus boundary. Renderer owns only bare `[` outside editing and the existing Cmd+K search. |
| App / `apps/desktop/src/renderer/shell` | App resolves places, titles and icons, retains one stable Console/Sidebar/TabStrip tree, and keys only active content by tab id. `session-tree.tsx` owns project → session navigation; `session-list.tsx` owns the full list; `use-search.ts` owns transient search interaction. App owns the per-session Chat cache and stable forwarding transport for its entire lifetime through `chat/session-content.tsx`. |
| `packages/ui` | `tab-strip.tsx` (`TabStrip` with the controls zone and its one trio; the exported `SidebarToggle`, mounted by the strip while collapsed and by the sidebar header while open), `sidebar.tsx` (`Sidebar` root/provider with its two frame parts as statics, `Sidebar.Gap` + `Sidebar.Container` in three modes + content, reveal intent, edge zone, resize handle, `SIDEBAR_WIDTH`), `sidebar-nav.tsx` (`SidebarHeader`, `SidebarNav`/`NavItem`, `SidebarSection` with `SectionHeader` + `SectionList`, `SectionSearchInput`, `SidebarFooter`), `tree-row.tsx`, `history-menu.tsx`, tokens in `styles.css`. The barrel (`index.ts`) exports exactly what `apps/desktop` imports (`apps/desktop/test/ui-barrel.test.ts`); every `data-ui` address in `names.ts` is stamped from `UI_NAMES` somewhere in `src` (`test/names.test.ts`). Touched Console/ConsoleContent contracts are generic `transcript` presentation records, never application places. The lower-level Timeline `sessionId` adapter is a retained legacy boundary, not a new Console prop. |

## Geometry

All numbers are CSS px in the dark theme; every one of them is a token or a utility in `packages/ui/src/styles.css`.

- Tab strip (`TabStrip`): 40 tall (`--spacing-shell-strip`; `--shell-top` reads it once `[data-tab-strip]` is on `<html>` at boot), `bg-bg`, no border, no padding. The whole row is a drag region; buttons opt out by selector.
- Controls zone (`TabStrip.Controls`), open: width `--sidebar-width` (live; a resize drag moves it), padding-left 76 on darwin (`--spacing-strip-inset-darwin` = `--spacing-traffic-safe` 68 + 8), padding-right 8, content `[spacer][trio]` with the trio (history, back, forward) right-aligned by `ml-auto` at `gap-1`. The sidebar toggle is not in the zone while open; it lives in the sidebar header.
- Controls zone, collapsed: width 222 on darwin (`--spacing-strip-zone-collapsed` = 76 + 10 + 4·28 + 3·4 + 12), padding-left 86, padding-right 12, content `[toggle][history][back][forward]` at `gap-1`, so the toggle's box starts at x=86 and the trio follows it 4px later. On other platforms the zone is content-wide with `pl-2.5 pr-3`.
- Width and padding transition together on `--duration-base` / `--ease-frame`, so the trio slides between the two positions. The trio (`TabStrip.Trio`) is ONE DOM node in both states: never re-keyed, no opacity, transform or state attribute of its own (`test/strip-mount.test.tsx` collapses and re-opens on a live DOM and asserts the same element with one mount). Transitions stop while the resize handle is dragged and under `prefers-reduced-motion`.
- Zone buttons: 28 boxes (`--spacing-control-base`, `IconButton size="base"`) around 16 glyphs. The toggle is `variant="plain"` (its glyph's widening bar is the hover answer); history/back/forward keep the `ghost` hover. Back/forward draw the 16px chevron paths in `icons/chevron.tsx`; the clock is lucide `History` at `glyph-stroke` (`--stroke-glyph` 1.5px with `vector-effect: non-scaling-stroke`, so the 24-grid glyph keeps 1.5px at 16).
- Tablist (`TabStrip.List`): directly after the zone, padding-right 8, `gap-1.5` (6), horizontal overflow, tabs vertically centred (a 28 tab in the 40 strip leaves 6 above and below). The create button (`TabStrip.Create`) is a 28 box 6px after the last tab, outside the list.
- Tab (`Tab`): height 28 (`--spacing-tab-height`), width 224 (`w-56`) shrinking to a 96 minimum (`min-w-24`), padding 0 10 (`px-2.5`), `gap-1.5`, radius 8 (`rounded-card`), 0.5px border. Active: `border-line bg-raised text-fg`; inactive: transparent border, `text-fg-muted`, `hover:bg-hover`. Label 13px weight 500 (`text-label font-medium`) truncated; tab icon 14 (`size-3.5`); close button a 20 box (`xs`) with a 12 glyph. The active X stays visible; an inactive X reveals on hover/focus-within without layout shift. Middle-click closes once; right-click does not. ArrowLeft/Right wrap and Home/End select edges on activation buttons only; selected/focused tabs scroll into view without smooth timing.
- Sidebar column: pinned default 252, min 224, max 330 (`SIDEBAR_WIDTH`, applied whenever `openomni:sidebar-width` is absent or unparseable); overlay width 252 too (`--spacing-sidebar-overlay`, one token the overlay reads directly). Top edge = strip bottom (40, `top-(--shell-top)`); the column's own `pt-2` drops to 0 under a strip. `ArrowLeft/Right` on the resize handle step 8, `Shift` 32.
- Header row (`Sidebar.Header`): height 44 (`h-11`), padding-left 16, padding-right 8, `gap-1`, items centred. The brand slot comes first with `-ml-1` so a 28 box sits at x=12; actions are right-aligned (`ml-auto`) as 28 boxes with radius 6; the collapse toggle (`SidebarToggle`) is the last action, so at 252 wide its box spans x 216..244, y 48..76.
- Nav (`Sidebar.Nav`): padding 4 8 (`px-2 py-1`), `gap-px`. Nav item (`NavItem`): height 28 (`h-7`), padding 0 8, `gap-2`, radius 6 (`rounded-md`), 13px weight 500, icon 14 (`size-3.5`) at `glyph-stroke`, so the glyph starts at x=16. Active: `bg-active text-fg`; inactive: `text-fg-muted`, `hover:bg-hover`.
- Section (`SidebarSection`): margin-top 12 (`mt-3`). Section header (`SectionHeader`): one 28 row (`h-7`) inside an 8px column inset, padding-left 8 more so the label starts at x=16, padding-right 0, `gap-1`; label 12px weight 500 `text-fg-subtle`; the toggle (`SectionHeader.Toggle`, 28 box, radius 6) is right-aligned by `ml-auto` so its right edge is the list's right edge (x=244 at 252). While searching the field (`SectionSearchInput`) replaces the label in the same row and the toggle becomes a close. Section list (`SectionList`): a scroll area with padding 0 8 8 (`px-2 pb-2`) and `gap-px`.
- Group row (`TreeRow` with `expanded` defined; the project row): height 28, padding 0 8, `gap-2`, radius 6, 13px weight 500 `text-fg-subtle` (`hover:text-fg-muted`); a leading 16 box holding the 14 chevron (`ChevronRight`, rotated 90 when expanded); then the label, then `trailing` as 13px weight 400 `text-fg-faint`.
- Session row (`TreeRow` with `secondary`): CSS grid, columns `1rem 1fr` (16 and the rest), column-gap 8, row-gap 2, padding 6 8 (`px-2 py-1.5`), radius 6, min-height 44 (`min-h-11`). Column 1 is the leading glyph slot: a 16 box spanning both rows, top-aligned with `pt-1` so an 8 dot sits 4 in. Column 2 row 1 is the title (13px weight 400, truncated) plus an optional right-aligned `trailing` at 11px `text-fg-subtle` tabular; row 2 is `secondary` at 11px `text-fg-subtle`, truncated. The current row is `bg-active text-fg`; the rest `text-fg-muted` with `hover:bg-hover`. Session rows use padding-left 8 regardless of `level`: rows under a group share the group's x. Only a bare leaf (no group, no secondary) still steps in by level.
- Footer (`Sidebar.Footer`): padding 8, 0.5px `border-line` top; holds a `NavItem`.
- Main panel (the Console's `<main>` `Panel`, tone `panel`): margin 0 8 8 0 (`mr-2 mb-2`), plus `ml-2` while the sidebar is collapsed, sliding to 0 on `--duration-base` / `--ease-frame` when it pins; radius 12 (`rounded-panel`), 0.5px `border-line`, background `--color-panel` = `oklch(18.59% 0 0)` dark / `oklch(98.5% 0 0)` light.
- Window: `trafficLightPosition {x:16, y:12}`. The lights are 12 wide and 8 apart, so `16 + 3·12 + 2·8 = 68` = `--spacing-traffic-safe`, and + 8 = 76 = `--spacing-strip-inset-darwin`, the zone's padding-left while open.
- Motion and layers: `--duration-fast/base/slow` = 150/240/300ms on `--ease-frame` (`cubic-bezier(0.2,0,0,1)`); the gap and container slide on `base`, the column content fades on `fast` with a 40ms arrival delay; the trio never fades. Radii `--radius-sm` 4, `--radius-md` 6, `--radius-card` 8, `--radius-panel` 12; `--shadow-panel` is the frame's one shadow; z scale 10/50/350/500/550/600/700.

## Sidebar toggle and hover reveal

- ONE toggle component (`SidebarToggle`, `data-ui` `Sidebar.Toggle`), mounted in two places by state: while the sidebar is open, the header row renders it as its last action; while collapsed, the strip's controls zone renders it first. `aria-label` flips `Collapse sidebar` / `Expand sidebar`; `aria-expanded` is the PINNED state (a floating reveal still reads collapsed, because a click pins it). The glyph (`Sidebar.Toggle.Icon`) reads the column's VISIBILITY: its bar is 1.5 wide hidden and 4.5 pinned or revealed, transitioning width on `--duration-base` / `--ease-frame`.
- Keyboard: bare `[` toggles the sidebar, ignored while typing in a field or editable content. `⌘[` / `⌘]` remain history.
- Width animation: `--duration-base` 240ms on `--ease-frame`; content fade `--duration-fast` 150ms.
- Container modes (`data-mode` on `Sidebar.Container`): `pinned` (open, `top-(--shell-top) left-0 bottom-0`, `w-(--sidebar-width)`), `hidden` (collapsed, same box, `-translate-x-full`, content `inert`), `overlay` (collapsed + floating: the SAME column, `left-2 bottom-2`, top `--shell-top + 8`, `w-sidebar-overlay` 252, `rounded-panel`, 0.5px `border-line-surface`, `shadow-panel`, `z-(--z-drawer)`). The gap stays 0 and the strip stays collapsed while floating. The resize handle renders only when pinned.
- Reveal (`createRevealIntent`, `SIDEBAR_REVEAL`): resting on the collapsed toggle or the 8px `Sidebar.Edge` zone below the strip arms open after 250ms; leaving every hot zone (toggle, edge, panel) arms close after 300ms, the grace the strip-to-panel hop needs. Normal arrivals dismiss it at App's boundary, and a toggle pins it. Live search owns its reveal: Cmd+K reveals a collapsed sidebar, and selection, tab activation, history, leave timers and Escape's generic reveal handler cannot dismiss it until search exits. Timers are cancelled whenever the mode changes.
- Morph (pinning a reveal): the container is ONE fixed, opaque (`bg-sunken`) node in all three modes; pinned is a special case of floating, with the in-flow `Sidebar.Gap` reserving the width beside it. Overlay to pinned is therefore a CSS transition on that node, never a remount or a re-key: `transition-[translate,inset,width,border-radius,box-shadow]` on `--duration-base` / `--ease-frame`. Inset glides 8 to 0 (x 8 to 0, y 48 to 40), radius `--radius-panel` to 0, shadow to none, while the gap grows 0 to `--sidebar-width` and the main panel's `ml-2` slides to 0 on the same curve, so the panel's edge stays under the column's right edge for the whole motion. Width does not start from zero: the overlay token equals the pinned default (252), so pinning at the default width moves no row.

## Where we diverge (Owner rulings)

- History is strictly tab-local: Back, Forward and menu jumps change only the active tab's cursor/place, even when another tab already shows the destination session. Duplicate current views are allowed; history never activates another tab or dedupes. Explicit navigation truncates forward entries only for a different place. The maximum-20 menu is newest-first with original cursor ids; if current is older, it includes current plus newest 19. Ages are omitted rather than inferred from session creation. App rejects callbacks captured from a different tab/history.
- Sidebar top nav order: Sessions, Inbox, Automations, Memory. Inbox/Automations/Memory render honest empty states; the wire has no data for them yet.
- Section label is "Sessions"; its search is a toggle beside the label that swaps the header into the field (`SectionHeader.Toggle`).
- Session rows live in a project → session tree (`role="tree"`, project rows `treeitem` + `aria-expanded`, children in a `group`). Only sessions whose first prompt earned a title are listed (`listedSessions` in `state/selectors.ts`, applied to the tree, the Sessions list, search and attention ordering); a freshly created session exists only as its tab and header until then, and its appearance is itself an attention boundary. Every listed row is double density: title plus phase glyph, then state/reason or relative activity time and the origin mark (`shell/session-row.tsx`).

## Tabs, sessions and lifetime

- Plus and native New Tab create a session record and open a fresh tab. New titles start as `New Session`. Chosen title default: the first accepted nonempty prompt earns `Array.from(text.trim()).slice(0,40).join("")`, without ellipsis; an earned literal `New Session` is not renamed. Empty, disabled and already-sending submissions do not earn titles. Failed sends retain the earned title and show the error. Titles resolve live in tabs, sidebar, list and history.
- Explicit session opens (sidebar, search and list rows) prefer the target tab if it already shows that session, otherwise the first matching current view in strip order. Matching activation never overwrites history. A plain click moves the current tab; Cmd/Ctrl-click uses `openTab(place)`, which reuses an equal current route.
- Search captures the invoking tab once per open, not per result activation. Selecting an existing session in B leaves invocation A's history unchanged; a later unopened result still navigates A. If A closes, selection uses the then-active tab, or opens a tab when empty. Search preserves the null attention boundary and floating reveal until exit.
- Sessions is a place tab with an app-owned flat semantic list: every listed store session once, grouped by held attention kind (`orderByAttention`), independent of sidebar collapse/filtering, with title and phase glyph and `projectId ?? "no project"`, reason and relative activity time from supplied `now`. No new clock, fabricated projects or composer. Selecting an unmatched row navigates the list tab; a matching view is activated instead. Other routes remain honest empty columns.
- Closing removes only a view, never a session, draft, Chat or stream. App keeps one Chat per session and a current-transport forwarding reference; switching, closing and reopening reuse messages and in-flight work, including duplicate history-created views. Window/App teardown ends this cache.
- Inactive close preserves the active tab and editor focus. Active close chooses old right neighbor, then left, then none. Focus from the removed panel recovers to the successor editor if available, otherwise successor tab; focus from its tab control recovers to successor tab. Empty recovery targets plus. The active panel is `tab-panel-${id}`, labelled by `tab-${id}`; inactive tabs do not point at absent panels.
- Closed snapshots retain original id/index/history, capped at newest 20. Reopen restores at the clamped position. A session collision activates the matching view but retains the snapshot for retry; after that view navigates away, reopen restores the original back and forward entries. Route snapshots restore even on collision.
- Last-tab-close leaves the window and stable frame alive, with an honest empty column, no tabpanel/composer and no current sidebar place. Tabs, sessions and chats are window-lifetime only. No tab persistence, reorder-by-drag, pinning, MRU, splits, session deletion, backend deletion API, generated titles or new badges.

### Native command ownership

Menu owns CommandOrControl+T/W/Shift+T, CommandOrControl+1..9 (9 selects last),
Control+Tab/Shift+Tab, CommandOrControl+Shift+]/[ cycle aliases, and
CommandOrControl+[/] history. Cycling is positional, not MRU. Hidden cycle aliases
remain accelerator-enabled. Explicit File/View menus preserve native editing,
quit, minimize, zoom and fullscreen without a window-close Cmd+W binding;
`close-tab` on a window with no tab left asks main to close that window over
`shell:close-window` (sender-resolved), so Cmd+W still closes an empty window.
Development-only reload/forceReload/devtools use the same
`Boolean(process.env.ELECTRON_RENDERER_URL)` predicate as startup. Production
excludes them. Pure menu tests do not prove native accelerator delivery or role
expansion; those receipts belong to integration QA.

## Status indicators

The shipped base renders phase glyphs in tabs, session rows and headers, and
attention-kind groups in the list and tree (`StatusGlyph` from `packages/ui`,
mapped by `shell/session-glyph.ts`). The gateway has no production session-phase
producer yet: every session starts `idle`, and the exported `setSessionPhase` /
`setSessionAttention` store commands are called only by tests. No development
global exposes them. The cleanup preserves those mappings, flags, density rules
and held-order boundaries; it adds no kernel integration or phase lifecycle.

## Session row second line

`shell/session-secondary.tsx` renders one second line under the title on the
sidebar tree and the Sessions list: the project name, then the attention reason
(`attention/reason.ts` `sessionReason`) while `hasActiveState` holds (any phase
other than `idle`/`archived`, or an unread `completed`/`failed`), otherwise the
relative last-activity time. When `Session.surfaceKey` is set (the
`Channel.SurfaceKey` string `<surface>:<path>` minted by the channels gateway
for the conversation the session belongs to) and its surface prefix is one of
slack/discord/telegram/github, a `·` and the brand `OriginMark` from
`packages/ui` follow. Local sessions carry no key and draw no mark. No producer
sets `surfaceKey` yet; the field waits on the same gateway session read model as
phases.
