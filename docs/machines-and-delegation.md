# Machines and Delegation — the OS's Body and Workforce

Owner-directed target design (2026-08-23). This document supersedes the
package-layout portions of the archived clean-room blueprint (git history,
`docs/clean-room-blueprint.md`): the Owner ruling of 2026-08-23 replaces the
legacy brain and host with the sole-app target and includes machine placement.
Everything here is a target contract; [implementation-status.md](implementation-status.md)
alone says what is wired.

## 1. The two axes

Oni is an agent OS. Its reach grows along two axes:

- **Axis A — body (machines).** Devices attach by running `mclient`, which dials
  home. What the OS may do on a device is `effective = enrollment ∩ offer`.
- **Axis B — workforce (delegation).** Work is commissioned through ONE
  address vocabulary covering internal loops and external actors uniformly.

The protocol contracts for both belong together because they meet in the tool catalog: a tool declares *where* it runs and *which capabilities* the executing side must hold.

## 2. Machine contracts (`protocol/src/machine/`)

### 2.0 Screen capability and selection

Tier 1 is the person's console with its actual grants; tier 2 is an owned
virtual display; tier 3 is selection among those machines from report facts.
Each v4 heartbeat reports `screen: { verdict, blockers, display, grants }`.
`grants` names capture, accessibility and input separately; display has
`kind: console | virtual | none`, an optional id, and `isolated`. `partial`
means only some screen operations work. An Xvfb-backed Linux display reports
`virtual` and `isolated: true`; capture, input and a live window manager
make it available. Accessibility stays false until
an observer is implemented, and a console without observation remains partial.
Missing X authorization, display sockets, libraries and
accessibility buses are distinct blockers; an absent window manager adds
`window_manager_missing`. macOS uses its real console user, capture and
Accessibility checks and never claims an isolated display. A peer sending
an old screen permission fact on an admitted v3 attachment has its capture
grant folded into v4 facts; input, accessibility and isolation are never inferred.

Use `machine(tag="...", prefer="computer")` to select a computer-capable
member: the placement fold requires effective `computer.use` and the latest capture and input grants,
prefers `available` over `partial`, then an isolated display, then existing
spread credit. Explicit machine ids and the other placement preferences
retain their original selection behavior. Linux virtual display startup
owns Xvfb and passes only the declared session environment variables to
launched apps; it shuts the display down when the client exits.

The client's `client.json` selects an owned display with
`"computer": {"display": {"kind": "xvfb", "width": 1280,
"height": 800, "dpi": 96}}`. The optional `windowManager` object supplies
`{"path": "...", "args": []}`; otherwise openbox is launched when present.
Xvfb startup failure is `display_unavailable`. A missing window manager
leaves capture and input usable but adds `window_manager_missing`.
Linux text retains dynamic key mappings for the driver's lifetime, preflights the whole string and returns `input_failed` without emitting text when the unused keycode pool is exhausted, preserving held keys and restoring the original mappings on shutdown.

- `Machine.Enrollment` — Owner-side admission record: the capability allowlist
  for one machine. Never empty (an enrolled machine with nothing allowed is a
  contradiction).
- `Machine.Offer` — client-side attach report: what the machine can do right
  now. May be empty; the client re-offers when modules come up. Since #1624
  it carries a required `peer {kind: "daemon" | "client", contractVersion}`
  and an optional `generation` (the last one the host accepted, presented on
  reconnect only).
- `Machine.effectiveCapabilities(enrollment, offer)` — pure clockless fold:
  intersection, sorted; mismatched machine ids refuse (`machine_mismatch`).
  Neither side can grant itself a capability the other never named.
- `Machine.CapabilityId` — dot-namespaced lowercase grammar (`fs.read`,
  `shell.exec`, `kernel.py`, `screen.read`, `input.write`, `pty.session`).
  Open vocabulary,
  owned grammar: enrollment writer, client offer, and tool `requires` all
  parse the same shape.
- Events: `machine.attached` (carries the effective set in force),
  `machine.detached` (reason `connection_closed | host_closed |
  enrollment_removed | enrollment_replaced | superseded_by_reattach |
  superseded`); new host emissions use `superseded`.

The Rust `mclient` is the only machine peer; `packages/machines` owns the
host and IPC transport;
enrollment storage is a ledger record; attach admission is kernel judgment.

### 2.1 Raw machine and code-mode consumers

`MachineHost.list()` returns attached enrollment fields, tags (empty when
omitted), the effective capability set, and os/arch from the client's platform
report. Detached machines are absent. `get(id)` returns a stable handle, even
before attachment; calling an unattached handle throws `MachineRefusalError`
with `machine_not_attached`. Handles follow reattachment by identity, not by
whichever connection was most recently used.

The handle exposes `fs.read/write/list/stat`, `exec(cmd,cwd)` and
`runCode(cell,signal?)`. Filesystem inputs are real absolute POSIX paths, never
a virtual root or URL. The longest matching offered root translates to the
existing export-relative `machine.fs_op` wire. Equal normalized roots refuse
`ambiguous_export`; the host does not select a broader root to evade a narrower
root's refusal. Offers carry named absolute roots; client settings must
match those roots. Missing enrollment export grants fail closed.

There are exactly two authorization boundaries: the kernel executor's
`tool.pre` for app-originated effects, and the client's negotiated capability,
offer and export checks. Host path translation and same-connection cell
provenance are protocol mechanics, not additional policy checks. The app has
no VFS capability gate or cross-machine prohibition. Both consumer doors use
the same raw endpoint; the plain-tool locus door belongs to #949.

- `fs.read` gates read/list/stat. `fs.write` gates write. The client checks
  both its own offer and the enrollment/offer negotiation on every request.
- The descriptor-pinned `openat(O_NOFOLLOW)` confinement walk is retained.
  Symlinks are expanded under the pinned root; escaping and dangling external
  links uniformly refuse `path_escapes_export`. Root descriptor ownership and
  FIFO/socket nonblocking handling are unchanged.
- Writes create or overwrite a regular file, mode 0600 for new files. They
  open without truncating, verify the pinned descriptor's kind, then truncate
  and write. Writes are not atomic or transactional; an I/O refusal may leave
  a partial effect. Parent directories are not created. The 262144-byte
  socket cap refuses an oversized write before opening its target.
- Read returns `{op,data:Uint8Array,bytesRead,size,truncated}`; write returns
  `{op,bytesWritten}`. List and stat return their raw protocol structures.
  JSON wire bytes are lossless base64, never lossy UTF-8 or model previews.
  Reads retain the 262144-byte window cap and lists the 1000-entry cap, both
  with explicit truncation facts.
- `shell.exec` grants machine shell authority. For each call, the client
  re-resolves the effective export root pathname and validates the requested
  cwd before spawning `/bin/sh` by pathname. Exec does not share the fs
  branch's pinned-root invariant: replacing the export-root pathname before a
  request changes the directory exec actually starts in (fs requests keep
  reading the root pinned at attach), and a symlink swap between validation
  and spawn is a bounded, accepted TOCTOU for now (follow-up #938 in
  `docs/SLOP.md`).
  This is path validation, not an OS shell sandbox: a shell running as the
  client OS user remains arbitrary within that user's normal OS authority
  (including absolute paths and `cd` elsewhere). The Owner grants `exec`
  knowingly. Every execution requires an absolute cwd; no cwd persists between
  calls. Results
  retain raw stdout/stderr bytes, nullable exitCode/signal, and truncation.
  The combined output socket cap is 262144 bytes; reaching it kills the
  process group. A 30000ms deadline and attachment close also kill the group.
- Filesystem refusals are typed throws at the consumer surface and typed
  wire values. Exec and code retain typed terminal/refusal values. Invalid
  schemas and transport loss throw typed schema/IPC errors.

### 2.2 Computer use (`screen.read` / `input.write`, #1274)

- Wire methods `machine.screen_read` and `machine.input_write`; both gate on
  the effective capability set like every other machine operation. The Rust
  client uses `src/screen/native.rs` (xcap on macOS) for capture and
  `src/input/macos.rs` (CoreGraphics) or `src/input/linux.rs` (XTEST) for input; `src/computer.rs` supplies optional
  fixture and recorder backends.
- At attach, `screen.read` is offered when the screen backend has permission
  and reports at least one display; `input.write` also requires a permitted
  input backend. On macOS, Screen Recording is preflighted before listing or
  capture, and Accessibility trust is checked before input. Later permission
  loss yields typed refusals, not a new capability offer.
