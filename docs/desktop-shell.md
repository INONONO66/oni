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

Tab composition updated on `feat/desktop-tabs` (2026-09-07). Implementation receipts
are in `.omo/reports/desktop-tabs-20260907/impl-{A,B,C,D}.md`; native QA is in
`.omo/reports/desktop-tabs-20260907/qa/QA.md` (menu-driven commands, DOM and
screenshots pass; raw Cmd+T/Cmd+W keystroke delivery is not yet proved because the
macOS session was locked during QA). Earlier frame geometry and
sidebar measurements belong to `feat/desktop-shell-frame`, documented in
`.omo/reports/desktop-shell-port-20260907.md`. New tab dimensions below are chosen
defaults, not reference measurements.

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
| `apps/desktop/src/main` | `BrowserWindow`: `hiddenInset`, traffic lights at `{x:17,y:14}` (`y = (42 - 14) / 2`: `y` is the lights' TOP and they measure 14pt tall on Darwin 25, so their centre is 21 — the strip's midline and the 28px controls' centre, `7 + 14`; the classic 12pt lights would need 15. `17 + 52 + 12 = 81` is the strip's traffic safe zone), min `400x600`, background by `nativeTheme` (`#0A0A0C` / `#EFEFF0`, same as `--color-sunken`), bounds persisted to `userData/window-bounds.json` 500ms after the last move (never while minimized/maximized), `backgroundThrottling` off until `ready-to-show` then on. `window-bounds.ts` parses the file fail-closed to the default. |
| `apps/desktop/src/renderer/state` | One TanStack Store: sessions, drafts, tabs with independent `{place, history:{entries,cursor}}`, active id, closed snapshots, project collapse, and sidebar state. Plain commands own immutable location transitions; no mirrored global route/selection/history. App owns search-aware floating dismissal. `shell-preferences.ts` persists only `openomni:sidebar-width` / `openomni:sidebar-open`, restored before paint. |
| Main Menu / preload / renderer commands | Main owns tab/history accelerators and dispatches to the live application-window owner, including detached DevTools and native-menu focus. The import-free preload API owns `shell:command` and its command union; `onShellCommand` exposes values only with an exact disposer. App subscribes once per mount and calls `dispatchShellCommand` through its attention/reveal/focus boundary. Renderer owns only bare `[` outside editing and the existing Cmd+K search. |
| App / `apps/desktop/src/renderer/shell` | App resolves places, titles and icons, retains one stable Console/Sidebar/TabStrip tree, and keys only active content by tab id. `session-tree.tsx` owns project → session navigation; `session-list.tsx` owns the full list; `use-search.ts` owns transient search interaction. App owns the per-session Chat cache and stable forwarding transport for its entire lifetime through `chat/session-content.tsx`. |
| `packages/ui` | `tab-strip.tsx` (the one sidebar toggle; zone width == sidebar width), `sidebar.tsx` (`Sidebar` root/provider with its two frame parts as statics, `Sidebar.Gap` + `Sidebar.Container` in three modes + content, reveal intent, edge zone, resize handle), `sidebar-nav.tsx` (`SidebarNav`/`NavItem`, `SidebarSection` with `SectionHeader` + `SectionList`, `SectionSearchInput`, `SidebarFooter`), `tree-row.tsx`, `history-menu.tsx`, tokens in `styles.css`. The barrel (`index.ts`) exports exactly what `apps/desktop` imports (`apps/desktop/test/ui-barrel.test.ts`); every `data-ui` address in `names.ts` is stamped from `UI_NAMES` somewhere in `src` (`test/names.test.ts`). Touched Console/ConsoleContent contracts are generic `transcript` presentation records, never application places. The lower-level Timeline `sessionId` adapter is a retained legacy boundary, not a new Console prop. |

## Geometry (matched to the reference console)