- `screen.read` returns `{status:"ok", captureId, png}` with base64 PNG
  bytes capped at 4 MiB; the client downscales and re-encodes to fit rather
  than truncating. It returns no accessibility tree. Regions use display-
  relative points, validated against the selected display before capture;
  out-of-bounds refuses `invalid_region`.
- `input.write` requires the `captureId` of the LATEST successful capture;
  anything else refuses `stale_capture` and executes nothing. Input execution
  is main-display only in this legacy batch: an anchor on another display
  refuses `unsupported_action`. The client validates the whole batch
  (at most 32 click/type/key/move/scroll actions) before injection, translates
  display-relative pointer positions to global desktop points, and supports
  middle-click and scroll through the input backend. Coordinates outside
  the captured display refuse `invalid_region` before injection.
- There is no model-visible tool. Code mode is the only consumer:
  `m.screen(display=None, region=None)` and `m.input(actions,
  capture_id=None)` in Python cells (input defaults to the cell's last
  capture id; without one it raises `ToolError`), `screen/input` on SDK
  handles. `codemode.screen` is query-class at the app composition boundary;
  `codemode.input` is execution-class.

### 2.2.1 Computer use as one capability (`computer.use`, #1662)

`screen.read` and `input.write` above stay as the frozen legacy pair with
their main-display, single-batch contract. The client peer offers a second,
wider surface under one capability id, `computer.use`, which the Owner
grants in `Enrollment.allowedCapabilities` and the peer offers only while it
has a permitted display session. Admission uses the effective set,
enrollment ∩ offer, and an offer alone never grants anything. The id neither
implies `screen.read`/`input.write` nor is implied by them.
`Machine.contractVersion` stays 2: every addition is a new method, a new
root or one optional `Report.streams` field, so a v2 peer that does not
offer `computer.use` is never sent the new methods.

- **Methods.** `machine.screen.list` and `machine.screen.capture`,
  `machine.input.pointer` (`move|click|button|scroll`), `machine.input.key`,
  `machine.input.text`, `machine.clipboard.read|write`, `machine.stream.open|signal|close` and
  `machine.cdp.open|chunk|close`. Every result is a typed `refused` union
  with a closed reason enum; nothing on this surface is `unknown`.
- **Clipboard.** A computer lease grants `clipboard: none|write|read_write`.
  Read requires `read_write`, refuses while private focus is active, and
  records only formats and byte counts in the ledger. Write returns a
  content-free previous receipt `{changeCount, formats, bytes}`; the client
  holds the previous bytes locally and restores them when the lease ends
  unless the pasteboard changed externally or the agent restored it.
  Clipboard changes outside agent writes are human-input edges. Content
  and restoration snapshots are bounded to 4 MiB.
- **Screen.** Listing caps at 16 displays and 512 windows with a
  `truncated` flag, titles at 256 characters. A capture targets a display, a
  window or a display-relative region, as PNG or JPEG (quality 1..100), and
  is at most 4 MiB as base64: the peer downscales and re-encodes until the
  bytes fit and never truncates. Dimensions and coordinates are capped at
  16384. Refusals: `screen_not_available`, `permission_denied`,
  `display_not_found`, `window_not_found`, `invalid_region`,
  `capture_failed` (a saturated frame pool answers this reason too; it
  never queues).
- **Input.** Every request names a `captureId`. The anchor is only the
  latest capture of a display whose geometry has not changed; anything else
  refuses `stale_capture`. Permission, anchor and the whole plan (every
  point, key name, text length, scroll delta of at most 10000) are validated
  before the first event is injected, and a driver that fails mid-plan
  releases every button or key it pressed. A key or button a request leaves
  down stays down across requests until released, and is released in
  reverse on detach and when a grant withdraws `computer.use`. Input requires a captured
  `tool.pre` effect on the host: the host calls the injected `captureInput`
  port and forwards only from inside its executed body; without a port it
  refuses `permission_denied`. Every input call is captured, including
  one the host then refuses. At forward time it rechecks attachment,
  generation and grant (`permission_denied`, `stale_generation`,
  `disconnected`). Client-side refusals: `input_not_available`,
  `permission_denied`, `stale_capture`, `invalid_region`,
  `unsupported_action`, `input_failed`.
- **Stream lifecycle.** `stream.open` carries fps (at most 60), a keyframe
  interval between 100 ms and 60 s, a bitrate cap (at most 50 Mb/s), a
  per-frame cap (2 MiB, larger frames are dropped whole), a longest edge of
  at least 2 pixels and a lifetime (at
  most 1 h). The host mints the `streamId` and holds at most 4 open streams
  per attachment (`stream_limit`). Signalling is typed `offer`, `answer`,
  `candidate`, `end_of_candidates` and `data` records (SDP at most 64 KiB,
  a candidate at most 1024 characters, data at most 16383 bytes) with a per-
  direction `seq` below 256: repeating the last accepted record is
  idempotent, a refused record may be resent corrected under the same
  `seq`, any other mismatch refuses `invalid_sequence`, an overflow
  `signal_limit`. A viewer candidate with an mDNS `.local` address is
  skipped; the peer learns the viewer peer-reflexively from its checks. The peer encodes H.264
  and sends it over SRTP, adapts bitrate inside the host's bounds from the
  receiver estimate and from a full send buffer, and answers viewer
  keyframe requests. The stream closes with `expired` at its lifetime,
  `failed` on revoke, memory pressure, a lost source or a silent peer, and
  `detached` on detach. `Report.streams` observes fps, bytesPerSecond,
  encodeMs, droppedFrames and retainedBytes per open stream; retained bytes
  return to 0 after every close.
- **CDP lifecycle.** `cdp.open` names a configured port or a launch entry
  from a data manifest (`cdp.json` beside the client config, entry names
  `^[a-z][a-z0-9_-]*$`); an absent manifest refuses `cdp_not_available`, an
  unknown entry `manifest_not_found`, and a launch runs only the manifest's
  `binary` + `argv` with nothing interpolated from the request. The peer
  discovers the endpoint over loopback (`GET /json/version`, 64 KiB body
  bound), accepts only a `ws://` URL on `127.0.0.1` or `localhost` at that same port,
  upgrades the WebSocket itself and then forwards opaque bytes both ways as
  sequenced chunks of at most 262143 bytes (`machine.cdp.chunk` in each
  direction, each chunk answered before the next read). The host attaches
  no meaning to chunk boundaries and contains no browser logic; the peer holds
  at most 4 channels (`channel_limit`), closes on lifetime (at most 1 h), on
  either side's `close`, on a refused or lost uplink, and kills launched
  processes on detach. A reconnect starts with an empty registry.
- **Vendor rule.** The tracked surface names no browser or input vendor:
  the browser-aware code lives in one dialect module on the client and the
  native capture and input backends sit behind platform-gated adapters
  with a fixture layout and a JSONL recorder for headless runs.
- **Consumer.** As with 2.2 there is no model-visible tool. The host
  exposes the surface as `host.native.get(id).computer` (`ComputerHandle`);
  code mode hands it on as `getMachine(id).computer` with the wire op names
  (`screen.list|capture`, `input.pointer|key|text`, `stream.open` returning
  `signal`/`close`, `cdp.open` returning `send`/`close`), every call behind
  the handle's lease fence. Migrating the legacy `screen`/`input` callers
  onto this surface is later work (see `docs/implementation-status.md`).
  A live macOS run (Screen Recording and Accessibility granted, a real
  browser viewer) has not been observed; that acceptance belongs to epic
  #1622.

### 2.2.3 Background delivery and window lifecycle (#1690)

Pointer, key and text requests default to `delivery: "background"`. A
pointer request always needs explicit `delivery: "foreground"`. Background
key/text requests require a `target: { pid, windowId, epoch? }`; the client
resolves that window and checks any supplied epoch before dispatch. The
complete event plan is classified before its first event. A plan requiring
the shared pointer, a missing target, or a backend without PID delivery
refuses `foreground_required`. Ref actions (`machine.input.action`) are
background by construction and have no delivery switch.

macOS uses tagged CoreGraphics events: foreground delivery posts to HID,
background delivery posts only to the target PID. Held-key releases retain
the delivery route, including failure cleanup and detach. The headless
recorder includes `delivery`, `pid` (null for foreground) and `tag` on every
injected input event. Linux retains XTEST foreground input and refuses PID
delivery.