- Tab strip 42px (`--spacing-shell-strip`; `--shell-top` reads it once `[data-tab-strip]` is on `<html>` at boot). Tabs retain 26px height and rounded card corners. Chosen tab widths are 96..224px with horizontal overflow; plus stays outside the tablist. Icons are 14px; sibling close buttons reserve 20px (`xs`) with 12px glyphs. Active X stays visible; inactive X reveals on hover/focus-within without layout shifts. Middle-click closes once; right-click does not. ArrowLeft/Right wrap and Home/End select edges on activation buttons only; selected/focused tabs scroll into view without smooth timing.
- Strip controls: the `base` step, a 28px box (`--spacing-control-base`) around a 16px glyph. The toggle is `variant="plain"` (no hover fill: its glyph's bar widening is the hover answer); history/back/forward keep the `ghost` hover.
- INVARIANT: the strip's controls zone is ALWAYS exactly as wide as the sidebar. Pinned: zone and container are both `w-(--sidebar-width)` (live; a resize drag moves both). Collapsed: zone and the hover-reveal overlay panel are both `w-sidebar-overlay`, ONE token (`--spacing-sidebar-overlay`, `styles.css`) that neither component restates, so they are the same number by construction; the trio's right edge (12px in) therefore marks where the overlay's right edge will land (offset only by the overlay's own 8px `left-2` inset). The zone's padding never changes, only its width.
- Widths (decided 2026-09-07): pinned default 240px, min 224, max 330 (`SIDEBAR_WIDTH`, applied whenever `openomni:sidebar-width` is absent or unparseable); overlay/collapsed 240px too. Why 240 and not a compact 224: the collapsed zone's contents need `89 inset + 28 toggle + 4 + (3·28 + 2·4) trio + 12 pad = 225` on darwin, so 224 would clip by a pixel; and at 240 the overlay keeps the pinned column's line breaks, so pinning a reveal does not reflow the rows. The 15px of spacer this leaves between toggle and trio while collapsed is the visible cost.
- Darwin inset: traffic safe zone `--spacing-traffic-safe` 81px (`17 + 52 + 12`) + 8 = `--spacing-strip-inset-darwin` 89px, so the toggle's box starts at x=89 — a 20px gap after the lights. Vertical: the strip has no border or padding (measured 42 tall), controls top 7 → centre 21; lights top 14 + 14/2 → centre 21 (`15a-traffic-lights-before-y15.png` shows y=15 sitting 0.75pt low; `15-traffic-lights.png` the fix).
- Zone layout `[toggle] [spacer] [trio]`, `gap-1`, `pr-3`: the trio (`TabStrip.Trio`, `ml-auto`) is RIGHT-ALIGNED to the sidebar's edge, 12px in, and rides `--sidebar-width` while open; collapsed, the zone's width equals its content so the spacer is zero and the trio sits 4px after the toggle. The trio is ONE node for the window's life (never re-keyed; `test/strip-mount.test.tsx` renders it on a live DOM, collapses and re-opens, and asserts the same element with one mount). It has NO motion of its own — no opacity, no transform, no state attribute: it slides because the zone's width transitions (`--sidebar-width` <-> `--spacing-sidebar-overlay` on `--duration-base` / `--ease-frame`) and `ml-auto` keeps it on the zone's right edge. It never fades.
- Glyphs (measured 2026-09-07 in the reference bundle: `html.js` base `Icon` — `size: 16` default, `viewBox 0 0 16 16`, width/height = size; every path read (`SidebarLeftIcon`, `ChevronLeft/Right/Down`, `Collapse/ExpandChevronIconLarge`) is built from 0.75 radii, i.e. a 1.5-unit line in the 16 box = 1.5px; `IconButton size=medium` = 28 box). Ours, per site:

  | Site | Reference | Ours |
  | --- | --- | --- |
  | Sidebar toggle | 28 box / 16 glyph, 1.5 line (path verbatim) | 28 / 16, verbatim path |
  | Back / forward | 28 / 16, 1.5 (paths verbatim) | 28 / 16, verbatim paths |
  | History clock | 28 / 16 (`ClockOutline`; path not extracted) | 28 / 16, lucide `History` at `glyph-stroke` = `--stroke-glyph` 1.5px (`vector-effect: non-scaling-stroke`, so the 24-grid glyph keeps 1.5px at 16 instead of thinning to 1.33) |
  | Tab `+` | glyph goes through the base `Icon` (default 16); its button box at the tab bar NOT measured | kept `sm`: 24 box / 14 glyph, lucide's own stroke |
  | Nav row icons | base `Icon` default 16; call site NOT measured | 16 in the 28 row, `glyph-stroke` 1.5px |
  | Section / tree chevrons | `ChevronDown` is a 16 box at 1.5; the sidebar's section chevron component NOT identified | kept lucide `ChevronRight` 14 (`size-3.5`), lucide's own stroke; section toggle (search / close) kept `sm` 24 / 14 |

  `glyph-stroke` is spent at the two 16px sites only (`IconButton size="base"`, `NavItem`); the 14px glyphs keep lucide's weight until measured.