`machine.app.launch` takes `{ app: { bundleId } | { path, args? },
activate: false, env?, freshInstance?, timeoutMs? }`. Its environment accepts
only `DISPLAY`, `XAUTHORITY`, `WAYLAND_DISPLAY`, `XDG_SESSION_TYPE`,
`DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `HOME`, `PATH`, and `LANG`.
The macOS launcher uses asynchronous NSWorkspace launch without activation,
hiding, or permission prompts; a new application instance is requested only
when `freshInstance` is true. The calling worker receives the completion
through a channel, with a 10-second default deadline clamped to 1-30000 ms.
The same deadline bounds PID-based window discovery. Success returns
`{ status: "ok", pid, windows: [{ pid, windowId, epoch }] }`; no windows by
the deadline is still success. Timeout and launch errors return
`unsupported` with `blocker: "launch_timeout" | "launch_failed"` and errors
carry the localized description. Linux launch refuses `unsupported` with
`blocker: "platform"`.

`machine.app.quit { pid }` terminates the process and returns `exited`.
`machine.window.close/park { target: { pid, windowId, epoch } }` are
epoch-fenced. Close presses the window's AX close button and returns
`closed`; park sets the application hidden attribute and returns `parked`.
All four methods enter `screenGate` and the captured `tool.pre` port.
Code mode exposes `computer.app.launch/quit` and `computer.window.close/park`.
The peer's own process and `computer.excludedOwners` (bundle IDs or paths)
are excluded from lifecycle actions and window capture.

Window capture retains the backing-store capture path. It refuses
`window_minimized`, `own_window`, and `capture_blank` (at least 99 percent
of sampled pixels share one color). A newer capture of the same window
supersedes an in-flight capture; the older request returns `superseded`.
The macOS `native_occlusion` test is ignored until the live grants are
available; its receipt belongs to #1702. ScreenCaptureKit and Windows
adapters belong to #1700.

Computer-use authority is a revisioned approval-policy lease keyed by
session and machine: app identities, a 5-120 minute expiry, and an optional
foreground purpose and expiry. Owner consent for `computer_request` uses
the existing approval surface; exclusion rows are an independent ceiling.
The session websocket accepts one first `surface` frame naming its attached
machine. At the authenticated request-answer port, same-machine consent is
refused as `self_approval_suspected` when the client's person-only input fact
is older than `computer_use.humanQuietMs` (10 seconds by default) or an injected
input occurred within `computer_use.injectedWindowMs` (also 10 seconds by default). The refusal is
recorded as an ingress decision and leaves the approval open; answers without
a machine surface, including messaging, use the normal path. Each lease
revision broadcasts a typed session websocket `lease` frame.
The lease budget defaults to 1500 actions per sliding hour and cannot exceed
the machine-keyed `computer_use.enrollmentCeiling` row (default 1500).
The existing guard counts admitted `machine.input.*` attempts; a transport
refusal after admission still counts. Looking through `machine.screen.*`
never counts. At exhaustion the typed refusal is
`budget_exhausted { resetAt }`; `computer_list` returns each lease's
`usage.count` and `usage.resetAt` for the session card.
The captured `tool.pre` guard resolves host window/capture/observation facts
and enforces scope, foreground consent, expiry and pause state. Human input,
private entry, lock and sleep pause the lease; a subsequent turn resumes
only after a fresh, non-private observation. Stop ends the lease and
supersedes the attachment's computer relay, recording in-flight calls as
`unverifiable` with `cancelled` and unknown dispatch. A computer-only close
message fences active and delayed inputs through an input-sequence
barrier, without detaching other machine work; a failed cancellation
acknowledgement disconnects the attachment. A 120-second unattached interval ends
the lease as `detached`. Launch-returned windows carry session/turn
attribution and close at turn end using their epoch unless
`computer_keep` marks a deliverable or handoff; retained and unclosed
targets are reported in the cleanup tool result. The dedicated lease and
purpose display is tracked by #1701.

### 2.2.2 Window-bound observation and ref-targeted actions (#1689)

`Machine.contractVersion` is 3. The two methods below ride the existing
`computer.use` grant; the host refuses both with `observe_not_available`,
without a wire call, when the attached peer offered a contract below 3.

- **Observe.** `machine.screen.observe` takes `{target: {pid, windowId,
  epoch?}, since?, screenshot, maxElements?}` and answers one window's
  accessibility elements. Each element carries a `ref` minted from its role
  path (`role[i]` segments joined by `/`, `i` counting same-role siblings;
  an element with an empty role has `ref: null` and no actions), `role`,
  optional `label`/`value`, `actions`, a window-local `frame`, its `parent`
  ref, `secure` (a secure field's value is never sent) and the optional
  `enabled|selected|checked|expanded` states. The walk stops at 2000
  elements (or `maxElements`), 5000 visited nodes, 2.5 s and 256 KiB of
  serialized elements, answering `complete: false` when a bound cut it.
  Labels cap at 1024 characters, values at 4096, actions at 16 per element.
  `screenshot: true` adds a window capture that becomes the display's input
  anchor. `private` is normally `false`; private mode below defines its only
  `true` shape.
- **Identity.** The answer names `observationId` (`o<n>`), the lineage
  `w<pid>-<windowId>-<epoch>`, the target with its `epoch`, and the window's
  `title` and owning app (`bundleId`, executable `path`). The peer keeps an
  epoch table per attachment: a window that disappears and reappears, or
  whose owner changes, gets the next epoch. Only the lineage's latest
  observation is live.
- **Diff.** `since` naming the lineage's latest observation answers a
  `diff` (`added` and `changed` whole, `removed` by ref) instead of
  `elements`; any other id refuses `stale_observation`. Full-refresh
  exception: when either snapshot holds an element without a ref (empty
  role, ambiguous sibling or descendant, too-deep path, incomplete walk),
  the answer carries `elements` instead of a lossy `diff`. A walk cut by
  `maxElements` or the hard walk limit (`complete: false`) mints no refs,
  and the fresh walk behind an action must be complete too.
- **Action.** `machine.input.action` takes `{observationId, target: {pid,
  windowId, epoch}, ref, action: press|setValue|perform, value?, name?}`
  (value at most 65536 characters) and answers `InputWriteResult`. The peer
  rechecks the lineage, re-resolves the ref on a fresh walk and requires the
  same role, label and secure flag before it acts; nothing is executed on
  any refusal. Refusals: `window_not_found`, `epoch_changed`,
  `stale_observation`, `ref_not_found`, `action_not_supported`,
  `permission_denied`, `input_not_available`, `input_failed`.
- **Host.** Both methods enter the same captured `tool.pre` port as input
  (`captureInput`), so observation is an Owner-visible effect too, and both
  recheck attachment, generation and grant at forward time.
  `ComputerHandle` gains `observe` and `action`; code mode exposes them as
  `getMachine(id).computer.screen.observe` and `.input.action`.
- **Backends.** The ref minting, diff and epoch table are platform-free
  client code; the macOS backend reads the accessibility tree and performs
  actions only. The headless fixture layout gains per-window `pid`, `app`,
  `epoch` and `elements`, and records actions as `kind: "action"` recorder
  lines.
- **Pointer.** `machine.input.pointer` anchors at `at: {captureId, x, y}`
  or `at: {observationId, ref}`; a ref anchor is revalidated like an
  action and resolves to the element's centre, refusing with the same
  reasons. Windows mechanics are later work.

### 2.2.3 Window settle (#1691)

`computer.screen.settle({ target: { pid, windowId, epoch }, quietMs?,
timeoutMs? })` watches accessibility notifications after arming the
window observer and before taking its baseline observation. `quietMs`
defaults to 200 for accessibility and 500 for the pixel fallback (50–2000);
`timeoutMs` defaults to 5000 (100–30000). Each change restarts the quiet
interval. Accessibility answers `settled { method: "accessibility",
observationId }` or `pending { method: "accessibility", observationId,
changesInWindow }`; those fresh observations are usable as the next
`observe({ since })` anchor. When the observer is unavailable but window
capture works, settle compares consecutive window thumbnails at most
256×160 pixels every 200 ms. A change requires more than 0.5% of pixels
to differ by more than 8 in any RGB channel. The first identical pair
settles immediately; after a change, the samples must remain unchanged
for `quietMs`. It answers `settled { method: "pixels", captureId }` with
a fresh capture anchor, or `pending { method: "pixels", changesInWindow }`
at the deadline. A window disappearing during settle answers `destroyed`;
without either observer or capture, the result is `unsupported {
blocker: no_observer }`. The fallback is window-only; display settle is
deferred. When an observer can identify secure focus, the pixel path
refuses before capturing; without an observer, it retains only the
bounded comparison thumbnails and applies the window capture guard.
Window and epoch mismatches, permission denial and detach are typed
refusals. The macOS observer listens to AX changes on a dedicated run
loop; the headless layout's window `timeline` drives the same quiet-window
fold. The host bounds this call at the request's `timeoutMs + 1000` and
captures it through `tool.pre` like observation and input.

### 2.2.4 Input dispatch and uncertain outcomes (#1692)

The host mints a machine-scoped `requestId` (`<attachGeneration>-<seq>`)
for each pointer, key, text and ref action. The ID travels on the input
request, independently of the IPC envelope ID. Each new host process advances
the persisted attach generation before accepting input, while reconnects to
that host keep the generation and increasing sequence. Thus IDs never repeat
across host restarts, even after the client's bounded ledger evicts old IDs.
The client retains dispatch
status for the last 4096 IDs for its process lifetime, including reconnects;
a process restart loses that ledger. `machine.input.status {requestId}`
returns `{status:"ok",requestId,dispatched,state}` with `state` one of
`not_started|dispatched|completed|cancelled`, or a typed
`request_unknown|request_busy` refusal. A terminal `cancelled` status also
reports `eventsDelivered` (including zero before the first native event).
An unknown ID does not prove the event never ran.

An input call whose reply is lost answers
`{status:"unverifiable",reason:"transport_lost",dispatched:"unknown",
hint:"re_observe"}`. The client's per-event cutoff answers `cancelled`
with a known boolean dispatch fact; the union also admits `detached` and
`driver_timeout` at native boundaries. A
caller must re-observe the target before considering another action; the
host never resends an uncertain input request. On reconnect it queries
status for reservations still open, releasing completed or acknowledged
cancelled entries without replay; unknown entries remain reserved. Status
is a read behind the computer grant, not a captured input.

The host reserves one input per machine and window (`pid:windowId` when
targeted, `*` otherwise). A wildcard overlaps every window on that
machine; a second overlapping input refuses `window_busy`. Reservation
lasts until a terminal answer, known completion or acknowledged cutoff.
The client fences every
native event on the current attach generation and cancellation state;
`request_busy` refuses a duplicate live request ID.

### 2.2.5 Private focus (#1695)

Private mode is a client-side fact, not an app policy. Before observing or
capturing a resolved window, the client queries its
focused accessibility element. A secure attribute or the native secure-text
role makes the window private. A failed focus query fails closed; a window
without a focused element is not private.

- **Observation and effects.** Observing a private window succeeds with its
  identity and `{private: true, complete: true, elements: []}` but no diff,
  focused ref or screenshot. Window capture, text and key input, and
  coordinate input refuse `private` before dispatching. Display capture remains
  available and blanks each private window rectangle, including the
  intersecting part of a display-region capture.
  Text and key input require a known non-secure focus; un-aimed input
  requires exactly one window with such a focus and no other focused window.
  A ref action against a private observation refuses `private`; otherwise
  it checks the referenced node's secure attribute or secure-text role
  instead of the focused element.
- **Streams.** Window streams replace the whole frame while private; display
  streams blank private rectangles. `Report.streams[]` requires
  `private: boolean`, indicating whether the stream source currently
  intersects private focus. An open stream re-reads focus on a 250 ms
  monotonic cadence and changes its masking before the next frame.
- **Edges.** Each per-window transition emits
  `machine.event.private {machineId,target,state:"entered"|"left"}`. The
  host accepts it only from the attached matching machine and publishes
  `Machine.Events.Private` with its receipt time.

The accessibility gate cannot identify a custom-painted password interface
that exposes no secure accessibility role or attribute. The app exclusion
list in #1697 complements that platform limit.

### 2.3 Network transport (#1270)

The host owns a listener SET feeding one attachment registry: the unix socket
(mode 0600) is always bound; a TCP listener appears only when the Owner
configures `ONI_MACHINES_TCP_HOST`/`PORT` plus the host TLS identity
(`ONI_MACHINES_TLS_CERT`/`KEY` — all four or none, else boot refuses
typed). Handles, events and codemode are transport-blind: a machine is the
same machine on either door, and if one bind fails startup fails with the
other listener released.

Trust is key-pinned, not public PKI: `mclient join` records the host key pin,
and `run` verifies that key on every TLS connection. The host pins the
client's key through the REQUIRED `Enrollment.publicKey` (sha256
over SPKI DER, 64 lowercase hex). On TCP, an
offered machineId whose presented key differs from the enrollment pin is
refused `peer_key_mismatch` before admission, and a pin-mismatched intruder
never displaces a valid attachment. Unix connections carry no peer key; the
enrollment pin is simply not consulted there. See `docs/key-generation.md`
for openssl one-liners, rotation, and addressing. `Enrollment.publicKey`
is REQUIRED — existing `ONI_MACHINES_ENROLLED` values without it fail
closed at boot until each enrollment carries the client's key fingerprint.

`ONI_MACHINES_ENROLLED` is a first-boot seed for each machine id, not
ongoing authority. Once an id has a stored enrollment, later environment edits
do not replace it. Removed ids retain tombstones and are not restored by a
restart. Boot emits one operational warning per differing active seed, naming
the machine id and directing the operator to `provision machine_add`.
Use that Owner-approved operation to change a key or capability grant. Replacing
an active enrollment detaches its existing peer with `enrollment_replaced`;
in-flight calls fail as `disconnected`, and the next TCP attach must present
the newly approved key.

Disconnection is a first-class state: while a known machine's transport is
down, its handle calls — including calls that were in flight when the
transport dropped — fail once with typed `MachineRefusalError`
`disconnected` (never replayed); a machine that never attached stays
`machine_not_attached`. The client redials with full-jitter exponential
backoff (base 250ms, cap 30s); a successful reattach
resets the backoff and the host's existing handles serve the replacement
connection. A reconnect presents the generation the host minted for the
previous attachment (next section). Only `stale_generation`,
`unsupported_contract` and `peer_key_mismatch` refusals terminate the client;
other attach refusals retry with the same backoff.

### 2.3.1 Contract admission and the attach generation (#1624)

`Machine.contractVersion` is 2 and `Machine.supportedContractVersions` is
`[2]`. Every offer names its peer: `mclient` composes
`{ kind: "client", contractVersion: Machine.contractVersion }` itself.
The host judges one offer at a time (a
`Semaphore(1)` wraps `attach`) in this fixed order, and the first failing
step answers:

1. `machine_not_enrolled` when no enrollment exists for the offered id.
2. `peer_key_mismatch` when a TCP peer's presented key differs from
   `Enrollment.publicKey` (key pinning precedes contract negotiation so an
   intruder cannot displace a peer).
3. `unsupported_contract` when `peer.contractVersion` is not in
   `supportedContractVersions`.
4. `machine_mismatch` from the enrollment ∩ offer folds.
5. `already_attached` when the id is in `neverSupersede`, is attached on
   any connection (including the offering one), and the offer carries no
   `generation`. Fresh offers are refused before the generation store is touched.
6. `stale_generation` from the generation step below.

The generation is host-minted and durable. `createMachineHost` takes a
required `generations: AttachGenerationStore` port
(`current(machineId)` and `compareAndSet(machineId, expected, next)`);
`packages/machines` ships `createMemoryGenerationStore()` and
`createFileGenerationStore({ path })`. A fresh offer (no `generation`) mints
`current + 1` through CAS, re-reading once on a lost race and refusing
`stale_generation` if the second attempt loses too. A reconnect offer must
present exactly the current generation or it is refused `stale_generation`.
On the first attach of a machine in a host process, a matching saved generation
is superseded through the same CAS to `current + 1`. The host remembers the
machines whose generations it has issued; later matching reconnects in that
process retain their generation.
The accepted value is returned as `AttachResult.attached.generation`,
appears on `MachineInfo` (`generation` plus `peer`), and the client keeps it
for its next reconnect.

Admission supersedes: once a generation is accepted, the incumbent connection
for that id (and any earlier attachment on the same connection) is detached
with `machine.detached { reason: "superseded" }`, its leases are invalidated
with `stale_generation` so a pending `renewWhile` fails with
`MachineRefusalError { status: "refused", reason: "stale_generation" }`,
and the host disconnects the displaced connection. Every other detach
(transport loss, host closure, enrollment removal or replacement) invalidates
running leases with `disconnected`; `lease_expired` comes only from the
lease's own idle expiry or release. The file store writes
`{ "<machineId>": <generation> }` under an owner-pid lock directory at
`<path>.lock`, through a `<path>.tmp` rename with mode 0600; an unreadable or invalid file fails
closed as `MachinesFailure` (`generation.read` / `generation.compareAndSet`).
The app passes `createFileGenerationStore` with `ONI_MACHINES_GENERATIONS`,
default `~/.oni/machines/generations.json`.

### 2.3.2 The machine client (`mclient`, #1626)

`clients/machine-client` is the second peer kind on the same wire: a single
Rust binary that joins a host once and then attaches with
`peer: { kind: "client", contractVersion: oni_protocol::CONTRACT_VERSION }`.
The host admits it under the enrollment and exposes the same handles.

**Transport.** Frames are UTF-8, LF-terminated JSON, at most 16 MiB whether
complete or still pending. Calls get monotonic `c<n>` ids, a 30 s timeout,
and a 5 s connect timeout. Inbound host requests run 16 at a time with 64
waiting; the 81st blocked request is answered with error code 4001 and the
connection is closed. A unix socket (`join --unix <path>`) carries no peer
key; TLS connections present the client's own certificate and verify the
host by the SHA-256 of its SPKI DER against the persisted pin (next
paragraph and `docs/key-generation.md`). A pin mismatch at connect time is
`peer_key_mismatch` and terminal.

**Join and run.** `mclient join <host> [--name] [--tag]* [--export
name=/abs/path]* [--host-pin hex | --host-cert pem | --trust-on-first-use]
[--unix path] [--memory-budget-mb N]` writes `~/.oni/machine-client/`
(directory 0700; `client.json`, `client-key.pem`, `client-cert.pem`,
`host-pin`, `state.json` and `metrics.jsonl` all 0600), prints the
enrollment receipt `{machineId, name, publicKey, allowedCapabilities,
allowedExports}` on stdout for the Owner's `provision machine_add`, and
clears any saved generation. `machineId` is the slug of `--name` (default:
the hostname). `allowedCapabilities` always lists all four supported
capabilities so a later attach can offer whatever is available then.
`mclient run [--config path]` keeps the service available through attach
failures; `--once` makes one attempt and exits nonzero on refusal. A
memory-budget exit remains code 4. `mclient retry` signals the service PID
from `state.json` with SIGUSR1, or answers `service_unavailable` when absent
or dead; it never starts another service.

**Release pin and update.** The host serves `GET /machine-client/release`
from its bundled `dist/clients/release.json` and answers `machine.release`
before attachment. The release names its version, machine contract version,
and per-platform archive name, byte count, SHA-256 and URL. Join stages and
probes the host's binary before installing the service, and records the
host version in `machine-client/pin.json`; if the release is unavailable it
adopts the running binary with `pinned: false`. The service executes the
`~/.oni/bin/current` symlink, which points into
`~/.oni/machine-client/versions/<version>/mclient`. `mclient run` refuses
`unpinned_binary` without a matching saved pin unless
`--allow-unpinned` is set.

`mclient update` reads the saved host connection; `--from URL` or
`--file PATH` selects an explicit release document. It verifies the archive
length and SHA-256, extracts the staged binary, checks `--version --json`,
and runs `probe --release` against the release and, when obtained from the
host, its contract version. Probe does not attach or touch enrollment and
generation. A refusal (`release_unavailable`, `checksum_mismatch`, or
`probe_failed`) writes an `update_failed` receipt to `metrics.jsonl` without
changing the running service or `current`. Once verified, update retains
`bin/previous`, atomically renames the new `bin/current` link, updates the
pin, and restarts the service. An active or
rollback version directory cannot be overwritten during staging. If the
service manager refuses the restart, the previous link and pin are restored
and the attempt is recorded as a refusal.

**Generation and reconnect.** The accepted `AttachResult.attached.generation`
is saved to `state.json` and presented on every later offer; a first offer
omits the `generation` key entirely, because the Offer schema allows absence,
never `null`. An unreachable host, a timed-out attach call, or a
remote refusal is classified as `authentication`, `configuration`,
`host_unreachable`, `remote_unavailable`, `timeout`, or neutral `superseded`.
Network and remote failures retry with an exponentially growing 2–300 s
ceiling and a delay in its upper half; 30 s attached resets the schedule.
Authentication and configuration park for 5 min before re-probing. A wake
or explicit retry cancels the pending delay; wake gives a 30 s window of
flat 2 s retries, suspend cancels it, and a changed interface list triggers
an immediate attempt. Host ping is sent every 5 s only when the offer
advertises `capabilities: ["ping"]`; a silent opted peer is detached after
15 s (`ping_timeout`). Existing clients without that offer keep report
cadence, because their unknown-method error is not a typed refusal.
The client reconnects after 15 s without a host frame. Each heartbeat
includes optional `transport: { lastFailure, attempts }`, projected into
`machine_list`, while failures are appended to `metrics.jsonl`.

**Offered capabilities.** `fs.read` and `fs.write` are offered only when the
config has at least one export, `pty.session` only when `tmux` answers its
version probe at start, and `shell.exec` always. Enrollment ∩ offer stays
the authority: a granted-but-unoffered method answers the driver's own
refusal (`fs_not_available`, `exec_not_available`, `pty_not_available`,
`export_not_available`), and before attach every method is refused
(`machine_not_attached` for `fs_stream`). Detach drops the grant and aborts
every open transfer.

**Filesystem.** `fs_op` read/write/list/stat and
`fs_stream` begin/chunk/finish/abort over the same descriptor-pinned,
no-follow confinement (each symlink expanded by rewriting the remaining path
from the export root, at most 40 expansions), 256 KiB read and write caps
with `truncated`, 1000 list entries, 32 open transfers (the 33rd is refused
without eviction), staged writes under `.oni-transfer-<sha256(id)[..32]>`
published only after the SHA-256 digest matches at `finish`, and the
exclusive-create contract: `create: "exclusive"` opens with `O_EXCL`,
follows no link anywhere on the path, refuses an existing file, directory or
symlink with `already_exists`, and publishes a stream with a no-replace
rename (the host uses a hard link; the observable result is the same on
ext4 and APFS, and a filesystem without a no-replace rename answers
`io_error`). Exec: `machine.exec` with cwd confined to a granted export, a
256 KiB shared stdout+stderr budget with `truncated`, the 30 s host deadline
answered `timed_out`, and the whole process group killed on timeout,
cancellation or drop. Terminals: `pty_open/write/read/resize/close/list` over
one tmux control-mode client on the user's default server (control session
`oni-pty-control`; socket ownership on that shared server is #1666), with the attach-time scrollback replay, a 1 MiB live
window per terminal, 256 KiB reads, cursor continuity across client restart,
and `pty_read` with `source: "screen"` for the pane snapshot.

**Not offered.** `run_code` and `peek_code` answer `kernel_not_available`,
`cancel_code` answers `{cancelled: false}` (the result schema has no refusal
variant), `screen_read` answers `screen_not_available` and `input_write`
answers `input_not_available`, each after its params decode; a host-served
name (`attach`, `report`, `call_tool`, `pty_output`) is an invalid method.

**Human-input facts.** An optional heartbeat `humanInput` fact contains only
the last input time, pointer/keyboard/both source and count for that interval;
`session` contains locked and asleep booleans. A macOS listen-only session
event tap discards events bearing the client's `ONI_EVENT_TAG` user-data marker
before counting input. An untagged event after more than 2 seconds without
human input sends one `machine.event.human_input` edge notification, throttled
to at most one per 250 ms. Without the Input Monitoring grant, no input fact
is asserted: `humanInputUnavailable` reports
`input_monitoring_not_granted`. The host stores the latest report per
attachment and publishes authenticated edges as `machine.human_input` bus
events; it never enforces computer-use policy from these facts. The lease
consumer is a separate app concern.

**Memory budget and metrics.** Every 5 s heartbeat appends one line to
`metrics.jsonl` (`at`, `rssBytes`, `inFlight`, `retainedPtyBytes`,
`transfers`) and samples RSS against `memoryBudgetMb` (default 96). The
first beat over budget sheds (every open transfer is aborted, then the
terminal holding the most output releases its buffers; its cursors stay
valid and a reader inside the released range gets `data: ""` with
`truncated: true`) and enters a restricted state in which `machine.exec` is
refused `exec_not_available` and `fs_stream` `begin` is refused `too_large`;
two consecutive beats under budget lift the restriction, and the third
consecutive beat over budget exits 4 (`memory budget exceeded`). Replay-cache
bytes held by open transfers are measured but not yet written to
`metrics.jsonl`.

**Conformance.** `bun run clients:conformance`
(`script/check-clients-conformance.ts`) drives a prebuilt
`clients/target/debug/mclient` against the TypeScript host over a temporary
unix socket: join, first attach (`peer.kind` client at generation 1), fs
parity including the `already_exists` refusal, a chunked 528,609-byte
stream with digest, exec and its `timed_out` deadline, the full terminal
sequence over tmux, kill and re-admission at the same generation, a
synthetic stale generation refused with exit 3, and finally an attach with
tmux stripped from `PATH` that must offer no `pty.session` and refuse
`pty_open` with `pty_not_available`. The harness never builds the binary
and never sleeps; it waits on host `Attached`/`Detached` events.

### 2.3.3 Agent sessions, the sync cursor and the permission bridge (#1629)

This is the target contract for the fourth phase of #1622. What of it is
wired, and with which receipts, is the #1629 section of
[implementation-status.md](implementation-status.md); the paragraphs
marked *shipped* below name the parts that section already evidences.

**Capability and methods.** A client peer that can run terminals and holds
at least one export may offer `agent.session`. Behind that capability the
host calls `agent.session.list`, `agent.session.open`, `agent.session.tail`,
`agent.session.send` and `agent.session.stop`; the machine calls the host
with `agent.session.permission`. The capability follows the usual rule,
`effective = enrollment ∩ offer`, and is served only to `peer.kind ===
"client"`. The methods are additive on contract v2. *Shipped* on both sides:
`mclient join` lists `agent.session` in the enrollment receipt alongside the
four P3 capabilities, so a real join can negotiate it; the attach offer
drops it when tmux or an export is missing.

**Sessions and layouts.** A session is one CLI process on the machine whose
transcript the client can find on disk. The client supports exactly four
dialects, selected by data in `agent/manifest.rs`, never by code outside
`clients/machine-client/src/agent/`: `claude-code`, `codex`, `pi` and `omp`.
Each dialect is a transcript layout (where the `.jsonl` lives, how the
project path is encoded in it, whether the id is assigned by the client or
discovered from the file name), a launch command and a permission mode.
Parsers are pure over bytes and normalize every line into one disjoint
record: a turn, a tool call, a tool result, a `corrupt` line with its reason,
or a `truncated` line with its original byte count. Non-transcript metadata
is skipped, never surfaced. `open` reclaims a live registered terminal,
adopts an existing transcript by id, or launches; `attach` never launches;
`send` and `stop` work only on a session the client owns. The per-project
registry at `~/.oni/machine-client/agent-sessions.json` is a reclaim hint
that binds one session id to one project and CLI; liveness is always
observed, never assumed, including for a session the client already owns,
and a launch cancelled before its session registers leaves no process. *Shipped* for all four layouts
against retained fixtures; the `omp` fixture is pinned to the published
format rather than copied from a live transcript, and `pi`/`omp` ids are
discovered rather than assigned.

**The cursor.** `tail` is a bounded page (32 records or 256 KiB) ending in a
server-minted cursor `{sessionId, generation, byteOffset, recordHash}`,
where `recordHash` binds the session id, attach generation, offset and complete
prefix bytes and `generation` is
the attach generation of #1624. The host never resumes by anything else: a
continuation names no second session, a cursor from another session, a
rewritten prefix or a shrunken file is `invalid_cursor`, and a cursor minted
under an earlier generation is `invalid_cursor` on the client and
`stale_generation` at the host's generation check. Cursor recovery is
therefore mechanical: a reconnect at the same generation resumes from the
last acknowledged source offset without restarting from zero; downstream effects
still require their own acknowledgment or deduplication. A new
generation requires an explicit resync by `sessionId` from the origin.
Damage advances the cursor at record boundaries (a malformed complete line
is one `corrupt` record and the cursor moves past it; a partial trailing
line yields nothing and leaves the cursor in place; an oversized line is one
`truncated` record). *Shipped*, with the resume, replay, concurrent-tail,
reconnect and damage cases as test receipts.

**Permission bridge.** The machine never decides a tool permission. A
dialect in hook mode asks the running client over a private local socket
(`hook.sock` in the client's config directory, 0600, named to every
launched CLI in `ONI_MCLIENT_HOOK_SOCKET`) through `mclient hook permission
--cli <name>`; the client relays `agent.session.permission` to the host,
which answers through the application's injected decision port (the
captured `tool.pre` gate; the app does not bind it yet, #1665, so the host
denies). Every non-answer is a deny: no socket, no
attached connection, a disconnect while pending, a malformed or mismatched
answer, a port failure, and the deadline (30 s at the host by default, 150 s
at the hook socket, 190 s in the shared module) all block the tool call, and a late answer finds no waiter.
`codex` is served without a hook (its own terminal prompt stands) and that
is the documented support limit, not an interception. *Shipped*: the host
port with deny-on-timeout and deny-on-disconnect, the client relay and the
fail-closed hook with exit 2 on every non-allow path; `pi` and `omp` share
one hook module, reinstalled whenever the file differs from the shipped
bytes and exercised in conformance, but not yet inside a live `pi` or `omp`
process.

**Sync checkpoints and the VFS.** Transcript and project bytes leave the
machine as content-addressed bundles and per-project checkpoints owned by
`packages/sync` (`@oni/sync`, protocol-only). A checkpoint id binds
`{projectId, sequence, parent, changes}`, so replay from empty rebuilds the
manifest and refuses a foreign project, a broken parent link, a wrong
sequence or a tampered change as `checkpoint_broken`. `fetchBundle` trusts
nothing from its source and re-verifies every entry and blob. The resulting
view is a frozen read-only VFS over manifest keys (`list`, `read`, `stat`),
with traversal rejected before lookup and digests checked on read; real-path
confinement stays the machine host's `contained.ts`, and sync adds no
second fs policy. Ownership: `packages/sync` holds the folds and the memory
store; the host fetches through an injected `BundleSource`; the app binds
that port and decides what is exported when. *Shipped* as the package and
its conformance round trip (export, kill, import, re-attach, resume at the
same byte); app composition of the port is not wired yet.

### 2.4 Self machine (#1271)

The brain host is an ordinary attached machine. `machines.self` enrolls the
application host itself: `{id?: "self", capabilities, exports[{name, path}]}`
via `ONI_MACHINES_SELF` (JSON), with `ONI_MACHINES_DEFAULT` naming
the machine a prefix-less path resolves to (default `self`). Self exports are
mandatory and absolute — the Owner names the host roots the spawned client
may expose; no host path outside them is readable, writable, listable,
stat-able, or usable as a shell cwd. Duplicate self/enrolled ids, a default
absent from effective enrollments, and empty or relative exports are typed
configuration refusals BEFORE the listener starts. `ONI_MACHINES_INBOX`
(absolute, must already exist inside the default machine's exports) names the
directory where inbound channel attachments are stored before the Resident
sees the message; unset, attachments keep their platform references.

Boot order is fixed: validate the plane, start the listener set, start an
spawned `mclient` with the self exports, dial the host's own
unix listener and complete `machine.attach`, and only then publish tool
ports. Every failure in that chain is the one typed startup refusal
`self_attach_failed { cause }`; there is no local execution fallback — ever.
`apps/oni/src/bundles/tools/<tool>/index.ts` and `apps/oni/src/bundles/provision/provision.ts` contain no `node:fs`, no `Bun.spawn`, and no
local locus: `parseLocus(input, { defaultMachine })` maps `/absolute/path`
to the configured default machine and preserves explicit
`machineId:/absolute/path`; relative paths refuse (no process cwd exists).
A self client that disconnects after boot keeps the tools published but
every call refuses with the typed `disconnected` reason; the lifecycle
surface is the typed `machine.detached` event plus a logged
`self_attach_failed` cause. A remote `mclient` attaches alongside `self` over the
same protocol and negotiates capabilities through the same
enrollment/offer intersection.

### 2.5 Persistent terminals (`pty.session` over tmux, #1273)

- Capability `pty.session` is offered only when `tmux` resolves on PATH at
  attach time; enrollment ∩ offer
  stays authoritative, so an installed binary alone grants nothing. Wire
  methods: `machine.pty_open/pty_write/pty_read/pty_resize/pty_close/pty_list`
  with protocol-owned bounds (`PTY_READ_MAX_BYTES` 256 KiB,
  `PTY_WRITE_MAX_BYTES` 16 KiB, list 1000, cols/rows 1000, `waitMs` <= 30 s)
  and typed refusals `pty_not_found` / `pty_not_available` /
  `path_escapes_export`.
- The client runs one tmux control-mode connection (`tmux -C`); each `pty_open`
  is `new-session -d` with cwd confined by the SAME `openCwd` rule as exec
  (refused before any session exists, symlink escapes included). Same-name
  open reattaches, never creates a second session; each session's window is
  linked into the reserved control session `omo-pty-control` because
  `%output` only flows for the attached session's panes.
- The client uses the user's default tmux server unless its optional
  `tmuxSocket` setting selects a private server: granting `pty.session` exposes every grammar-conforming
  session on that server — reattach-by-name reaches sessions the user created
  (cwd confinement applies at open, not reattach) and `pty_close` can kill
  them (socket ownership on the shared server: #1666). This is the accepted #1273 design (restart rediscovery makes a prior
  generation's sessions indistinguishable from the user's); names outside the
  `PtySessionName` grammar stay invisible to list/discovery and refuse typed.
- `pty_read` is the authoritative pull: one cursor sequence replays the
  `capture-pane -S -` scrollback snapshot taken at attach, then live decoded
  `%output` bytes, with no duplicate bytes across the transition. Cursors are
  opaque monotonically advancing tokens (`p1:<generation>:<offset>`); callers
  persist only the returned token. Over-cap reads return the bounded suffix
  with `truncated: true` and a cursor past ALL observed output; a
  foreign-generation cursor resumes after the current snapshot. The optional
  `machine.pty_output` notification is a wake-up only, never output state.
- The tmux server, not the client, owns session lifetime: a client restart
  rediscovers sessions by name (`list-sessions`) with scrollback and cursor
  continuity. tmux server death marks every session `lost`, settles pending
  reads as `pty_not_available`, and withdraws the capability until the next
  attach probe. A malformed control record fails exactly the affected pane's
  next read, then streaming resumes.
- Model doors (the 12-tool catalog stays sealed): `bash` gains optional
  `session` — with `machine`+`session` the command is typed into the named
  terminal (`send-keys` literal hex chunks) and stdout carries output since
  the tool's own per-session cursor; an empty command just reads. `monitor`
  watches a named terminal through the same cursor door (subscribe at the
  current cursor, drain `pty_read` beyond it: each retained byte at most
  once, so screen repaints can never re-fire a line) and its completion never
  closes the terminal. Code mode: `m.pty(name)` handles with
  `open/write/read/resize/close` plus `m.ptyList()`.

### 2.6 Code-mode ownership and lifecycle

`createCodemode({machines,completion,tools})` is a reusable facade over a
structural machines port. It supplies
`cell.run(code,tenant,{timeoutMs,waitMs,signal})`, `cell.peek(cellId,tenant)`,
`cell.stop(cellId,tenant)`, `listMachines`, and `machine(id | tag=, prefer=)`.
Tag lookup selects one eligible member with a pick-time lease; stale,
unsupported, or saturated pools are typed errors. Handle methods are the tool names —
`read/write/ls/bash/eval` — forwarding raw structures and bytes. The same
names are installed under the Python `codemode` global; Python reads and bash
outputs contain bytes, and writes accept bytes.

`cell.run` waits `waitMs` for the cell to settle and otherwise answers
`running` with the cell id and the output produced so far, keeping the cell
in a per-tenant background registry until `timeoutMs` (the app's ceiling is
ten minutes). The interpreter streams stdout/stderr frames as the cell prints,
so `peek` (wire `machine.peek_code`) reads a running cell's partial output
without waiting, and `timed_out`/`cancelled` results carry what was printed
before the interrupt. `stop` aborts the cell's own controller and settles it as
`cancelled`; the code never runs again. A settled background result is handed
over exactly once, and an id from another tenant is `unknown_cell_id`.

The Rust client starts Python lazily on its first code request and owns the
interpreter map, per-tenant persistence,
parallel helper, `completion(prompt, model=, system=, schema=)` helper (a
`schema` answer is decoded with `json.loads`), callId routing and cell
bindings. Different tenants never share an interpreter. Nested handle `eval`
uses a nested tenant to avoid queuing behind its calling interpreter. The brain
facade never spawns Python. The app captures its executor and tool catalog at
cell entry; `eval` (`operation: { op: "run", code, timeout? } | { op: "peek",
cell_id } | { op: "stop", cell_id }`) is metadata/render plus one
`cell.run`/`cell.peek`/`cell.stop` call, with the session id as tenant.
Machine-handle calls pass through the captured executor's `tool.pre`, without
manufacturing model tool definitions.

A call is accepted only from the connection with that live cell in flight.
Forged, late and detached callbacks cannot inherit another cell's authority; an
output frame naming another cell is dropped. `machine.cancel_code` propagates
AbortSignal cancellation. Timeout/cancel/stop kills that interpreter, discards
its state and lets its successor start fresh.
Attachment loss closes the client runner and awaits process cleanup.
Facade close cancels and awaits its live requests.

`mclient run --config <settings.json>` attaches the Rust machine peer.
The app's self machine starts that binary as a child; `oni daemon` manages
the separate Resident service. The settings file carries machine identity,
host address, export roots, tags and memory budget, not an offered-capability
allow-list. The host's enrollment row limits effective capabilities.
After `mclient join`, run with settings such as:

```json
{
  "machineId": "laptop",
  "name": "Laptop",
  "host": "127.0.0.1:7643",
  "unix": "/tmp/oni-machines.sock",
  "exports": [{ "name": "work", "path": "/home/owner/work" }],
  "tags": ["local"],
  "memoryBudgetMb": 1024
}
```

### 2.7 Browser automation recipe (`browser()`, #1275)

Code cells drive a Chromium on an attached machine through the prelude helper
`browser(machine_id, *, headless=True, profile_dir=None, executable_path=None)`.
It adds no capability id, wire method, or model tool: Chromium runs
persistently inside a cell-owned `pty.session` tmux session and the returned
`BrowserClient` is a thin wrapper around Playwright's
`chromium.connect_over_cdp(endpoint)` — `client.browser` is the raw Playwright
browser, `client.context`/`client.pages` expose the default persistent
context, and raw page operations raise Playwright's own errors. The embedded
desktop browser tracked in #1023 has separate ownership and is not changed
here.

Prerequisites on the machine: `pty.session` + `kernel.py` capabilities,
`tmux`, and Python Playwright with a Chromium download
(`pip install playwright && python -m playwright install chromium`). A missing
executable refuses typed as `browser_lost` naming the resolved path and that
install command, and the launch session is torn down. Cells execute on the
machine itself, so the CDP endpoint is `http://127.0.0.1:<port>` and the
helper may address the browser process directly during cleanup.

- Profile confinement: `profile_dir` must sit inside an effective export;
  omitted, it defaults to `<cell cwd>/.oni/browser-profile`. The session
  opens with that directory as cwd, so the existing `openCwd` export rule
  refuses `path_escapes_export` before Chromium starts. The profile persists
  across close and reconnect (`--user-data-dir`), pairing the documented
  requirement that `--remote-debugging-port` never runs on the default
  profile.
- Port selection: the launch probe-binds on the machine starting at the
  documented default 9222 and advances past occupied ports; the chosen port
  and the browser pid are printed as `[oni-browser] cdp-port <port>` /
  `chromium-pid <pid>` lines and retained in the session output, which is the
  source of truth for reconnection and diagnostics. Readiness is the exact
  `DevTools listening on ws://` line from Chromium, never elapsed time.
- Display mode is explicit: `headless=True` (default) for unattended
  machines, `headless=False` for a usable display. Both share profile,
  connection, and lifecycle. Switching modes on a live client is a typed
  error: `close()` first.
- Reuse and loss: repeated `browser()` calls for the same machine and profile
  return the live client; a stale connection reconnects over the retained
  endpoint. Liveness is a bounded probe of the CDP http endpoint at every
  client accessor; a browser that exited or lost CDP raises the typed
  `browser_lost` refusal carrying the captured tmux output. The helper never
  silently launches a replacement — that would hide profile, process, or
  display failures.