- No sidebar header row: the column starts directly under the strip with the nav (Sessions/Inbox/Automations/Memory). Nav rows and tree rows `h-7`; section header `h-8`. The one search entry point is the section header's inline toggle beside "Sessions" (`SectionHeader.Toggle`), plus `⌘K`.
- Motion: `--duration-fast/base/slow` = 150/240/300ms, `--ease-frame` (= the answer curve, `cubic-bezier(0.2,0,0,1)`); the gap and container slide on `base`, the column fades on `fast` with a 40ms arrival delay; the strip's trio slides with the zone's width and NEVER fades (the reference's `1 - 3p` is for a cluster that fades out while leaving and is replaced on arrival; a persistent node running it from both ends blinked 1 -> 0 -> 1, shipped in 5d19bf4b, removed); transitions suppressed while dragging the resize handle and under `prefers-reduced-motion`; `ArrowLeft/Right` on the handle step 8px, `Shift` 32px.
- Radii `--radius-card .5rem`, `--radius-panel .75rem`; `--shadow-panel` (the frame's one shadow); z scale 10/50/350/500/550/600/700.

## Sidebar toggle and hover reveal (matched to Linear)

Measurements: `.omo/reports/sidebar-toggle-ref-20260907.md`. Linear's renderer is remote; the values were read from its cached bundle, so geometry that lives in its atomic CSS is marked as a default.

- ONE toggle (`Sidebar.Toggle`), first in the strip's controls zone after the window controls, in both states; the trio follows it (4px gap collapsed, right-aligned open — Geometry above). `aria-label` flips `Collapse sidebar` / `Expand sidebar`; `aria-expanded` is the PINNED state (a floating reveal still reads collapsed, because a click pins it). The glyph (`Sidebar.Toggle.Icon`, the reference's `SidebarLeftIcon` frame + `<rect x=4 y=5 h=6 rx=.75>`) reads the column's VISIBILITY: its bar is 1.5 wide hidden and 4.5 pinned or revealed, transitioning width on `--duration-base` / `--ease-frame` (reference: 250ms easeOut). Back/forward are the reference's 16px chevron paths (`icons/chevron.tsx`); the clock stays lucide's `History` (path not extracted), drawn at the frame's 1.5px line (Geometry, Glyphs).
- Keyboard: bare `[` toggles the sidebar (measured: Linear's `keyboardShortcut: { key: "[" }`), ignored while typing in a field or editable content. `⌘[` / `⌘]` remain history.
- Width animation: Linear runs a spring (stiffness 420, damping 38, mass 1) that settles in ~240ms; we run `--duration-base` 240ms on `--ease-frame`. Content fade 150ms (measured constant).
- Container modes (`data-mode` on `Sidebar.Container`): `pinned` (open), `hidden` (collapsed, `-translate-x-full`, content `inert`), `overlay` (collapsed + floating: the SAME column, `left-2 bottom-2`, top `--shell-top + 8px`, `w-sidebar-overlay`, `rounded-panel`, hairline, `shadow-panel`, `z-(--z-drawer)`). The gap stays 0 and the strip stays collapsed while floating. The resize handle renders only when pinned.
- Reveal (`createRevealIntent`, `SIDEBAR_REVEAL`): resting on the toggle or the 8px `Sidebar.Edge` zone below the strip arms open after 250ms (measured); leaving every hot zone (toggle, edge, panel) arms close after 300ms (default — Linear closes at once because its hot container is contiguous; ours needs the grace for the strip→panel hop). Normal arrivals dismiss it at App's boundary, and a toggle pins it. Live search owns its reveal: Cmd+K reveals a collapsed sidebar, and selection, tab activation, history, leave timers and Escape's generic reveal handler cannot dismiss it until search exits. Timers are cancelled whenever the mode changes.
- Overlay inset 8px / radius `--radius-panel` / shadow: not measured in Linear; defaults.
- MORPH (pinning a reveal, decided 2026-09-07): the container is ONE fixed, opaque (`bg-sunken`) node in all three modes — pinned is a special case of floating, the in-flow `Sidebar.Gap` reserving the width beside it — so overlay→pinned is a CSS transition on that node and never a remount or a re-key: `transition-[translate,inset,width,border-radius,box-shadow]` on `--duration-base` / `--ease-frame`. Inset glides 8→0 (x 8→0, y 50→42), radius `--radius-panel`→0, shadow→none, while the gap grows 0→`--sidebar-width` and the main panel's `ml-2` slides to 0 on the same curve, so the panel's edge stays under the column's right edge for the whole motion. Width does NOT start from zero: the overlay token equals the pinned default (240), so at the default nothing changes; a wider stored width eases 240→width in step with the strip's zone. Not chosen: a FLIP transform — it would fight the live `--sidebar-width` the resize handle writes. The reverse (pinned→hidden) and plain expand are unchanged: a `translate` slide beside the gap's width slide; the overlay's own close (leave / Escape) keeps the slide-out with the content fade. Live proof (rAF-sampled at 120Hz, `.omo/reports/desktop-shell-port-20260907/20-morph-mid.png`, `21-morph-pinned.png`): x 8→0 and y 50→42 monotonic over ~200ms, width 240 on every frame, same element throughout (`packages/ui/test/strip-mount.test.tsx` pins the identity, `shell.test.tsx` the property list).

## Where we diverge from the reference console (Owner rulings)

- The strip's zone holds ONE trio in BOTH states: `[sidebar toggle]` … `[history] [back] [forward]`; the toggle never moves into the sidebar (there is no header row), and the trio slides between the toggle's side and the sidebar's edge rather than being two clusters (the reference mounts a second cluster in the sidebar's own top row).
- History is strictly tab-local: Back, Forward and menu jumps change only the active tab's cursor/place, even when another tab already shows the destination session. Duplicate current views are allowed; history never activates another tab or dedupes. Explicit navigation truncates forward entries only for a different place. The maximum-20 menu is newest-first with original cursor ids; if current is older, it includes current plus newest 19. Ages are omitted rather than inferred from session creation. App rejects callbacks captured from a different tab/history.
- Sidebar top nav order: Sessions, Inbox, Automations, Memory. Inbox/Automations/Memory render honest empty states — the wire has no data for them yet.
- Section label is "Sessions" (reference: "Threads"); its search is a toggle beside the label that swaps the header into the field (`SectionHeader.Toggle`).
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