- Session lifetime: the launch line ends the tmux session on a clean exit or
  a signal-range status, and keeps it alive on a real error status so the
  failure output stays readable (`machine(id).pty(session)` or
  `tmux attach -t <session>` inspects it; the session name is
  `oni-browser-<sha256(profile_dir)[:12]>`). `client.close()` ends
  Chromium and the session but keeps the profile. Interpreter close stops
  each client's browser process directly as best-effort cleanup.

```python
client = browser("laptop")                      # headless, default profile
page = client.context.new_page()
page.goto("https://example.com")
print(page.title())

# later cell, same interpreter: the live client is reused
client = browser("laptop")

# headed variant on a machine with a display, explicit profile
headed = browser("laptop", headless=False,
                 profile_dir="/home/owner/work/.oni/browser-profile")
headed.close()                                  # ends Chromium + session, keeps profile
```

### 2.8 Drain-restart deploy (#1699)

The service unit runs `oni supervise`, not the host: `ExecStart=<bun> <entry> supervise`,
and on systemd `ExecReload=<bun> <entry> deploy --reload`. The supervisor owns
`~/.oni/current` (a link to a staged release under `~/.oni/releases/`; absent,
the supervisor's own entry runs), spawns the host child `oni start` from it,
forwards SIGTERM, and exits with the child's code when the child dies outside
a deploy. The host child never replaces itself.

**Control socket.** `~/.oni/supervise.sock` (mode 0600) takes one JSON line per
connection and answers one line (`apps/oni/src/cli/supervise-wire.ts`):

- `{ op: "deploy", artifact, targetVersion, graceMs (0..300000), token }` — the
  token is `~/.oni/supervise.token` (0600, fresh at each supervisor start);
- `{ op: "reload" }` — re-deploys the newest staged release at the default
  grace (60000 ms); the socket's mode is its authentication;
- answer `{ ok: true, instanceId } | { ok: false, class, step }`. A request while
  one runs refuses `deploy_in_progress`; a malformed line `invalid_request`; a
  wrong token `unauthenticated`. `oni deploy` with no socket answers
  `supervisor_unavailable` and stages nothing.

**Host surface.** `oni start` serves, beside the unauthenticated `/health`,
`GET /status` → `{ version, instanceId, contractVersion, capabilities:
{ drainRestart: true }, state: open | draining }` and `POST /drain
{ expectedInstanceId, targetVersion, graceMs? }`, both requiring
`Authorization: Bearer <ONI_WS_TOKEN>` (a tokenless host refuses both). The
instance id is a 26-character time-ordered id minted at boot. A mismatched id
refuses `instance_mismatch` (409), a running drain `draining` (409). While
draining, the router's one prepare step refuses `draining` to any message that
would create a session or wake an idle one (`drainAdmission`,
`apps/oni/src/composition/drain.ts`); steering of a session whose turn is in
flight and a live turn's own outbound sends are continuations and pass, as do
request answers and interrupts. Each connected socket gets `{ type:
"draining", targetVersion, graceMs }` (`Gateway.HostDrain`), and the desktop
composer shows a restart notice until the frame clears or the socket drops.
One work tracker counts every turn from its start through the detached body's
terminal commit (entity, process-runner and tool paths) plus admitted ingress
until routing returns. The drain answers `{ drained: true, inFlight: 0,
projectionsIdle: true }` when that count reaches zero, then the host SIGTERMs
itself; at the deadline it answers `{ drained: false, inFlight,
projectionsIdle }`, reopens admission and sends `{ type: "drain_cancelled" }`.

**Replacement** (`apps/oni/src/cli/deploy.ts`), each step's refusal class in
parentheses: the staged release's `--version` equals `targetVersion`
(`version_mismatch`); drain the live host (`drain_refused`, `drain_timeout`);
wait for the child's exit within `graceMs + 30 s` (`exit_timeout`: the child
is stopped and the previous release restarted); take the catalog owner lock —
the same `Core.acquireOwnerLock` that `Core.openLedger` takes for a file
catalog — and copy `catalog.sqlite` (+ `-wal`, `-shm`) and the sessions
directory to `~/.oni/deploy-snapshot`, then release (`lock_held`,
`snapshot_failed`: the previous release restarts on untouched files); point
`current` at the release and start the candidate on the same port; verify its
status: a new instance id, `state: open`, `targetVersion` and the machine
contract version (`candidate_failed` at `start`, `verify_failed`). A failed
candidate is stopped, `current` repointed, the snapshot restored under a fresh
owner lock, and the previous release restarted. The restore runs only when the
owners log (`<catalog>.owners`) shows no writer but the candidate between the
snapshot's mark and the restore's own acquisition; another writer, or a held
lock, answers `restore_refused` and leaves the files. The snapshot is first
copied beside each live path (`.restore`) and then renamed in, so a failed copy
leaves the live files untouched. A throwing link write or spawn rolls back the
same way (`io_failed`); supervisor shutdown cancels the replacement at the
next boundary (`cancelled`: files restored, nothing started); a recovery step
that throws answers `recovery_failed`. The supervisor's version probe and
host client reads are bounded by an abort signal, and the client reaches a
wildcard or IPv6 bind through its loopback address. The service manager sees
the supervisor exit with the host's code once a deploy that observed the host
exit settles.

**Owner lock.** `<catalog>.owner` is held by an exclusive `flock` on an open
descriptor for the holder's lifetime, so the kernel releases it on exit — no
pid probe, takeover or deletion. A second opener refuses `OpenRefused`
`owner`. Process-runner children inherit the descriptor as fd 3
(`Core.inheritOwnerLock`) instead of opening their own. Every acquisition
writes `{ owner, pid }` into the file and appends one line to
`<catalog>.owners`; `Core.ownersSince` reads the owners between two marks.

## 3. Session messaging contracts

The model and cell catalog exposes one `send_message({to, message, kind?, reply_to?, deadline_ms?})` tool. Targets are an existing session (`to.kind: session`), a new parent-linked session (`new_session`), or an existing contact (`contact`; the protocol keeps `actor` internally). `kind` is `prompt | interrupt | resume` and defaults to `prompt`; a committed prompt becomes a letter in the recipient inbox. The returned `{messageId, target}` is a handle, not a synchronous join.

Every request enters `gateway.ingest(sender, envelope)`. External drivers provide authenticated sender coordinates and raw `Gateway.IngressFacts`; session tools supply their executor-bound session identity. Compiled message pre-policy selects external table A or session table B. Worker actor sends and worker allocation are denied by the default rows. The gateway reads perimeter facts and uses the injected L1 inbox writer; it does not query session state.

L1 supplies source fences, target relationship/depth/fanout facts, and the child's initial configuration. Child configuration and first inbox commit are atomic. Native and process sessions use the same session runner. A process transports a session id and model configuration over shared durable storage; its output carries committed inbox doorbells, not acceptance or completion settlements.

Child terminal mail preserves final text, terminal kind and original reply binding. Its atomicity, source answer/deadline CAS and exactly-once identity belong to the session/action store. Deadline requests use durable alarm rows, never per-message application timers. The retained Wait fold still owns external reply correlation; it is not a second worker lifecycle.

A machine remains WHERE execution happens, not a messaging target. Actor delivery uses the existing grant, egress-budget, endpoint and idempotency kernel, returning `accepted | rejected | unknown` only for an executed actor effect. Session commits succeed or throw. Current verification and remaining integration gaps are listed in [Implementation Status](implementation-status.md).

## 4. Tool execution boundaries

The executor's `tool.pre` policy point owns call-time admission. There is no
separate target-selection package or capability-based catalog fold. Machine
operations additionally cross the client's negotiated capability/export boundary.
The model-fallback fold belongs to the agent model plane (`packages/agent/src/model/`). Tool `safe` derives only from
`category === "query"`.

## 5. Ownership boundaries

The historical rollout sequence is retained in git history. Messaging now uses session inboxes and the shared executor, including from code-mode cells. Native and process child sessions use the same terminal-to-parent contract. Actor sends retain the channel grant/egress/Wait correlation kernel.

#947 owns continuous live due-alarm dispatch and monitoring. #969 owns unification of the retained generic Wait and approval lifecycles. Neither introduces a second messaging or execution authority in this cutover.
