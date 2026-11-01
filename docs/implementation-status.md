# Implementation Status

## #1720 leased clipboard access

Machine clipboard read/write runs through the captured computer-use lease gate; the client retains bounded previous contents locally for conditional lease-end restoration, and ledger facts expose only format and byte counts.

## #1677 gateway screen stream stage-metrics probe

`oni machine probe <machine-id> <display-id> [--reconnect-after-ms <ms>]`
opens a stream through the Owner-authenticated loopback gateway, decodes
its H.264 frames in a headless viewer, and writes one JSON report with
capture-to-encoded-receipt and capture-to-decoded-frame percentiles,
sequence-gap drops, and explicit reopen first-fresh-frame timing. The
host's clock offset maps each client capture timestamp to host wall time.
The report marks capture-to-display `null` with `displayedBy: "none"`:
the desktop presenter and live MacBook acceptance remain open on #1677
and #1702. The command and JSON shape are in `docs/first-live-run.md`.

## #1718 ref actionability

Ref-targeted press and perform check disabled, zero-size, off-window and hit-test occlusion before dispatch, setValue checks disabled, and blocked actions wait at most two seconds by default before a typed `not_actionable` refusal.

||||||| f68476e73
## #1722 setup needs on screen verdicts

The Rust client derives actionable `Report.screen.needs` from the screen
blockers it probes and its service and linger facts. The eight stable step ids
include reserved `portal_consent` and `uinput_group` for the unshipped Linux
backends tracked in #1700; neither is emitted today. Wayland without X11
instead reports `x11_session`. Available screens omit `needs`. `mclient
join --json` and `mclient status --json` print the same setup verdict fields,
and the host preserves reported needs in `Machine.Info.live.screen` for
`machine_list`.

## #1729 human-input quiet window and typed retry

The computer-use guard admits observation and settle during a human-input
pause. Input, app launch and window mutation return a typed
`paused:human_input` refusal with `humanActiveMs` measured from the latest
human-input edge and `retryAfterMs` (zero once only fresh observation remains).
Policy-state rows `computer_use.humanQuietMs` and `computer_use.maxWaitMs`
default to 10000 ms and 20000 ms. Every input inside the quiet window is
refused immediately; sustained activity asks the turn to end. A later
turn must fully observe after the edge, and old input anchors refuse with
their existing stale-anchor reasons. No captured input is replayed.

## #1725 macOS screen grant restart

While the running macOS client reports Screen Recording denied, its five-second
report tick watches the preflight grant. Once granted, it sends the updated
screen fact before exiting with code 75; launchd KeepAlive restarts it to
apply the permission to a fresh process. At most three such restarts per hour
are recorded in `~/.oni/state/grant-restarts.json`. Beyond that limit the
client stays attached and reports `restart_bound`. Linux has no grant restart.
`mclient join` describes the automatic restart; manual kickstart remains in
its help. MacBook live grant acceptance remains tracked in #1702.

## #1735 computer-use prompt guidance

When the composed catalog includes the computer tool pack, resident and child
system prompts include screen-text trust, irreversible-action confirmation, and
consent-surface stop guidance. Without that pack, the section is absent.

## #1731 stream capture-to-display timing

The client answers `machine.ping` with receive and send timestamps on its
process-monotonic microsecond clock; older replies without timestamps still
decode. The host keeps eight recent ping exchanges per attachment and uses the
minimum-RTT sample to map that clock into host wall time. Only the host's live
machine transport view carries `clockOffsetMs`; client-written
`Report.transport` does not. Each encoded frame queues a data-channel
`{ seq, capturedAtUs }` sidecar before writing its H.264 packets, and the
stream handle maps the sidecar timestamp to `capturedAt` for its subscriber.
The machines package exposes a pure nearest-rank frame-latency fold over
displayed frames, including sequence gaps and the first fresh frame after
reconnection. Fixture stream and fixed-clock tests cover these paths; a
MacBook capture-to-display acceptance record still belongs to #1702.

## #1694 screen verdict and Linux virtual display

Contract v4 replaces `Report.screen.permission` with a verdict
(`available | partial | unavailable`), typed blockers, display kind and
isolation, and separate capture, accessibility and input grants. Host
admission accepts v3 and v4 peers. The host folds a v3 permission heartbeat
into v4 facts conservatively: it proves capture only, not input or observation.
The v3 monitoring-unavailable field becomes a screen blocker; normalized reports
and gateway rows carry no superseded top-level field. Malformed v3 reports use
the IPC error channel; v4 reports use the typed `invalid_report` refusal.
Neither replaces the live row. `prefer: "computer"` selects only
machines with effective `computer.use` and reported capture and input grants, ranks available above partial,
then isolated above console, and uses spread credit to break ties. Other
placement preferences retain their existing order.

The Linux client captures X11 root and window images through x11rb and
injects input through XTEST. Dynamic mappings preserve both symbol levels and
remain stable for the driver's lifetime, including after key release: server
processing does not acknowledge application consumption. Text reserves every
required mapping before emitting events and refuses an exhausted keycode pool
without delivering a partial string. The original keymap is restored on driver
drop. Reports retain the selected display and probe the serving
capture/input connections; another server or a replacement at the same display
number cannot certify a disconnected driver. `computer.display.kind: "xvfb"` starts an owned
Xvfb process with an optional window manager (openbox by default when
installed). Xvfb allocates its display through `-displayfd` and runs with
`-noreset`, so the readiness handshake's disconnect does not regenerate the
server under the window manager's or a later client's connection; launches cannot
inherit or restore the human session's compositor, bus or runtime bindings.
Both app and window-manager launches clear the inherited environment before
applying the allowlist and selected display binding.
Window-manager startup observes the X11 EWMH property notification before
reporting readiness, with a bounded wait if the manager never publishes it.
An isolated X11 desktop with capture, input and a live window manager
reports available; accessibility remains false
until observation is implemented. A console without an observer is partial.
Availability does not bypass private-focus admission: capture-anchored input
requires a known non-secure focused target; unavailable focus queries fail closed.
A console's missing accessibility bus reports `no_atspi_bus`; an answering bus
without an observer reports `observer_unavailable`. A live capture backend with
unavailable input reports `input_backend_unavailable`, including on an isolated
display. D-Bus connect, authentication
and both bus checks share one cancellable 500 ms deadline; Wayland connection
probing is bounded by the same deadline mechanism. A missing window manager
adds `window_manager_missing`; a missing Xvfb binary refuses startup with
`display_unavailable`. A macOS screen reports its console user, capture and
Accessibility grants, and sleep state; it never reports isolation. Its input
source remains offered before the Accessibility grant and checks the live
grant before each injection, so later permission changes update the verdict
without restarting the client.
The Linux client test opens a real Xvfb server, captures both root and
window PNG pixels and input through public wire handlers, and checks the
isolated partial verdict when its manager is absent; the
Rust CI lane installs Xvfb and openbox for that test.
AT-SPI observation, nested Wayland, and Windows are tracked in #1700.
Grant-dependent live acceptance remains in #1702.

## #1697 computer-use leases (PR pending)

The app now refuses suspected same-machine `computer_request` answers at the authenticated request-answer port, records their ingress refusal without settling the request, and broadcasts a typed `lease` frame on every revision (#1726 and the wire half of #1701; desktop rendering remains open).

The #1734 budget row on each lease defaults to 1500 actions per hour and
is capped by `computer_use.enrollmentCeiling` keyed by machine id (default
1500). The existing `tool.pre` guard counts admitted `machine.input.*`
attempts in a sliding hour; a transport refusal after admission still
counts. `machine.screen.*` does not count. The revisioned lease row retains
admission times, and `computer_list` exposes `usage.count` and
`usage.resetAt` on each session lease. An exhausted budget refuses with
`budget_exhausted { resetAt }`; desktop rendering remains #1701.

The approval-policy bundle owns revisioned `Machine.ComputerLease` and
`Machine.ComputerExclusion` rows. `Core.LedgerHost.policyState.get/list/put`
persists them in the existing catalog; `put` compares the prior revision
and advances it atomically. Catalog version 6 adds this generic bundle-data
table, with no computer vocabulary or new storage path in the core.
`computer_request`, `computer_list`, `computer_end`, `computer_exclude`,
and `computer_keep` are provision operations. Requests and exclusion
changes use the existing Owner approval path; a request's saved lease
revision is checked again before granting its 5-120 minute scope.

The bundle's compiled `tool.pre` rows cover pointer, key, text, ref action,
observe, settle, app launch/quit, and window close/park. The host attaches
its latest window binding from list, observe, launch, and capture answers.
The app alone refuses `lease_missing`, `lease_expired`, `target_unbound`,
`app_out_of_scope`, `foreground_not_granted`, `excluded`, and
`paused:human_input|takeover|private|locked|asleep`. Exclusion identities
are data in `policy/computer-exclusions.json` plus the configured client
path and Owner-added rows. Unknown application identities fail closed.
Enrollment and native target/ref/reservation/privacy checks remain in the
host and client.

Human-input and entered-private facts pause rows before event publication.
Locked/asleep reports also pause leases; the capture guard reads current
session facts directly. A later turn must make a full observe before
resuming, and a private observation cannot resume. Stop ends the lease,
cancels the attachment's computer relay and sends `machine.computer.close`
with the attachment generation and an input-sequence barrier. The client's
dispatch ledger fences both active and delayed inputs through that sequence
before their next native event, leaving later calls and other machine work
attached. Failure to acknowledge cancellation disconnects the peer as a
fail-closed boundary. Captured cancellation records the complete
`unverifiable {reason:"cancelled",dispatched:"unknown",hint:"re_observe"}`
result. An injected scheduler ends a lease after 120 seconds without an
attachment; attachment resets that deadline.

Launch-returned windows are attributed to the session and turn. Turn-end
cleanup closes unkept windows with their recorded epoch, retains
`deliverable` and `handoff` targets, and journals every retained or
unclosed target in a `computer.cleanup` tool result. Fixture evidence is in
`computer-policy.test.ts`, `computer-provision.test.ts`,
`computer-turn.test.ts`, and the machine host tests. Dedicated desktop
lease/purpose presentation remains #1701; native live-grant acceptance
remains #1702.

## #1693 human-input and session facts

The macOS client uses a listen-only session event tap to classify untagged
pointer and keyboard input. Its cfg-free detector discards client-tagged input,
counts the remaining events by source per heartbeat, and sends an immediate
`machine.event.human_input` notification when input follows more than two
seconds of quiet (at most one edge per 250 ms). The optional
`Report.humanInput` carries the last event time, source and count;
`Report.session` carries locked and asleep booleans. If Input Monitoring
prevents the tap, the heartbeat omits `humanInput` and includes
`screen.blockers` containing `input_monitoring_not_granted`. The host retains
these optional facts per attachment, exposes them in `machine_list`, and
publishes an authenticated `machine.human_input` bus event. It makes no
admission or lease decision from them. The #1697 approval-policy bundle
consumes these facts for lease pause transitions.
Linux clients omit the human-input fact; native Linux and Windows input
adapters are tracked in #1700. Live grant-dependent
acceptance is tracked in #1702.

## #1696 machine client release pin

The client release workflow builds Linux x86_64, Linux arm64 and signed macOS
universal archives, publishes SHA-256 sidecars and a versioned `release.json`,
and the npm staging command requires and embeds that record at
`dist/clients/release.json`. The host serves the same record over HTTP and the
pre-attachment `machine.release` IPC call. `mclient join` stages and probes
the host release before installing its service, or adopts the running binary
behind `~/.oni/bin/current` with `pinned: false` if no release is available.
`mclient update`
verifies archive bytes and SHA-256, probes the staged binary without
attachment or enrollment changes, retains the previous symlink target, and
atomically switches `current` before restarting the service. Typed failures
are written to `metrics.jsonl`; a refused restart restores the previous link
and pin. `run` checks the persisted pin unless
`--allow-unpinned` is passed. An active or rollback version cannot be
restaged in place. Fixture tests cover refusals and symlink preservation;
live MacBook grant retention and PVE bootstrap remain unverified (#1702).
The host-self supervisor deployment and update recipe belongs to #1699.

## #1699 drain-restart deploy (PR pending)

The service unit now runs `oni supervise` (`ExecReload=… deploy --reload` on
systemd), which spawns `oni start` from `~/.oni/current` and takes `deploy` and
`reload` lines on `~/.oni/supervise.sock` (contract in
`docs/machines-and-delegation.md` §2.8). The host serves authenticated
`GET /status` and `POST /drain` with a boot instance id; while draining,
messages that would create a session or wake an idle one refuse `draining` at
the router's prepare step, steering of a running turn passes, the drain waits
for every turn's terminal commit, and the desktop composer shows the
`draining` frame as a restart notice. `Core.openLedger` holds a file
catalog's `flock` owner lock (`OpenRefused` code `owner` for a second
opener; process-runner children inherit it as fd 3). `oni deploy <tgz>`
unpacks the tarball into `~/.oni/releases/`, runs `bun install --production`
there, and asks the supervisor to replace the host. Tests: drain gate and an
in-process host draining one held turn (`apps/oni/test/drain.test.ts`), every
deploy boundary, I/O fault and cancellation on real catalog/session files with
fake child and status ports (`apps/oni/test/deploy.test.ts`), `oni supervise`
driving fake host releases through deploy, rollback, shutdown and host exit
(`apps/oni/test/supervise.test.ts`), the desktop drain notice, the owner lock
(`packages/agent/test/core/session/owner-lock.test.ts`, `host.test.ts`). Not
yet exercised on a live host: a real `oni supervise` swapping two npm
releases.

## #1698 machine client reconnect classes

The client classifies attach failures and uses an upper-half jittered
2–300 s exponential retry schedule. Authentication and configuration
park with a 5 min re-probe; a wake, network change or `mclient retry`
interrupts the delay. An offered `ping` opts a peer into host-side 5 s
probes and 15 s detach; peers without it retain report-cadence liveness.
The client reconnects after 15 s without a host frame. `Report.transport`
and `machine_list.live.transport` carry the last class and attempt count;
`metrics.jsonl` records failure observations. The additive fields remain
on contract v2. Fixture tests and live sleep/WAN acceptance are distinct;
the latter is not established by this implementation.
## #1682 npm package host/client report compatibility

`apps/oni` rebuilds `@oni/protocol` before staging its npm bundle. Staging
against stale `packages/protocol/dist` previously embedded a strict host
`Machine.Report` schema without `screen` even when source and the Rust client
included the field. The host then rejected every new client heartbeat, leaving
the self machine waiting for its first report until the boot deadline. The
package smoke test now invokes the public `build:npm` command and boots its
staged bundle with the real client; Linux conformance now checks the v4
screen verdict and grants. At the #1682 deployment, `machine_list` showed
`self` live with the then-current screen permission `unsupported`.

## #1678 screen permission in machine reports (historical; superseded by #1694)

The #1678 clients included `screen.permission` (`granted`, `denied`, or `unsupported`)
on every heartbeat. The client probes `Source::ready()` without prompting or
listing displays: success reports granted, a permission refusal reports denied,
and no capture source on this client reports unsupported. A sleeping
display alone does not change the permission fact. Contract v2 also accepts
older reports without `screen`; the host keeps their `live` load and staleness
and omits `Info.live.screen` (unknown). With a screen fact, the host copies the
latest accepted value into `machine_list`. Upgrade hosts before clients:
an older strict host rejects the new report field. No viewer or stream metrics
surface is included.

## #1678 pending machine capability approval (Lane B)

The host still admits only enrollment ∩ offer. After successful attach
negotiation, capabilities the peer offers beyond the enrollment are written
to the catalog's `machine_capability_request` table before attachment is
published; a failed write refuses attachment. `machine_listed` includes
`pendingCapabilities` for every attached machine (empty when none is pending).
`provision machine_grant` and `machine_deny` use the existing Owner approval
decision and enrollment revision fence. A grant updates the enrollment's
allowlist and revision and clears its pending request in one transaction;
the new grant applies on the next attach or reconnect. Denial clears only
the pending request. `ONI_MACHINES_ENROLLED` seeds each machine id only once
on first boot; later capability changes use `machine_grant` or
`machine_add`, not environment edits.

## #1678 machine client join self-setup (Lane A)

`mclient join` prints the enrollment receipt before attempting service
installation and then prints config path, service status, full supported
capability list and Screen Recording instructions. The client offers
capabilities for present drivers on attach. A native screen
source (or a configured headless computer block) offers `screen.read` and
`computer.use` even before Screen Recording permission is granted, so the
host can show them as pending for Owner approval. An existing input driver
likewise offers `input.write`; serving capture and input still checks current
permission and refuses with `permission_denied` until granted. The optional
report fact above probes readiness independently of the offer.
After writing the enrollment receipt, join installs `ai.oni.machine` as a LaunchAgent
on macOS or `oni-machine-client.service` as a root/system or non-root/user
systemd unit on Linux. The installed job runs the current binary with
`run --config <client.json>`; rejoining an unchanged unit restarts it.
Rejoining retains the existing client certificate and private key so an
enrolled host continues to recognize the peer. An incomplete or mismatched
saved identity is refused before a receipt or service install; replacement
keys require an explicit Owner enrollment update.
`--no-service` skips installation, while `--service-dir` overrides the unit
directory without suppressing service activation. Linux user units follow
`XDG_CONFIG_HOME/systemd/user` when the variable is absolute, otherwise
`~/.config/systemd/user`; wire conformance joins use `--no-service`.
macOS `mclient run` requests
Screen Recording permission if preflight is false, attributing the prompt to
the launched client; join opens Settings unless `--no-open` is set and does
not claim to know the grant. Linux reports unsupported. No live join against
a deployed host was performed for this lane.

## #1671 durable delivery content and attachment transcript (PR #1672)

On `core/modality-content-contract` (2026-10-26, base `10225726e`).
`Delivery.Content` is a readonly ordered array of text and media parts in
`packages/protocol/src/ledger/l0.ts`; `Delivery.Row` and `Delivery.Commit`
carry that content rather than a string plus transient `Commit.parts`.
A prompt needs at least one part; actions and control signals may have none.
`Delivery.text` is the explicit plain-text reading, with `[kind: name]`
placeholders for media. Session files now stamp schema version 4, and the
pre-write `PRAGMA user_version` fence accepts only 0 or 4; foreign stamps
(including v3) refuse typed before DDL, with no migration
(`packages/agent/src/core/store/session-file/index.ts`). The #1637 and
#1634 version-3 accounts below describe their original landings, not the
current open contract.

The journal constructs ordered user text and file message parts from the
delivery; history replay reconstructs the same parts with deterministic
part IDs (`packages/agent/src/core/journal/message-factory.ts`,
`packages/agent/src/inspect/history.ts`). `packages/llm/src/message/parts.ts`
resolves file parts through the injected media byte port for a selected model,
using `Delivery.text` placeholders when the port is absent or a part is
unreadable or unaccepted. `apps/oni/src/composition/delivery-media.ts` now
binds the byte and derivation ports without retaining a parallel delivery
registry; process children request bytes and derivations by ref. Compaction
passes replayed file parts through the same model service and byte binding
(`apps/oni/src/bundles/compaction/summarizer.ts`,
`apps/oni/test/compaction-summarizer.test.ts`); the candidate fingerprint
includes file identity and metadata
(`packages/agent/src/plugins/compaction/candidate.ts`).

Review fixes on the same branch: `packages/llm/src/message/index.ts` renders
a user message's parts in sequence (text stays on its side of each file),
and a derivation that returns no parts and no text keeps the original
`Delivery.text` placeholder (`packages/llm/test/run-media.test.ts`). A
`prompt.pre` rewrite is accepted only when the rewritten row parses as a
`Delivery.Row`; a string or empty body is refused typed as `invalid_output`
and the original prompt is never delivered in its place
(`packages/agent/src/core/session/admission.ts`,
`packages/agent/test/session/admission-rewrite.test.ts`). The outbound
binding in `apps/oni/src/composition/message-session.ts` accepts only a
letter that is exactly one text part equal to the outbound text;
`Delivery.Commit.after`/`delivery` forwarding is tracked in #1673.

The outbound WebSocket `message` frame includes `parts` when media is present
(`apps/oni/src/index.ts`, `packages/channels/src/websocket.ts`); the desktop
transport emits file chunks and transcript nodes preserve attachment order
and show labelled attachment rows, including attachment-only prompts
(`apps/desktop/src/renderer/chat/gateway-transport.ts`,
`apps/desktop/src/renderer/chat/adapter.ts`,
`packages/ui/src/timeline/turns.ts`,
`packages/ui/src/timeline/attachment-row.tsx`). The row labels machine
references; it does not fetch media in the browser. Regression coverage
includes `packages/agent/test/store/session/media-replay.test.ts`,
`packages/agent/test/session/entity-typed-refusals.test.ts`,
`packages/llm/test/run-media.test.ts`,
`apps/oni/test/compaction-summarizer.test.ts`,
`apps/oni/test/ws-outbound-parts.test.ts` and
`packages/ui/test/timeline-attachments.test.tsx`. A live model or desktop
run is not established by these tests.

## #1669 machine client P6: Rust is the only machine peer (epic #1622)

The TypeScript machine peer and its ten modules are deleted:
`packages/machines/src/{daemon,computer-use,commands,exec,fs,pty,pty-registry,reconnect,pty-control,pty-decode}.ts`
(2,764 lines in the removal inventory). `packages/machines` retains host
attachment, admission, generation CAS, capacity, handle routing and IPC;
the Rust `mclient` owns the filesystem, exec, PTY, computer and Python
drivers. `packages/codemode` routes cells over
`machine.run_code/peek_code/cancel_code` to the attached client; its prelude
is `clients/machine-client/src/code/driver.py`. The self machine starts a
scoped `mclient` child rather than an in-process peer. TypeScript tests
attach the real binary via `packages/machines/test/helpers/mclient.ts`,
which CI builds per lane.

The client settings file has no capability filter: the host enrollment row
bounds what the machine may serve through `Machine.effectiveCapabilities`,
so a client-side allow-list would be a second enforcement layer. The optional
`tmuxSocket` client setting selects a private tmux server; without it the
client uses the default server. SIGTERM and SIGINT exit 0 after driver
detach and staged-transfer cleanup. Exec inherits the client's `PATH` and
clears the rest of its environment. A cell's `send_message` binds its
invocation executor at the Promise-to-Effect boundary in
`apps/oni/src/gateway.ts`. PTY-over-TCP has transport coverage but no
TypeScript end-to-end test: this phase's client settings do not carry a
test client identity.

The npm artifact remains platform-independent and does not contain
`mclient`; the service installs it beside `dist/app/` or sets
`ONI_MCLIENT_BIN`. The pack smoke test copies the built binary to that
location before booting. The Resident service command `oni daemon` is
separate from the machine client.

The #1675 follow-up tests malformed stream acknowledgements and out-of-order
signals on the Rust client, and checks fixture screen-capture pixels against
the encoded PNG without requiring screen permission. Machine-side prose uses
"machine client"; existing `Offer.daemon` wire names remain unchanged.

## #1692 unverifiable input and dispatch reservation (machine contract 3, PR pending)

On `feat/1692-unverifiable-input` (2026-10-29, base
`8065ecdb2`). Typed computer input carries host-minted request IDs;
`InputWriteResult` can answer `unverifiable` with a dispatch fact and a
re-observe hint, and `machine.input.status` reads the client process's
bounded dispatch ledger after reconnect. A cancelled terminal receipt carries
the delivered-event count. The host reserves overlapping window input until
a terminal answer, confirmed completion or acknowledged cutoff; unknown status
and post-send failure keep the reservation, without replay. The client fences
each native event and ref action against its attachment generation and
cancellation state. Active entries remain queryable even at ledger capacity;
an all-active ledger refuses a new request. Code mode exposes status
alongside pointer, key, text and action. Each new host advances the persisted
generation on a machine's first attach, preventing input ID reuse when the
host's sequence restarts; same-host reconnects keep the generation and sequence.
The schema export and headless
fixture tests cover the new wire shapes; native grant-dependent acceptance
remains #1702.

## #1690 background delivery and window lifecycle (machine contract 3, PR pending)

On `feat/1690-background-delivery` (2026-10-29, stacked base `a2a7d1092`).
The protocol adds default-background pointer/key/text delivery, optional
key/text window targets, capture refusal reasons, and launch/quit/close/park
methods. `clients/machine-client/src/input/delivery.rs` classifies whole
plans before dispatch; the macOS adapter posts tagged events to HID or one
PID, while Linux retains foreground XTEST. Failure and detach cleanup keep
the original input route.

`src/app/` implements bounded completion and PID window discovery, a
headless launcher, and asynchronous NSWorkspace launch without activation
or hiding. Window lifecycle reuses the #1689 epoch table and AX observer.
`src/screen/{blank,pool}.rs` adds blank-frame detection and same-window
capture supersession; window capture refuses minimized and excluded owners.
`computer.excludedOwners` accepts bundle IDs and paths.

The host and codemode expose `computer.app.launch/quit` and
`computer.window.close/park`, all through the captured operation port.
Headless conformance asserts PID-targeted recorder rows, background move
refusal, and lifecycle receipts. On macOS, background clicks and scrolls use
the observation window or captured-window PID, or hit-test the frontmost
layer-0 window beneath a display point; the successful result records the
resolved `{ pid, windowId, source }`. PID-bound pointers check the target's
focused secure field rather than unrelated overlapping windows; display-point
anchors keep the conservative overlap gate. Events post to that PID without
moving the shared cursor. Controls reading global pointer position may ignore
them despite an `ok` dispatch. Linux remains foreground-only. The macOS ignored
`native_occlusion` test builds a fixture with two overlapping windows and
verifies that the covered window's own pattern is captured.
Coordinate pointer calls can supply `at.within` as allowed PIDs or app
identities; a live hit-test before injection and before each button edge
refuses an unexpected overlay with `target_mismatch` and `landedOn`, while
successful coordinate calls report `landedOn` as the first injected target.
Excluded owners refuse regardless of the caller's expectation.

Grant-dependent acceptance remains #1702. Windows adapters and
ScreenCaptureKit remain #1700. Cleanup policy and keep records are described
under #1697 above.
Contract details: `docs/machines-and-delegation.md` 2.2.3.

## #1691 window settle (PR pending)

On `feat/1691-settle` (2026-10-29, stacked base `a2a7d1092`).
`Machine.ScreenSettleRequest|Result` and `WireMethod.ScreenSettle` add an
epoch-bound accessibility quiet-window wait with a 200 ms default quiet
period and a 5000 ms default deadline. Quiet time starts at observer
readiness, not request entry. Portable observer policy reconciles new
descendants, refuses incomplete registration coverage, excludes unrelated
windows and blocks unresolved attribution. Final samples are fenced by
notification revision before a settled commit; destruction tombstones the
target's epoch and snapshots. Setup uses the request deadline; final
sampling and teardown share a fixed 500 ms allowance inside the host's
`timeoutMs + 1000` transport ceiling. Native sampling holds no observation
store lock. Scripted clocks and notification tests exercise the same
coordinator without sleeps. Captured refusals carry bounded messages;
missing capabilities report `unsupported`, while absent attachments report
`machine_not_attached`. Code mode exposes `computer.screen.settle`.
Native grant-dependent behavior awaits the MacBook live acceptance.

## #1732 pixel-quiet window settle (PR pending)

Window settle falls back to consecutive, bounded pixel thumbnails when the
accessibility observer is unavailable but capture works. It samples every
200 ms; over 0.5% changed pixels outside an RGB tolerance of 8 resets the
quiet interval (500 ms by default; accessibility retains 200 ms). The first
identical pair settles with a fresh `captureId`; timeout returns a pixel
`pending` count, and a window lost during sampling returns `destroyed`.
The fallback refuses secure focus when it can be identified and otherwise
uses the window capture guard. Display settle remains deferred; scripted
clock and frame tests cover the timing without sleeps.

## #1695 private mode (PR pending)

On `feat/1695-private-mode` (2026-10-31, rebased on `1a6c4c923` after
#1689). Target contract: `docs/machines-and-delegation.md` 2.2.5.

**Wire and host.** `ScreenObserveResult` admits only an empty, complete
successful private observation; `ScreenCaptureResult` and
`InputWriteResult` add `private`, while `ScreenListResult` does not.
Every `StreamObservation` carries `private`. `machine.event.private` carries
the machine id, epoch-fenced window target and `entered|left`; the host
accepts it only from the attached matching machine and publishes
`Machine.Events.Private` with host receipt time. The generated schema and
valid/invalid fixtures cover each shape.

**Client.** `screen/private.rs` owns the cfg-free focus folds,
epoch-scoped transition state, 250 ms refresh cadence, rectangle intersection
and pixel blanking. A failed focus query is an accessibility fault, not a
private window: display capture keeps its unmasked pixels and reports
`accessibilityUnavailable`, input refuses `accessibility_unavailable`, and
the capability verdict marks accessibility unavailable until a successful
walk. An absent focused element is not private. Text and key input require a
known non-secure focus, with exactly one focused window for un-aimed input.
Observe resolves the window and epoch before returning an empty result for
secure focus that issues no refs; AX lookup faults refuse observation. Ref actions require an
issued ref and check the node's secure attribute or secure-text role;
ref-targeted pointers check the window's current private focus. Window capture
refuses before capture; capture-anchored input refuses before dispatch.
Display captures and streams blank only intersecting private window
rectangles, while private window streams blank the whole frame. Open streams
refresh focus every 250 ms and report their current private fact.

**Known limit.** A custom-painted password interface without a secure
accessibility role or attribute is not detectable here. The #1697 app
exclusion list is the complementary policy control. Native live-grant
behavior remains tracked by #1702; Windows and Linux accessibility adapters
remain #1700.

## #1689 window-bound observation and ref-targeted actions (machine contract 3, PR pending)

The #1715 observation follow-up reads `AXIdentifier` and sends optional `id`
(at most 256 characters). Sibling refs distinguish identifiers without
changing the role-path grammar; identified ref actions resolve the path
directly and use a bounded walk only when the identifier moved, refusing
ambiguous or absent matches with `ref_not_found`. Unidentified refs retain
the complete walk required to detect newly ambiguous siblings.

On `feat/1689-observation-model` (2026-10-29, base `712f621d4`). Target
contract: `docs/machines-and-delegation.md` 2.2.2.

**Wire.** `packages/protocol/src/machine/observe.ts` holds `WindowTarget`,
`AppIdentity`, `ObservedElement`, `ScreenObserveRequest|Result` and
`InputActionRequest`; `schema.ts` appends `WireMethod.ScreenObserve`
(`machine.screen.observe`), `WireMethod.InputAction`
(`machine.input.action`) and the `InputWriteResult` reasons
`window_not_found`, `epoch_changed`, `stale_observation`, `ref_not_found`,
`action_not_supported`, `observe_not_available`. `Machine.contractVersion`
is 3; the JSON Schema export and the valid/invalid fixtures cover every new
shape and refusal.

**Client.** `clients/machine-client/src/screen/ax/` (the bounded walk, ref
resolver and `Observer` trait; `fixture.rs` the headless observer;
`native.rs`, macOS only, AXUIElement reads and actions),
`src/screen/observe.rs` (epoch table, ref minting, diff, action
revalidation) and `src/input/action.rs`. `handlers.rs` serves both methods
under `computer.use`.

**Host and code mode.** `packages/machines/src/observe.ts` refuses
`observe_not_available` for a peer below contract 3; `ComputerHandle`
gains `observe` and `action`, both through the captured `tool.pre` port
(`captureInput` is now generic over `InputWriteResult |
ScreenObserveResult`). Code mode exposes `computer.screen.observe` and
`computer.input.action`. `script/conformance/computer/` drives a full
observe, an empty diff, a recorded press, `stale_observation` and
`epoch_changed` against the built client, then a ref-anchored click and
its `epoch_changed` refusal. `machine.input.pointer` now takes a nested
`at` (`{captureId, x, y}` or `{observationId, ref}`).

**Not shipped.** Windows mechanics and a live macOS run with
Accessibility granted.

## #1662 machine client P5: computer use on the client peer (epic #1622, PR pending)

On `feat/1662-machine-client-p5-computer-use` (2026-10-25, base
`325a8b7db`). The "not shipped: screen reading and input injection on the
client" line of the #1626 section below is superseded. Target contract:
`docs/machines-and-delegation.md` 2.2.1.

**Wire.** `packages/protocol/src/machine/schema.ts` adds
`WellKnownCapability.computerUse = "computer.use"`, eleven `WireMethod`
entries (`machine.screen.list|capture`, `machine.input.pointer|key|text`,
`machine.stream.open|signal|close`, `machine.cdp.open|chunk|close`), 23
roots with their bounds as exported constants (`SCREEN_LIST_MAX_DISPLAYS`
16, `SCREEN_LIST_MAX_WINDOWS` 512, captures share `SCREEN_PNG_MAX_BYTES` 4 MiB,
`INPUT_SCROLL_MAX_DELTA` 10000, `STREAM_MAX_CONCURRENT` 4, `STREAM_MAX_FPS`
60, `STREAM_MAX_BITRATE_BPS` 50 Mb/s, `STREAM_FRAME_MAX_BYTES` 2 MiB,
`STREAM_KEYFRAME_MIN_MS`/`MAX_MS` 100 ms..60 s, `STREAM_MAX_LIFETIME_MS`
1 h, `STREAM_MAX_SIGNALS` 256, `STREAM_SDP_MAX_CHARS` 64 KiB,
`STREAM_CANDIDATE_MAX_CHARS` 1024, `STREAM_DATA_MAX_BYTES` 16383 and
`CDP_CHUNK_MAX_BYTES` 262143 decoded bytes, multiples of 3 so the base64
length bound admits exactly that many, `CDP_MAX_LIFETIME_MS` 1 h; a stream's
`maxDimension` is at least 2 because video frames need even sides) and an optional
`Report.streams`. `Machine.contractVersion` stays 2 and `contract.ts` is
untouched. `packages/protocol/src/ipc/index.ts` gains the eleven
`Ipc.Methods` entries. The export under `packages/protocol/schema/machine/`
is regenerated (96 files, `--check` current) with 54 new valid and 46 new
invalid fixtures, consumed by both `packages/protocol/test/machine-contract.test.ts`
and the Rust `decode_fixture!` list in `clients/protocol/tests/fixtures.rs`.
The legacy `machine.screen_read`/`machine.input_write` pair is unchanged and
still the only surface the Rust client and the
Python prelude call; `packages/codemode` hands the new surface on as
`getMachine(id).computer` (`screen.list|capture`, `input.pointer|key|text`,
`stream.open` then `signal`/`close`, `cdp.open` then `send`/`close`), each
call behind the handle's lease fence.

**Host.** `packages/machines/src/host.ts` exposes
`host.native.get(id).computer: ComputerHandle`: `list`/`capture` relay the
screen methods and parse the answers against the result schemas;
`pointer`/`key`/`text` go through the injected `captureInput(request,
forward)` port and the host forwards only inside `forward`, refusing
`permission_denied` without a port and rechecking attachment, generation
and grant at forward time (`permission_denied`, `stale_generation`,
`disconnected`); `stream.open` mints the relay id and bounds concurrency
(`stream_limit`), signals per stream (`signal_limit`) and lifetime
(`stream_expired`), with `invalid_sequence`/`stream_not_found` on peer
records and `invalid_response` on a forged id; `cdp.open` is an opaque
`{channelId, send, close}`. The grant needs enrollment ∩ offer plus an
available display; no grant answers `permission_denied` (`cdp_not_available`
for cdp), no display or capability answers `*_not_available`. Detach or
disconnect ends open relays `detached`; a grant that withdraws
`computer.use` retires every open stream and channel `revoked` in both
directions (the peer is sent `requested` closes, later records refuse
`stream_not_found`). Every input call is captured as `tool.pre` before
it is answered, including ones the host then refuses while detached,
stale or ungranted. `apps/oni/src/index.ts` passes a
`captureInput` that runs `executor.run({kind: "tool", op, ...})` so
`tool.pre` captures the effect; outside an invocation it refuses
`permission_denied` and forwards nothing, and a compiled `pre` deny row on
`machine.input.text` is tested to forward 0 and refuse `blocked_pre`.
Binding this port to the agent's permission surface in the app is tracked
as #1665.

**Client.** `clients/machine-client/src/screen/` (`Source` port, 2-slot
frame pool that refuses `capture_failed` when saturated and frees on
detach or shed, crop plus
box-filter downscale and PNG/JPEG re-encode until the byte cap holds,
`fixture.rs` headless adapter, `native.rs` macOS-only over xcap with a
`CGPreflightScreenCaptureAccess` preflight), `input/` (vendor-neutral
`Driver`/`Event`/`Key` vocabulary, `native.rs` over enigo with
`AXIsProcessTrusted` and never a prompt, `recorder.rs` JSONL driver,
whole-plan validation under the driver lock, pressed keys released on a
mid-plan fault, keys and buttons a request leaves down held across
requests and released in reverse on detach and on a withdrawn
`computer.use`, `spawn_blocking` panic isolation), `stream/` (str0m sans-I/O
SRTP driven on the caller's clock over one UDP socket, a viewer's mDNS
`.local` candidate skipped and the viewer learned peer-reflexively, only
the last accepted signal seq replayed and a refused one resendable
corrected, a stream awaiting its offer ack metered at its frame and session
bytes, openh264 H.264
Annex-B from the frame pool, bitrate halved and the frame dropped on a full
send buffer, `expired`/`failed`/detach teardown, `StreamTotals` in
`metrics.jsonl` and at most 4 `machine.report.streams`), `cdp/`
(`chromium.rs` is the one browser-aware module: `/json/version` discovery,
loopback-only endpoint selection, manifest-only launch waiting for the
`DevTools listening on` line; `tunnel.rs` does the GET, the WebSocket
upgrade with a computed accept key and the 262143-byte chunking;
`manifest.rs` reads `cdp.json`, and an absent manifest refuses
`cdp_not_available`) and `computer.rs` (an
optional `computer: {layout, recorder}` block in `client.json` selects the
fixture backends; absent keeps the platform ones; `computer_layout_missing`,
`computer_layout_invalid`, `computer_config_invalid` exit 2). `handlers.rs`
adds `screen.read` and `computer.use` to `SUPPORTED`, offers them only with
an available screen (`input.write` and `computer.use` input also need a
permitted driver), and routes the new methods as appended match arms behind
the attachment-then-capability gate. Linux has a native input backend
(`Input::platform()`, absent without a display server) but no native screen
backend; the fixture adapters drive the same bounds, encode and pool paths.

**Conformance.** `script/check-clients-conformance.ts` keeps receipts 1-10
and appends a `computerUse()` stage (`script/conformance/computer/`) that
restarts the built `mclient` with a fixture `computer` block, a report tap
and a recorder path: receipts 11-21 cover the offered caps, display and
window listing, PNG/JPEG/downscaled captures with IHDR and digest checks
and `display_not_found`, eight recorded input events captured as `tool.pre`
`machine.input.*` ops, the `permission_denied`/revoked/`stale_capture`
refusals, a `Bun.WebView` viewer that negotiates H.264 (1 client and 1
viewer ICE candidate) and receives 30 encoded frames with 7 keyframes,
`machine.report` stream observations matching `metrics.jsonl`, a fake
DevTools endpoint echoing 263,143 opaque bytes in two bounded chunks with
an oversize chunk refused and `manifest_not_found`, `stream_limit` and
`channel_limit` on the fifth open, and detach releasing 8 relays with a
clean reconnect. Every step subscribes to its exact event first; there are
no sleeps. Receipts 16-17 depend on WebView WebRTC and were verified on
macOS WebKit only; Linux CI support for them is unverified.

**Verification (final tree after the review fixes; node reports under the
campaign's `waves/mc-p5/`).** On macOS `cargo llvm-cov --workspace --tests
--locked --fail-under-lines 100 --ignore-filename-regex
'screen/native\.rs|input/native\.rs'` exits 0 at 100.00% lines (6914/6914);
the two excluded files are the native backends a headless run cannot drive.
An earlier n5 run of the unexcluded command in a `rust:1.98` Linux container
exited 0 (6798/6798); it was not repeated on the final tree. `clients:lint`
(fmt plus clippy `-D warnings -D clippy::unwrap_used`) exits 0; `cargo test
--workspace --locked` 257 passed; `bun run clients:conformance` prints
`clients conformance: 21 checks passed`; `packages/protocol` 1050 pass,
`packages/machines` 358 pass with 1 skip (`host.ts` 100% lines, 99.53%
functions), `packages/codemode` 61 pass with 1 failure, the host-only
`browser.test.ts` that needs playwright; `check-types`, `lint`,
`lint:docs`, `check-effect-boundaries`, `check-deps`, import cycles,
topology, dead exports and the schema generator `--check` exit 0.

**Not observed, outstanding.** No live macOS run: `screen/native.rs` and
`input/native.rs` have not been exercised against a real display with
Screen Recording and Accessibility granted to the `mclient` binary, no
real browser viewer has received a live stream, and no real browser has
been launched or tunnelled over CDP; every frame, event and byte in the
receipts above came from the fixture layout, the recorder and the fake
DevTools endpoint. Also not shipped: the migration of the legacy
`screen_read`/`input_write` callers onto `ComputerHandle`; a typed wire reason for frame-pool saturation (it surfaces as
`capture_failed` "frame pool saturated"); a Linux native screen backend; `apps/oni/test/machine-input-capture.test.ts` runs only when
paired with `test/app-surface.test.ts` because of the pre-existing #1644
macro load-order failure (`roleText is not defined`, reproducible on main);
the terminal receipts still run over the default tmux server, whose socket
ownership is #1666; `packages/protocol/AGENTS.md` still quotes the pre-P5
fixture counts.

## #1629 machine client P4: agent sessions, cursor sync, the permission bridge and `@oni/sync` (epic #1622, PR pending)

On `feat/1629-machine-client-p4-session-sync` (2026-10-25, base `325a8b7db`
after #1626). The "session sync, project sync" line in the #1626 "Not
shipped" paragraph below is superseded by this section. Everything here is
evidenced by node reports under the campaign's `waves/mc-p4/` and the gate
runs they record; a live run against an installed CLI on the fleet was not
part of it.

**Wire contract.** `packages/protocol/src/machine/schema.ts` adds strict
`agent.session.list|open|tail|send|stop` request/result pairs and the
machine-to-host `agent.session.permission` request with its typed
allow/deny/timeout decision, all registered in `Ipc.Methods`. Transcript
records are disjoint variants for turns, tool calls, tool results, `corrupt`
source lines (`invalid_encoding`, `invalid_shape`, `unsupported_record`) and
`truncated` source lines carrying `originalBytes`; text, record counts,
session counts, ids and offsets are bounded. A tail continuation carries only
the server-minted cursor `{sessionId, generation, byteOffset, recordHash}`,
so a request cannot name a second, conflicting session; a stale or
mismatched cursor is the typed `invalid_cursor` refusal. The IPC envelope
stays `v: 2` and `Machine.contractVersion` stays 2: the methods are
additive. The export is 88 schemas, 15 new roots each with valid and invalid
fixtures (the invalid set includes an over-page `AgentSessionTailResult`,
zero-byte and unknown-reason records, negative-offset and generation-zero
cursors, an open result whose cursor lacks its hash and a late-reason
decision), refused by both Zod and `oni_protocol::decode`. One limit: the
JSON Schema generator drops custom path refinements, so the Rust boundary
does not by itself reject a relative or traversing project path; the
machine side confines the path.

**Host.** `packages/machines/src/host.ts` routes the five methods through one
`agentCall` helper on the current attachment. Every session operation is
gated by the `agent.session` effective capability and `peer.kind ===
"client"`; `open` and `tail` compare the cursor's generation with the
host-minted one before and after the call. Machine-originated permission
requests go to the injected `decideAgentPermission(machineId, request)`
port; the host denies when the grant is missing, the peer is a daemon, the
port is absent, the request id is already in flight, the verdict is invalid
or names another request, the port fails, or the 30,000 ms default deadline
expires (`timeout`). Disconnect or supersession resolves every pending
decision as denied, and a late answer has no waiter to satisfy. No policy is
evaluated inside `packages/machines`; the app must bind its captured
`tool.pre` decision to the port, and without it the host denies (the app
binding is not wired yet: #1665). The
capability has no `WellKnownCapability` member yet; the spelling is the
string `agent.session`.

**Client: dialects and launchers.** `clients/machine-client/src/agent/`
holds the only files that name a CLI: `claude.rs`, `codex.rs`, `pi.rs`,
`omp.rs`, the data table `manifest.rs` and the `pub mod` lines of `mod.rs`.
Each parser is pure over `&[u8]` and yields generated `AgentTranscriptRecord`
variants with source byte ranges; a complete malformed line is `corrupt`, an
incomplete final line is `truncated` with its byte count, and known
non-transcript metadata is skipped. Supported layouts, as pinned by the
retained fixtures: `claude-code` under
`~/.claude/projects/<project path with non-alphanumerics as '-'>/<id>.jsonl`;
`codex` under `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`, owned only
when line 1 is `session_meta` with `payload.cwd` equal to the project; `pi`
under `~/.pi/agent/sessions/--<encoded cwd>--/<timestamp>_<id>.jsonl` (v3
header, nested tool calls, tool-result messages); `omp` under
`~/.omp/agent/sessions/<encoded cwd>/<timestamp>_<id>.jsonl` with a 256-byte
title slot before the v3 header (its parser is pinned to the published
format, since no local `omp` transcript existed to copy). `launcher.rs` is
vendor-free: `start` reclaims a registry terminal that is observed live,
adopts the transcript of a requested id, or launches one named tmux terminal
per session (`agent-<hex nanos>-<n>`, cwd = project, shell-quoted `exec env
K=V cli args`) and then scans the layout directory up to four levels deep
for a new, unowned `.jsonl`, driven by terminal output until the 30 s ready
deadline; a missed deadline stops the process and answers
`session_not_available`. `attach` never launches; `send` (text plus `\r`)
and `stop` (SIGTERM, SIGKILL after the 5 s grace, then close) refuse
`NotOwned` unless the session is owned. `registry.rs` persists
`~/.oni/machine-client/agent-sessions.json` under a lock file with temp-file
rename; the saved terminal is a reclaim hint, never proof of life; projects
are canonicalized and confined to the exports. `claude-code` gets an assigned
UUID; `codex`, `pi` and `omp` ids are discovered from the transcript name.

**Client: routes and the cursor.** `handlers.rs` gains
`Service::open_with_agents`, which offers `agent.session` only when tmux
answered its probe and an export exists; `Service::open` never offers it.
Gate order on every route: no grant answers `machine_not_attached`; a
capability outside offered ∩ granted, or a project outside the exports,
answers `session_not_available`; an unknown id answers `session_not_found`.
`list` caps at 256 sessions and sets `truncated`. `tail.rs` pages 32 records
or 256 KiB per read: `recordHash` is the SHA-256 of the session id, generation,
offset and complete prefix bytes, and the origin is offset 0 over empty input;
the generation is the grant's negotiated one. Receipts from `tests/agent_wire.rs`:
a tail from an acknowledged cursor after an append returns only the new
records; replaying the same cursor over an unchanged source returns the same page, also under
two concurrent tails; a reconnect at the same generation resumes from the
old cursor with zero records, never from zero; a fresh generation refuses
the old cursor `invalid_cursor` and an explicit resync by `sessionId` starts
from the origin; a cursor from another session, a rewritten prefix or a file
shrunk below the offset are each `invalid_cursor`; an offset inside a line is
also refused. A complete line exceeding 4096 normalized characters emits a
typed `truncated` record rather than silently losing text. A malformed line advances
to the end of file, a partial trailing line leaves the cursor unchanged, a
line over 300 KiB becomes one `truncated` record and one line holding 40
tool calls becomes 31 records plus a `truncated` marker.

**Client: the permission bridge.** `HostRelay` sends
`agent.session.permission` over the attached connection and decodes the
decision; a call timeout is `timeout`, and no caller, a disconnect, a remote
error or an undecodable answer is `denied`. `Launcher::permission` relays
only for an owned session whose dialect is in hook mode, correlates the
session and request ids, and applies the outer deadline. The binary's one
new surface is `mclient hook permission --cli <claude-code|pi|omp>`: it reads
hook stdin (16 MiB cap), makes one round trip over the private socket
`~/.oni/machine-client/hook.sock` (mode 0600, one request per connection,
64 KiB request cap, 150 s deadline, served by `run_default` for the life of
the attach loop; a client run under a non-default config directory binds
`hook.sock` there, and every launch carries that path in
`ONI_MCLIENT_HOOK_SOCKET`, which the hook prefers over the default) and fails closed on every other path with exit 2, empty
stdout and an `oni: ...` line on stderr: no socket, timeout, a malformed,
empty or partial answer, an allow naming another request id, an unknown
CLI, `codex` (no hook; its native terminal prompt is the support limit),
unparseable hook input, or a host refusal. The `claude-code` launch passes a
settings file whose pre-tool hook runs the absolute `mclient` path in exec
form with `onFailure: "block"` and a 170 s hook timeout; `pi` and `omp` load
one shared embedded module (`agent/permission.ts`, written by private temp
file plus atomic rename, 0600, and replaced whenever the file on disk differs
from the shipped bytes; a differing file that cannot be replaced refuses the
launch with `LaunchError::HookUnavailable`) with `ONI_MCLIENT` and
`ONI_MCLIENT_CLI` in their environment, and it blocks unless the child exits
0 within 190 s (`ONI_MCLIENT_HOOK_LIMIT_MS` can only shorten that). The
standalone `script/conformance/agent/permission.spec.ts` (run by the Clients
Rust CI job) and the conformance stage load those exact bytes and pass only
an explicit allow; deny, a nonzero exit, a signal death, a timeout, unread
stdin, a missing program or selector, a spawn failure and malformed context
or input all block.

**Client: ownership.** A launch keeps its process handle in a pending set
from spawn until the session is registered and owned, so a request dropped
mid-readiness (transport loss cancels it) leaves a process the next `open`
stops. An in-memory owned terminal is re-observed before it is returned; a
process that exited or was closed elsewhere is released and persisted
without its terminal, and `list` reports `running` only for a session the
client owns now. One session id belongs to one project and CLI: the registry
refuses a second observation under another owner.

**`packages/sync` (`@oni/sync`).** A new protocol-only workspace (topology,
knip, tsconfig) plus the two lead edits that admit it: `workspaces: 10` in
`script/core-end-state-targets.ts` and the generated `Test (sync)` step
inside the `topology:test-steps` block of `.github/workflows/ci.yml`. `checkpoints.ts`: `syncPath` (canonical
relative manifest key, refusing empty, absolute, `.`/`..`, backslash, NUL and
over 4096), `commitCheckpoint` and `replayCheckpoints`, whose id is
`canonicalDigest({projectId, sequence, parent, changes})` so equal content in
two projects never shares an id and any foreign project, broken parent,
wrong sequence, forged id or tampered change is `checkpoint_broken`.
`bundles.ts`: `blobDigest`, the `BlobSource`/`BundleSource` ports,
`MemoryBundleStore` with `maxEntries`/`maxBytes` (`limit_exceeded`) and
`fetchBundle`, which trusts nothing from the source and re-checks identity,
bounds, declared totals, per-entry path, digest and size, duplicates and
every blob hash. `vfs.ts`: `createSyncVfs(manifest, blobs)` returns a frozen
`{list, read, stat}` over manifest keys only (no filesystem, copies out,
digest verified on read; `corrupt` or `path_rejected`). Export-root
confinement for real paths stays in `machines/src/contained.ts`; sync adds
no second fs policy. The app binds `BundleSource`; nothing in `apps/oni`
consumes the package yet.

**Conformance.** `script/check-clients-conformance.ts` now runs the
unchanged P3 stage (10 checks) and then `script/conformance/agent/sessions.ts`
(8 checks, the first driving the shipped permission module) on its own fixture, host and private tmux server (`TMUX_TMPDIR`,
killed at teardown), with the fixture root at `/tmp` because a hook socket
under `os.tmpdir()` exceeds `sun_path` on macOS. The P4 stage joins with
`agent.session` in the enrollment; streams a recorded `claude-code`
transcript in source order with a stable cursor (byte 423, identical page on
re-read, unmoved when nothing is appended); turns three damaged lines into
the three `corrupt` reasons and a 307,201-byte line into one `truncated`
record; exports the transcript into a `MemoryBundleStore` bundle plus a
`commitCheckpoint`; SIGKILLs the client, deletes `~/.claude` and the
registry, imports through `fetchBundle` and `replayCheckpoints`, re-attaches
at the same generation and resumes the same session id from byte 307,655,
refusing a forged hash `invalid_cursor` and a generation+1 cursor
`stale_generation`; serves a read-only sync view whose tampered blob, forked
parent, foreign project and `../escape` are `corrupt`, `checkpoint_broken`,
`checkpoint_broken` and `path_rejected`; and drives the permission bridge
through a fake CLI executable standing in for `claude-code`: an explicit host
grant is hook exit 0, a 250 ms host deadline is exit 2 with empty stdout,
and a late `allowed` found no waiter.

**Enrollment.** `handlers::SUPPORTED` lists `agent.session` with the four
P3 capabilities, so `mclient join` writes it into the enrollment receipt and
a later attach can offer it only when tmux and an export are present;
without them `available()` drops it from the offer.

**Not yet.** The client's terminals still share the user's default tmux
server (follow-up: the client should own its socket). Transcript discovery
re-scans on terminal output or at the 30 s ready deadline, so a CLI that
stays silent until its first prompt takes up to 30 s to discover, and a
`claude-code` session that writes its transcript only after the first prompt
answers `session_not_available` at that deadline when started without
input. An existing hook module file is accepted by path without comparing
its bytes to the embedded copy. The `pi` and `omp` hook modules are
installed and probed but not yet exercised inside a live `pi` or `omp`
process (no `omp` install exists on the verifying machine), and `codex` is
served without a permission hook. `MemoryBundleStore.publish` hashes each
file twice.

**Receipts (lead-verified node reports, 2026-10-25).** Rust: `bun run
clients:lint` (fmt and clippy `-D warnings -D clippy::unwrap_used`) exit 0;
`cargo llvm-cov --workspace --tests --locked --fail-under-lines 100` exit 0
at 5707/5707 lines; `cargo test -p oni-machine-client --locked` 14 test
binaries, 0 failures (11 parser, 17 session, 5 wire and the hook suite);
`oni-protocol` decode 2/2 and fixtures 5/5. TypeScript: `check-types`,
`lint`, `check-effect-boundaries`, `check-deps`, `check-import-cycles` (645
modules, 0 cycles), `check-dead-exports` ("none new"), `check-topology` and
`lint:docs` all exit 0 after the lead's two topology edits;
`machine-contract.test.ts` 310 pass; `packages/machines` 349 pass with
`host.ts` at 100% lines; `packages/sync` 23 pass with every `src/*` file at
100% lines and functions; `bun run clients:conformance` exit 0 with
`clients conformance: 10 checks passed` and `agent session conformance: 7
checks passed`, `check-clients-conformance.ts` 379/379 and
`conformance/agent/sessions.ts` 322/322 lines.

## #1626 machine client P3: transport, attach and the daemon-parity drivers (epic #1622, PR pending)

On `feat/1626-machine-client-p3-transport` (2026-10-25, base `690f14487`).
`mclient` is now a working client peer. The #1623 paragraph below (CLI
skeleton, `join`/`run` exit 2) is superseded by this section; the contract export and
`clients/protocol` are unchanged except for the regenerated
`create: "exclusive"` shapes that main already carried.

`clients/machine-client/src/transport/` owns the wire: LF-terminated JSON
frames capped at 16 MiB (`framing.rs`), v2 envelope classification that
keeps the original response fields (`envelope.rs`), monotonic `c<n>` call
ids with a 30 s timeout and pending-call cleanup (`request_table.rs`), one
256-slot writer plus a 16-running/64-waiting inbound dispatcher that answers
the 81st blocked request with error 4001 and closes (`client.rs`), and unix
or mutual-TLS connections with a 5 s connect timeout and host SPKI SHA-256
pinning with handshake signature checks (`connection.rs`). `config.rs` owns
`join` parsing: host resolution (IP or dotted name as given; a bare name
through the tailnet status peer list, else `host_unresolved`; port default
7643), trust precedence `--host-pin` > `--host-cert` >
`~/.oni/tls/host-cert.pem` > `--trust-on-first-use` > `pin_required`,
export validation, the 0700 directory and 0600 files, and the ten-year
self-signed EC P-256 client identity. `attach.rs` owns the loop: the Offer
with `peer.kind = "client"` (the `generation` key omitted on a first
attach, never `null`), the saved generation in `state.json`, and a 5 s
heartbeat that appends `metrics.jsonl` and sends `machine.report`.
The reconnect policy is described in #1698 above. `budget.rs` and
`report.rs` own the RSS/load probes and the
over/under counters: shed and restrict on the first beat over budget
(`machine.exec` refused `exec_not_available`, `fs_stream` `begin` refused
`too_large`), lift after two beats under, exit 4 on the third consecutive
beat over.

`handlers.rs` is the dispatch: `SUPPORTED` is `fs.read`, `fs.write`,
`shell.exec`, `pty.session`; the attach offers the filesystem only with an
export, terminals only when `tmux` passed its probe, exec always. Granted
methods route to the drivers; a granted-but-unoffered method answers the
driver's refusal; `run_code`/`peek_code` answer `kernel_not_available`,
`screen_read` `screen_not_available`, `input_write` `input_not_available`,
`cancel_code` `{cancelled: false}` (the strict result schema has no
refusal), and host-served names are invalid methods. Detach drops the grant
and aborts every transfer; `Pressure::retained` reports
`{pty_bytes, transfers}` and `shed` aborts all transfers then releases the
largest terminal buffer with cursors kept valid. `fs/` (confine, op,
stream) mirrors the host driver: descriptor-pinned no-follow traversal with
bounded link expansion, 256 KiB read/write caps, 1000 list entries, 32 open
transfers, staged writes published after digest match, and exclusive create
(`O_EXCL`, no link following, `already_exists` for file, directory or
symlink, no-replace rename at `finish`; the host uses a hard link, and a
filesystem without no-replace rename answers `io_error`). `exec.rs` confines
cwd to a granted export, shares a 256 KiB output budget, and kills the
process group on timeout, cancel or drop. `pty/` runs one tmux control
client on the default server (control session `oni-pty-control`; the
shared server's socket ownership is #1666) with
attach-time replay, a 1 MiB live window per terminal, 256 KiB reads, a
1000-terminal cap and restart rediscovery.

`script/check-clients-conformance.ts` (root `bun run clients:conformance`,
run by the Clients CI job after `clients:test`, lcov uploaded for the
patch-coverage gate) drives a prebuilt `clients/target/debug/mclient`
against `createMachineHost` over a temporary unix socket through ten
checks: join receipt, first attach at generation 1 with `peer.kind` client,
fs parity plus `already_exists`, a 528,609-byte chunked stream with digest,
exec and `timed_out`, the terminal sequence over tmux, kill and re-admission
at the same generation, routing to the re-admitted connection, a synthetic
stale generation refused with exit 3, and an attach with tmux stripped from
`PATH` that offers no `pty.session` and refuses `pty_open`
`pty_not_available`. An absent binary fails the run instead of building.
`script/scripts-lanes.ts` gives the harness its own `clients-conformance`
lane owned by the Clients job, and `script/ci-plan.ts` selects that job for
the two script files.

Not shipped: code cells, screen reading and input injection on the client;
replay-cache bytes of open transfers in `metrics.jsonl` (measured by
`FsDriver::retained_bytes`, not yet wired through `Retained`); session
sync, project sync and any dialect-pack work (later phases of #1622). The
generated Rust type names follow the alphabetically first literal property
of a variant (adding `create` renamed `FsStreamRequestBeginMode` to
`FsStreamRequestExclusiveMode`), which the client absorbs but a later
generator fix should stabilize.

Receipts (node reports under the campaign's `waves/mc-p3/`, lead-verified
2026-10-22 to 2026-10-25): `cargo llvm-cov -p oni-machine-client` lines at
100.00% for every source file across the `attach`, `cli`, `transport`,
`fs`, `exec`, `pty` and `handlers` targets (attach 28, cli 7, transport 31,
fs 18, exec 10, pty 9, handlers 9 integration tests plus 52 library tests,
0 failures); `cargo clippy --all-targets -- -D warnings` and `cargo fmt
--check` clean; no `#[allow]`, `#[ignore]` or coverage exclusions.
Conformance: `clients conformance: 10 checks passed` with
`script/check-clients-conformance.ts` at 372/372 lines; `bun test` over
`script/ci-plan.test.ts`, `script/scripts-lanes.test.ts`, `script/ci.test.ts`
and `script/check-clients-conformance.test.ts` 116 pass / 0 fail once the
null-generation offer fix landed in `attach.rs`. A live host-to-client run
over TLS on the fleet was not part of these receipts.

## #1637 session-file migration removal (PR pending)

On `core/1637-legacy-migration-removal` (2026-10-24, base `7705b035e` after
#1636). No pre-v3 session file was ever operated, so the v2->v3 upgrade path
and the `legacy_fork_digest` table it left in every upgraded file are gone
from `packages/agent/src/core/store/session-file/index.ts`. Opening a file
stamped with a `PRAGMA user_version` other than 0 or
`SESSION_FILE_SCHEMA_VERSION` (3) is refused with the typed
`CatalogVersionRefused` before DDL runs and leaves the file byte-identical;
fresh files are stamped 3 inside the DDL transaction;
`readSessionFileSchemaVersion` only probes, and the open reads the version
through a readonly or `immutable=1` handle before the writable open, so a
refused checkpointed WAL file gains no `-wal`/`-shm` sidecars and a negative
stamp is refused typed rather than as a parse error. The v2 SQL fixture and the
migration tests are replaced by version-refusal tests (open and fork). In
`apps/oni` the core-policy point-to-kind/phase table is `ADDRESS_BY_POINT`
with `policyAddress`; it was never legacy. No wire or schema change.

## #1630 slop follow-up (epic #1630, PR #1636)

On `core/1630-slop-followup` (2026-10-24, base `76f91c63c` after #1635,
PR #1636). Behavior-preserving slop removal over the merged campaign diff,
net +118/-143: the gate's one-use verdict parser is inlined with the same
`invalid_verdict` fields, verdict precedence is a direct type compare,
`immutableVerdict` is the only freeze, and `ingress` leaves the default
compile kinds because stored compilation always adds it; the llm router
parses its `Row` schema once at construction and its tests assert the
`_tag` and structured fields of `ModelUnavailable` instead of English
text; the session-file migration inlines its v3 statements at the single
transactional loop and its comments state the real order (session commit,
then catalog indexing with compensation); `apps/oni` names the Core read projection
`SessionReadModel`/`readSession` at every site while the writable
test-kernel fixture keeps `openKernel`; `test/alarm-plane.test.ts` keeps one
`verbOf` fixture. Review r1 reverted one error-contract change (a failed
readonly fork-parent open still throws bun's `SQLiteError`) and restored the
`assertPolicyRows` input-preservation assertion. No contract, schema or wire
change.

## #1630 openLedger seam (epic #1630, PR #1635)

On `core/1630-openledger-seam` (2026-10-24, base `e6b917455` after #1634,
PR #1635). The Core ledger exposes
`session(id)` operations for creation, forks, configure, ingress execution and
decision transactions. Creation keeps the existing genesis/index write unit;
fork schema checks and `tools.add` authority now stay inside Core. The latter
retains the activation fence and revision CAS across policy consultation and
generation acquisition.

App consumers read through `ledger.read` and `Core.SessionReadModel`, which
exposes no commit or fence-adoption method. The CLI opens its readiness catalog
through `Core.readCatalog`, which owns the read-only handle and closes it after
the channels-owned readers finish. Core also owns the late-bound session ports
and the application session command port. Channel table ownership stays in
`packages/channels`; the app only attaches its adapters at composition.

The app has no SQLite import, raw session-store access, `kernel.commit`,
`catalog.indexSession`, or `materialize(...)` call. The dependency gate's two
former app write exceptions and deferred commit pin are zero. The inspection
helpers accept only the read capabilities they use. Router composition is
excluded from this change; the existing two-argument model service is retained.

## #1630 action hash chain removed, session schema v3 (epic #1630, PR #1634)

On `core/1630-ledger-hash-chain-removal` (2026-10-24, base `9fd758bcc` after #1631). Session files use schema version 3. Opening a supported older file retains the guarded alarm-strikes upgrade and removes action and decision row digests in the same immediate transaction as the version stamp. Historical fork ancestry pins, including copied configure rows, are converted from digests to the original parent action ids before digest columns are removed; upgraded parents retain a migration-only digest-to-id lookup for descendants that have not yet opened. Runtime ancestry and fork lookup use action ids only. Actions retain unique ids, session ordinals, payload columns, fenced commits and byte-equal replay comparison; decision facts remain first-writer-wins. Existing payload JSON outside converted fork pins is preserved. Compaction content digests, checkpoint-state validation and content-addressed tool outputs are unchanged. Evidence: packages/agent, protocol, channels and apps/oni (`--timeout 15000`) suites, check-types, lint, lint:tools and dead-exports exit 0 on the reviewed head; patch coverage against `origin/main` via `script/check-patch-coverage.ts`.

## #1630 policy gate fold: compile, evaluate, bind (epic #1630, PR #1632)

On `core/1630-gate-fold` (2026-10-24, base `9fd758bcc` after #1631). `packages/agent/src/core/gate/` holds exactly `compile.ts`, `evaluate.ts`, `bind.ts` and `types.ts`: compilation parses, checks and buckets rows per point in one pass and publishes every row, bucket and lookup map deeply frozen (review H1); one evaluator owns matching, guarded responses, rewrites, observations, emissions and replay by recorded `inputHash`; the binding owns pre/post admission, ordered asynchronous consultation, synchronous approval replay and captured loadout filtering. The five-stage pipeline files (`admit`, `compose`, `fold`, `match`, `migrate`, `points`, `project`, `registry`, `row-parse`) and the v3 converter with its mapping table are deleted. Stored turn/post rows for compaction or restore_context_projection no longer convert at boot: compile refuses them with `PolicyCompileError` code `policy_row_migration_required`, carrying the zero-based `rowIndex` and procedure id `policy-point-rows-v1`; #1633 is the Owner's run of that procedure on the live catalog before this lands in a deployment. Current `PolicyRow` kind/phase storage is unchanged. Evidence: packages/agent, apps/oni and packages/channels suites, check-types, lint, lint:tools, deps, cycles and dead-exports exit 0 on the reviewed head; patch coverage against `origin/main` via `script/check-patch-coverage.ts`.

## #1630 model-call resilience router (epic #1630, PR #1631)

On `core/1630-router-resilience` (#1630), configured `@oni/llm` routing selects ordered credential and model candidates within one call. HTTP status, body and headers outrank nested transport codes; reported usage proves context overflow before fallback. Selector circuits and credential re-probes release only their own half-open leases; failed probes reopen with exponential cooldown, shared blocked credentials retain their actual recovery deadlines, and the first accepted output establishes same-turn fallback affinity. Routed outcomes carry cumulative `billedUsage` across charged attempts separately from the final candidate's usage evidence; the core charges token budgets from the cumulative amount while measuring context from the final snapshot. Unconfigured calls retain their original single-attempt result shape. Router health and pins remain process-local, and the app's default binding does not configure chain rows.

Router rows are not yet composed in `apps/oni` (the openLedger seam lane wires provider rows into `makeLlmService`); with no rows the port behaves exactly as before #1631.

## #1624 machine host admission: contract v2 peers and the attach generation

On `feat/1624-machine-host-admission` (2026-10-22, base `5b4f2a253` after
#1625, PR pending). `Machine.contractVersion` is now `2` and the new
`Machine.supportedContractVersions` is `[2]` (a plain array, not a schema;
`packages/protocol/test/machine-contract.test.ts` pins it to
`[contractVersion]`). `Machine.Offer` gains a required `peer`
(`{ kind: "daemon" | "client", contractVersion: int >= 1 }`, strict) and an
optional `generation` (int >= 1); `AttachResult.attached` gains a required
`generation`; `AttachResult.refused.reason` gains `unsupported_contract` and
`stale_generation`; `Machine.Info` gains optional `generation` and `peer`; the
`machine.detached` reason enum is `connection_closed | host_closed |
enrollment_removed | enrollment_replaced | superseded_by_reattach |
superseded`; the host emits `superseded` while old events remain readable.
`Peer` and `AttachGeneration` are
schema-local building blocks in `packages/protocol/src/machine/schema.ts`,
not `Machine` namespace roots. The JSON Schema export was regenerated (still
73 files, `index.json` says `contractVersion: 2`) and the fixture set is now
156 valid and 103 invalid (new valid: `Offer.client-peer`,
`Offer.reconnect-generation`, `AttachResult.unsupported-contract`,
`AttachResult.stale-generation`, `EventDetached.superseded`,
`EventDetached.superseded-by-reattach`, `Info.generation-peer`; new invalid:
missing or unknown `peer`, zero `contractVersion`, zero `generation` on
Offer, AttachResult and Info, or missing `generation` on
AttachResult.attached). The #1623 paragraph below keeps its original `contractVersion = 1`
and 149/95 numbers as history. `clients/` needed no change; `cargo test`
passed on the regenerated schemas.

`packages/machines` owns the host half. `createMachineHost` now requires a
`generations: AttachGenerationStore` port (`src/generation-store.ts`:
`current(machineId)` and `compareAndSet(machineId, expected, next)`, both
Effects failing with `MachinesFailure`) and ships
`createMemoryGenerationStore()` plus `createFileGenerationStore({ path })`
(JSON record `machineId -> generation`, owner-pid lock directory at `<path>.lock`,
`<path>.tmp` then rename, mode 0600; a missing file reads as empty, an
invalid or unreadable one fails closed with operation `generation.read` or
`generation.compareAndSet`). Admission runs under a `Semaphore(1)` in the
order `machine_not_enrolled`, `peer_key_mismatch`, `unsupported_contract`
(against `supportedContractVersions`), `machine_mismatch`, then
`already_attached` for a generation-less offer on any live `neverSupersede`
id, including the same connection (refused before the store is touched), then the
generation: a reconnect must present exactly `current` or is refused
`stale_generation`; a fresh offer mints `current + 1` by CAS with one
re-read on a lost race. An accepted offer detaches the incumbent connection
and any earlier attachment on the same connection with reason `superseded`,
disconnects the displaced connection, and invalidates its leases with
`stale_generation` (every other detach invalidates with `disconnected`;
`lease_expired` comes only from the lease's own idle expiry or release;
`capacity.detach(machineId, reason)` and `MachineRefusalError` now carry
`status: "refused"` and the `stale_generation` reason). `MachineInfo` is
`Machine.Info & { generation: number; peer }` and `list()` fills both.

The Rust client's offer carries `peer: { kind: "client", contractVersion:
Machine.contractVersion }`, presents the accepted `generation` on later
attachments, and exits on a terminal `stale_generation` or
`unsupported_contract` refusal. The app (`apps/oni`) adds
`OniConfig.machineGenerationsPath` resolved by
`resolveMachineGenerationsPath` from `ONI_MACHINES_GENERATIONS` (default
`~/.oni/machines/generations.json`), and passes
`createFileGenerationStore({ path })` into `createMachineHost`.

Receipts (lead, 2026-10-22, worktree `openomni-wt/mc-p2`): machines suite
323 pass / 0 fail across 42 files before n8's review fixes, including
`test/generation-store.test.ts`, `test/host-admission.test.ts` and
`test/daemon-admission.test.ts`; coverage `generation-store.ts` 100%
lines, `host.ts` 100% lines, `capacity.ts` 100% lines; protocol 932 pass /
0 fail; `generate-machine-schema --check` current; root `lint`, `check-deps`
and `check-dead-exports` exit 0; `cargo test` in `clients/` all green. The
full app suite after the config/index change is the lead's merge gate, not
recorded here.

## #1623 machine client P1: the wire contract export and the `clients/` workspace

On `feat/1623-machine-client-p1-contract` (2026-10-21, base `941c680ad`).
The machine wire contract now exists outside TypeScript. `packages/protocol`
exports `Machine.contractVersion = 1`, and `script/generate-machine-schema.ts`
writes every `Machine.*` Zod value as one JSON Schema file under
`packages/protocol/schema/machine/` (72 schemas plus `index.json`, which
carries `contractVersion` and the sorted name-to-file list). Output is
deterministic: keys sorted, 2-space indent, stray files removed on write,
and `--check` refuses a stale, missing or extra file. Three fields that Zod
describes as plain values (`ToolCall.arguments` values,
`ToolCallResult.completed.value`, `ScreenReadResult.ok.accessibilityTree`)
are emitted as `{}`; refinements (absolute or relative path, uniqueness,
byte bounds) are dropped and the base type kept, as the script header
records. `packages/protocol/fixtures/machine/` holds 149 valid and 95
invalid fixtures; invalid fixtures cover structural violations and schema
bounds (numeric ranges, array length and non-null optional fields), and
`packages/protocol/test/machine-contract.test.ts` checks each
one against the Zod source.

The new `clients/` directory is a cargo workspace outside the Bun workspace,
with its own `Cargo.lock` tracked. `clients/protocol` (`oni-protocol`)
generates its Rust types in `build.rs` from `index.json`, one module per
schema file, and exposes `CONTRACT_VERSION`; its tests round-trip every
valid fixture and refuse every invalid one. `clients/machine-client`
(`oni-machine-client`) builds the `mclient` binary: `mclient --version`
prints `mclient 0.1.0 contract 1`; `join` and `run` are parsed and exit 2
with `not implemented in this phase`. Root `package.json` adds
`generate:machine-schema`, `clients:build`, `clients:lint` and
`clients:test`; `script/ci-plan.ts` emits a `clients` flag and
`.github/workflows/ci.yml` runs the Clients Rust job (fmt, clippy with
`-D warnings -D clippy::unwrap_used`, test, and a 100% native line-coverage
gate) on full runs and on PRs that touch `clients/`,
`packages/protocol/`, the generator or the workflow (see `docs/ci.md`).

Not shipped in this phase: attach, any transport to the daemon, session
sync, enrollment from the client, and every `mclient` subcommand beyond
`--version`. The generated Rust types are shapes only; `oni_protocol::decode`
validates every wire value against the embedded JSON Schema before the shape
decodes it, and it is the only entry clients use. Refinements that the schema
export drops are not enforced on the Rust side either. Present `null` and
empty collections survive the round-trip (`Option<Option<T>>`,
`Option<Vec<T>>` and `Option<HashMap<...>>` fields, with
`clients/protocol/src/presence.rs` distinguishing present null from absence).
JSON number schemas use `serde_json::Number`, retaining integer and float
representations for exact JSON equality. Every schema pattern is compiled
with `regress` at build time before the generated regex initialization is
allowed to use `unwrap()`.

The Rust suite exercises four CLI outcomes (no args, version, join and run),
both typed decoder error variants, every shared fixture and exact adjacent
large-integer equality. Final-tree verification is separate from the initial
generation receipts; the native coverage gate excludes `build.rs` and
generated `OUT_DIR` code.

## #1620 project rename: openomni -> oni

On `rename/oni` (2026-10-21, base `04af03379`). The product, the kernel app
and every workspace package carry the name `oni`: `apps/oni` (was
`apps/openomni`), `@oni/*` package names and imports, root package `oni`, the
published bundle `oni` with the `oni` binary (`bin/oni.js`), the CLI help,
the data directory `~/.oni`, the `ONI_*` environment family, launchd
`ai.oni.*`, systemd `oni.service`, the desktop IPC channel `oni:gateway`, the
protocol error brand `oni.protocol.namedError`, the `oni/<version>` and
`oni-server` user agents, the GitHub comment marker `oni-delivery:`, and the
benchmark history key `Oni Benchmarks` (the gh-pages `dev/bench/data.js`
entries key was renamed in place so the accepted reference survives). No
compatibility path reads the old names: a deployment moves its `~/.openomni`
directory to `~/.oni`, rewrites `OPENOMNI_*` keys to `ONI_*`, and reinstalls
the bundle under the new name. Frozen history keeps the old name on purpose:
`docs/agents-stamps.md`, the per-PR stamps under `docs/agents-stamps/`, and
`.omo/` plans and reports.

## #1512 cli: contact over the machine pty (epic #1508)

On `feat/1512-cli-contact-pty` (2026-10-17, base `0d88e4fa7` = the #1511
tip after its r1b fixes). `send_message(to: "cli:<id>")` reaches a child CLI agent in a tmux
pane on the declared machine. The address is a declared row, never a vendor
literal: `provision channel_add` with provider `cli` and settings
`{dialect, machine, cwd?}` lands `channel:cli:<id>` under Owner consent (a
machine is where the Resident's letters go), judged by the contact's own door
(`ProvisionPort.cli.declare`): the dialect must be a registered pack and the
machine the self machine or a live enrollment; the row carries no credential
and the channel profile mounts nothing for it (`CONTACT_ONLY_PROVIDERS`,
status `ready` with the contact detail). The hard-coded
`cli:claude-code|codex|omp` list is gone from `send-message`.
`apps/oni/src/bundles/child-activity/contact/`: `declaration.ts`
(row resolution, `cli-<id>` pane name), `rule.ts` (the idle/working/blocked
data rule over the turn's persisted receipts — hook `waiting` blocks, hook
`terminal` or the transcript's terminal is idle, any other hook phase is
working, a typed `screen` seam decides only without file evidence, and
`unknown` fails closed), `hook-script.ts` (the vendor-neutral POSIX spool
appender: `sh <script> <event>` with the payload on stdin appends one
`{seq, event, receivedAt, payload}` line under a `mkdir` lock with a
per-child counter file) and `runner.ts` (Effect-native: `host.place({
machineId })` is an exact placement whose lease `renewPtyWhile` holds the
pane; `pty.list` decides lookup-or-create — a pane this Resident did not
launch is never written to; a launch writes the hook script and the pack's
`liveConfig` under `<cwd>/.oni/<child>/`, installs a spool-only watch,
writes `exec <pack.launch argv>`, takes the transcript path from the first
live line through the pack's `locate`, and re-installs the watch with both
sources; one watch per turn, keyed by the send; submit is the pack's recipe,
text then a delayed Enter; a blocked previous turn refuses `agent_blocked`,
a running one `agent_busy`, no evidence `child_state_unknown`; no live
observation within `stallWindowMs` admits a `prompt_stalled` /
`launch_stalled` `child_diagnostic` through the reconciler's Deliver door
and retires the pane; the run resolves when the reconciler has admitted the
turn's terminal fact, through the observation bus's committed-action
notification, never a poll). The pack contract (#1527) gains `locate(line)
→ {transcriptPath?}` and `liveConfig({hookCommand}) → string`; claude-code
implements both (its live config wires SessionStart, UserPromptSubmit,
PreToolUse, PostToolUse, Stop and SessionEnd — not PermissionRequest, which a
logging-only hook would deny), and the conformance suite checks them. The
reply is one `prompt{origin: {kind: "contact", contact: "cli:<id>", replyTo:
<send key>}}` whose content is the pointer `{kind: "cli_turn", contact,
child, turn, phase: "terminal", facts}`, delivered through the entity's
Deliver door keyed `<send key>:reply`; a refusal is `not_sent`, a letter that
reached the pane and never ended is `unknown`. A `deadline_ms` arms the
existing `delegation.deadline` purpose with `contact: cli:<id>`; the cancel
door (`DelegationDeadlineDeps.cancel` now carries the contact) writes ETX to
the pane and the waiting send ends `landed`; the parent gets the existing
expiry prompt. `index.ts` composes `contacts.cli` and `contacts.reply` in
production; nothing runs until a cli row is declared, and app stop drops
every pane this Resident launched (watch, tmux session, lease).
Receipts: `apps/oni/test/cli-contact.test.ts` (declaration door under
consent, the rule table, the runner over a scripted host — launch, one
watch per turn, blocked/busy refusals, the stalled diagnostic, the
interrupt, cleanup) and `test/cli-contact-e2e.test.ts` (a booted Resident, a
  then-current attached machine peer on a private tmux socket, a FAKE child resolved as the
pack's command that fires the installed hook command and appends the pack's
fixture transcript; the sender's inbox prompt, the admitted rows through
`childActivity.state` and the session read page, and the pane gone on stop).
Not claimed: a live vendor child, multi-line letters (the recipe writes the
text verbatim), attach-by-observation to a pane the Resident did not launch,
and the screen fallback — the `screen` seam waits for #1603. Required on the
contact's machine: `pty.session`, `fs.read`, `fs.write`, `shell.exec`.

r1 (2026-10-18, PR #1611 review): once `pty.open` has succeeded, every
refusal before the run owns the pane — a refused live-config exec, a pack
without `launch`, a refused watch install, a refused launch-line write, a
bus without subscription — retires it (watch closed, tmux session closed,
lease released, registry dropped) before the typed refusal propagates, so
the next send launches fresh and no bare letter is ever typed into a shell
without a launch; the stall predicate measures NEW OBSERVATION for the turn
— a hook receipt with a sequence above the pre-submit maximum, or the
derived state leaving `unknown` — never `child_fact` growth, because the
vendor's start, submit and stop events share one `observed` fact per turn
(a text-only answer or a first tool call after the window is not a stall;
the e2e `[hang]` child acknowledges with `UserPromptSubmit` alone under a
deadline longer than the stall window, so the deadline path and the stall
path are provably distinct); the pack contract's `liveConfig` rule is
one-directional (hooks ⇒ defined, none ⇒ undefined, an `extension` pack may
opt in); `interrupt` refuses a turn that already ended with the typed
`turn_already_ended`, the cancel door maps it to `already_ended` and the
`delegation.deadline` wake then prompts nothing (`exhausted`), and the arm
is retired through the plane's `at: null` idiom on the terminal and on a
stall; the hook appender reopens a closed stdin on `/dev/null` before
reading the payload and records its holder pid in the `mkdir` lock,
breaking past the bound only a lock whose holder is gone; the spool's
export is resolved from the declared `cwd` against the attachment's
offered roots (new `MachineHost.exports(id)`), a cwd outside every export
is a typed refusal after placement and before any pane opens; a replayed
tool call with the same key joins the running turn or returns its settled
outcome without re-typing the letter; committed-action rescans page from
the last seen revision (`childRowsAfter`). Receipts: the r1 cases in
`apps/oni/test/cli-contact.test.ts` (pane rollback across three
refusals, the TestClock stall predicate, typed `turn_already_ended` with no
ETX, deadline retire on terminal and stall, replay of ended and running
keys, one full-history scan, the hook appender run under `/bin/sh` with a
closed stdin and live/dead/absent lock holders under a process watchdog,
export resolution and refusal), `test/delegation-policy.test.ts`
(`already_ended` → no prompt), `test/cli-contact-e2e.test.ts` (the retired
deadline chain after the terminal; the longer-than-stall deadline), and
`packages/machines/test/attach.test.ts` (`host.exports`). The
`kernel.commit` pin is re-measured at `index.ts:1444`. At the r1 tip the
complete `bun test apps/oni --timeout 15000` run, backgrounded under
the #1498 15-minute watchdog, was terminated by the watchdog after 25 test
files with 0 `(fail)` lines (its last file header `test/hooks-json.test.ts`,
a sibling lane's app suite running on the same machine when it ended) and
is not claimed green; the focused files above, run with the two
session-deadline receipts `test/message-terminal-boundaries.test.ts` and
`test/request-channel-e2e.test.ts` that CI's whole-directory app lane also
executes, passed 171/171 and carried the patch-coverage gate.

r2 (2026-10-18, PR #1611 r1 verification M2 + L8–L12): every cli child's
deadline rides its own alarm chain, `cliDeadlineChain(session, child)` =
`<session>:delegation.deadline:<child>`, named by the delegation-policy
bundle's `armDelegationDeadline` on the arm and on the `at: null` retire —
retiring child A's deadline never supersedes the occurrence armed for
child B in the same sender session; a `to.new` session child keeps the
#1258 session chain, where a second arm supersedes the first. The turn is
marked ended the moment its outcome is known and before any await that
follows (`settle` is first-wins): the deadline door answers
`turn_already_ended` while the arm's retire is still in flight, so a fire
landing in that window writes no ETX. A letter the machine client refuses after a
successful launch ends the turn (a refusal after the first write that
reached the pane carries `landed`), retires the arm and retires the pane
like a stall — the next send launches fresh instead of answering
`agent_busy` until app stop; a pane close refused during that retirement
never replaces the turn's outcome. What the runner retains is bounded by
the children it launched, not by sends or rows: one turn per child — the
latest — for the replay short-circuit and the deadline door (`retained()`
reports the count), and for that turn a summary of its persisted rows (its
source-free facts by key and the rule's fold `foldState` over its
receipts: the latest hook phase by sequence and the transcript terminal),
folded as pages arrive; rows of turns it does not retain, including other
children's in the same sender session, are read and dropped; the cursor
stays one per sender session. `MachineHost` reads ONE effective root set
(`effectiveRoots`: the offered exports the enrollment allows, normalized)
for both `location()` routing and `exports(id)`: an offered root the
enrollment does not allow is no routing candidate (a path beneath it
resolves through the allowed root containing it, where it used to be
forwarded to a client that refused it), and the listing drops a root two
allowed exports share because `location()` refuses it as ambiguous. The
hook appender's header documents the single-user assumption behind
`kill -0` (another uid's live holder would read as gone); no behaviour
change. Receipts: the r2 cases in `apps/oni/test/cli-contact.test.ts`
(two cli deadlines on one sender through `armDelegationDeadline` against a
chain model judged by `Core.alarmDisposition` — the first retire leaves
the second `run`, session children share their chain, two panes with one
ETX into the fired child's pane alone; an interrupt during a blocked
retire refused typed with no ETX; one retained turn across six sends, two
after a relaunch, stranger rows dropped, one scan from 0; a refused letter
retiring the pane and the next send launching fresh, `landed` on an Enter
refused after the text), `test/cli-contact-e2e.test.ts` (the per-child
chain retired, the session chain absent), `packages/machines/test/attach.test.ts`
(the listing versus routing: unallowed absent, shared root dropped and
refused, a path under the unallowed root routed through `work`) and
`packages/machines/test/fs-wire.test.ts` (a scripted daemon records the
export the host routed to: `docs` when `private` is offered but not
allowed, `private` when both are). The `kernel.commit` pin is re-measured
at `index.ts:1440`. The focused app files above plus the two
session-deadline receipts passed 117/117 across the twelve files with the patch-coverage gate
at 100%; the machines suite passed 283/283; the complete app suite is not
claimed here (#1498).

## #1511 child reconciler (epic #1508)

On `feat/1511-child-reconciler` (2026-10-17, base `3f763326a`, PR #1570).
The #1511 child-activity bundle consumes the #1527 dialect packs through
retained-byte spool/transcript cursors, admits source-free facts and
per-source receipts through entity Deliver, and exposes an
authority-ordered read model; the existing watch owner reads verified remote
locations through machine-client filesystem calls and the alarm cadence, with
fixture-backed machine-client/entity tests but no live external-child launch
claimed. r1 (2026-10-17, ruling amendment
https://github.com/INONONO66/oni/issues/1511#issuecomment-6233905889):
a transcript line re-read under a new file generation lands as a new
`child_receipt` beside the `generation_changed` diagnostic row, never an
`idempotency_conflict`; the dialect pack's `live` decoder is the one owner of
the per-child sequence gate and `spool.ts` consumes its typed `stale_seq`
refusal (`DialectDecodeError.detail.seq`) instead of re-parsing the line;
spool and transcript drain inside their own failure boundary, every failure
reaches the watch owner's failure port, `ready` rejects only when every
configured source failed on the first drain, and a refused spool read never
stops transcript admission for the same child; a Deliver whose reply was lost
refreshes the admitted rows before the retry, and the restored sequence and
replay matching belong to the child, not to one file or turn.

r1b (2026-10-17, PR #1570 review): `installChild` rolls the just-installed
source back through the watch owner's close path when the cadence arm is
refused, so a `not_live` refusal leaves no orphaned handle and no
`watch_conflict` for the next install; a size-0 anchor is no anchor and the
first non-empty generation is adopted without a `generation_changed` row;
the watch owner counts consecutive drains in which every configured source
failed and after three (`CHILD_FAILURE_LIMIT`) refuses the observation so
the wake retires the chain `exhausted`, with any progressing drain resetting
the count and an explicit install starting fresh; a Deliver-side
`idempotency_conflict` reply is retained as the conflict row (the r1c
paragraph below records why no separate map refresh follows it);
`currentState` is a total order (authority, position, larger generation
size, canonical generation text, later offset); child admission enters
Effect through the one injected
`WatchSenders` door (`deliver` and `admit`), keeping the #1423 single-entry
rule; the `off: ["child-activity"]` boot row and the fixture-derived
`toolUseId` assertion are in the receipts. At `49a4efa87` the complete
`bun test apps/oni --timeout 15000` run was terminated by the #1498
15-minute watchdog after 33 files with 0 failures and was not claimed green;
at the r1b tip the same command completed under the watchdog with 1066 pass,
0 fail across 144 files (73.5 s, exit 0), the only `(fail)` line in its
output being the inner sub-run `test/cleanup-oracle.test.ts` deliberately
spawns; the focused files named in the stamp remain the per-finding receipt.

r1c (2026-10-18, PR #1570 r1b verification follow-ups): the admitted-map
refresh after a Deliver-side `idempotency_conflict` reply was deleted
rather than tested, because its re-send is unreachable: within one adapter
the cursor advances past the bytes once `accept` returns, so the refused
key is re-derived only after a thrown Deliver, and that path already
refreshes the map from the journal; a new adapter rebuilds the map from the
journal at construction, `close()` joins the in-flight drain, and
`watch_conflict` admits one adapter per child, so no second writer can
place a row under the key between the two. The conflict receipt in
`test/child-source.test.ts` now reaches the Deliver-side reply through a
fake entity (a `child_conflict` row for the requested key beside a lost
reply on the next committed receipt) and asserts the retry re-derives the
same bytes against the refreshed journal without re-sending the refused
key or adding a second conflict row; deleting the surviving refresh fails
it. The empty-anchor receipt pins the adopted generation: every admitted
`child_receipt` (transcript ref or `spool_ref` diagnostic) carries the
first non-empty file's byte size and no `generation_changed` row exists.
The adapter stamps transcript reads strictly monotonic per child
(`max(clock(), last + 1)`, seeded from the child's persisted transcript
receipts), so two reads inside one clock millisecond across a generation
change can never tie in `currentState` and a shrinking rewrite wins over
the larger stale generation; the total comparator is unchanged. The
complete `bun test apps/oni --timeout 15000` run on `0d88e4fa7`
completed under the #1498 watchdog (1066 pass, 0 fail, 144 files); one
completion does not retire the #1498 record.

## #1527 worker dialect packs (epic #1508)

On `feat/1527-dialect-packs` (2026-10-17, base `8638019e8`, PR #1549).
`apps/oni/src/bundles/child-activity/dialects/pack.ts` is the pure
dialect-pack contract: a strict `Manifest` (id, supported `versions`
pattern, `commands`, screen markers for permission/idle/working, and the
`capabilities` a pack declares — `live` hooks/extension/none, `transcript`
jsonl/sqlite/none, `permission_decision`, `correlated_launch`), and a
`DialectPack` of four pure functions — `launch` (argv and env for a
correlated session), `live` (one hook spool line into one
`ChildLifecycleEvidence` with a `hook` ref whose `seq` is the monotonic
spool position; a `seq` at or below `lastSeq` refuses as `stale_seq`),
`transcript` (one JSONL record into one `ChildLifecycleEvidence` carrying
the caller's `TranscriptRef`; a tool call on the wrong voice refuses as
`unsupported`), and `submit` (a two-write text-then-enter recipe with an
enter delay, a stall window, and `refuseWhenWaiting`). Every refusal is the
typed `DialectDecodeError` (`live`/`transcript` ×
`malformed`/`stale_seq`/`unsupported`). `dialects/index.ts` holds the pack
list and `selectPack`, which matches on the command basename and the
manifest's version pattern; an unmatched command is observe-only. The
first pack is `dialects/claude-code/` (manifest, launch via `--session-id`
and `--settings`, hook events mapped onto the six phases, JSONL user and
assistant records joined to hook evidence on `toolUseId`). No reconciler
consumes the packs yet; integration follows #1511. Receipt:
`apps/oni/src/bundles/child-activity/dialects/conformance.test.ts`
(runs every registered pack over its captured screen, hook and JSONL
fixtures under `claude-code/test/`: selection by command and version,
typed refusals, phase coverage with repeated and descending `seq`
refused, live/transcript join on canonical identity, correlated launch and
the guarded submit recipe).

## #1509 transcript references and child lifecycle evidence (epic #1508)

On `feat/1509-transcript-ref` (2026-10-17, base `0600442cd`, PR #1548).
`packages/protocol/src/transcript/reference.ts` holds two strict schemas and
nothing else: `TranscriptRef` addresses bytes that live on an attached
machine (`machine`, `export`, `path`, a `size-and-prefix-hash` or `inode`
generation, a byte `range` and a `parser` dialect/version) and is distinct
from `ToolOutputRef.outputId`, the digest of bytes the ledger owns;
`ChildLifecycleEvidence` is one normalized reconciler fact (`child`, `turn`,
optional `toolUseId`, one of six phases, a `TranscriptRef` or a `hook`
reference whose `seq` is a non-negative integer — the monotonic spool
position #1527 assigns — and a required `diagnostics` array, empty rather
than absent, so one fact has one encoding). No fold reads through a
`TranscriptRef`; no consumer is wired yet. Receipt:
`packages/protocol/test/transcript-reference.test.ts` (round trips for both
generations, all phases and the hook arm; each refusal names the exact zod
issue path after its valid base is shown to parse).

## Audit C12 — an undeclared `off` name and a shared port key fail closed

On `audit/c12-manifest-off-fail-closed` (2026-10-17, base `c7d8edc0f`). Two
fail-open paths from the agent-core audit (2026-10-14) close in
`packages/agent`. `Manifest.define` (`src/core/ports/capability.ts`) now
refuses an `off` name that no capability or bundle declares with the typed
`DefineRefused` `{ code: "unknown", name: "manifest", detail: <name> }`,
so a misspelled `ONI_BUNDLES_OFF` entry fails the boot before any
listener instead of silently leaving the capability on; `cascadeOff`
(`src/core/composition/compose.ts`) seeds the disabled map straight from
`manifest.off` because every root is already declared. Compose also
rejects two capabilities that declare the same port key as `duplicate`
(`name` = the later capability, `detail` = `port <key>`) where the
`portOwner` map used to keep the later owner only. The compose rejection
set stays at six codes; `DefineRefused` grows from three codes to four.
Receipts: `packages/agent/test/capability-define.test.ts` (the refusal and
the declared-name pass), `packages/agent/test/compose-reject.test.ts`
(the port-key collision), `apps/oni/test/capability-off-boot.test.ts`
(the former "ignored" row now asserts the typed boot refusal with no model
call). The #1306 sentences below that describe compose ignoring undeclared
names record the pre-C12 behavior.

## #1600 Messaging readiness — the first live run (lane R4)

On `feat/1600-first-live-run` (2026-10-17, lane R4 of #1600, the last).
Nothing in the repository has ever spoken to a real platform: every
receipt below this section is a fake SDK listener or client. This lane
gives the Owner the two commands and the one runbook that first live run
needs, and nothing else. **`oni channel add <platform>`**
(`apps/oni/src/cli/channel.ts`) declares a bot instance — Slack,
Discord, Telegram, GitHub, a webhook target, an A2A peer — or Linear's
Owner instance over the Owner's socket with its grant block (`--tier`,
`--allow`, `--mention-only`; the Owner's consent by the call itself, lane
R1), the credential asked for at the prompt (a token or secret never
echoed, an optional field left blank not sent) and sealed by the daemon,
`--print` showing the declaration for the Resident's provision tool
instead; the Owner-account flags (`--intake`, `--outbound`,
`--auto-reply`) belong to Linear alone, every other account signs in with
`oni login`. **`oni messaging`** (`cli/messaging.ts`) is the
readiness report read from the catalog the env file names (`main.ts`
opens the channel tables on the catalog file and closes them at once):
per platform the rows with their postures and whether the credential row
is sealed, who reaches the Resident (READ: the declared tier against the
owner policy's `grant_tier` row, the allowlist, the mention-only posture,
the Owner account's intake; an a2a peer at its contact's tier through the
one door, so `channel add a2a` refuses a grant block; Linear's comments
that name the Owner), how the Resident answers and writes (WRITE: the bot,
the Owner's account with or without auto-reply, the draft; a webhook
target is never written back to by the reply door, GitHub only with a
sealed token), and whether the Owner is known there (OWNER: the owner-tier
Person's endpoint — and whether the bot row's allowlist names it — the
binding on mount for the arms that name their account, or the
`contact_add` still needed, Linear included); then who is reachable cold.
The report opens the catalog read-only (`query_only`). Exit 0 is "every enabled row is sealed" — the live run
proves the rest. **`docs/first-live-run.md`** is the runbook: declare,
read the report, the seven live checks per platform (inbound as the
Owner, as a stranger, a mention, the draft arm, a cold outbound, an
approval, a webhook) with what to expect and where the log names a
refusal, and how a passing platform is recorded here. Not in this lane,
by construction: a live run itself — the Owner runs it, and the first
platform with every check passing is the first this document may call
live. Found by lane R3 and still open on #1600: an authenticated answer
naming a request that does not exist never settles its frame.

Receipts: `apps/oni/test/cli-channel.test.ts` (the flags, the
prompts and their secrecy, the declaration with its grant, the socket
report, `--print`, every refusal), `test/cli-messaging.test.ts` (the
report over every platform shape, nothing declared, a ready row),
`test/cli.test.ts` (`messaging` over the real catalog reader: no catalog
refused plainly, a declared row reported, the usage). Suites:
`packages/channels` 1017 pass, `apps/oni` 1055 pass, 0 fail.

## #1600 Messaging readiness — dead paths (lane R3)

On `feat/1600-dead-paths` (2026-10-17, lane R3 of #1600). The readiness
sweep found paths that were declared but could never be walked. **A
declared webhook target had no door**: its handler was keyed by the
platform and no path served it. Every webhook declaration is now its own
door at `/webhook/<slug>`, keyed like its outbound contact
(`BuiltChannel`/`ChannelComponent.webhookKey` set by `declaredChannels` in
`channels.ts`, held by the supervisor under that key, served by
`webhookFor` in `index.ts`; an undeclared slug, an empty one and anything
outside the slug grammar — a percent-escape included, never decoded — are
404),
and the webhook surface answers a perimeter refusal 200 as its own verdict
and a handler failure 500 — the first cut let the throw escape and reset
the connection (`WebhookAdapter.dispatch`). **A tokenless loopback boot
could never answer a request**: nothing could present the token the answer
required, and the wire refused an empty credential before any rule ran.
The socket is now the evidence on a tokenless boot, under the one rule chat
already admits it by — the ws bootstrap grant makes every loopback socket
the Owner, and `assertWsExposure` confines a tokenless boot to loopback
(`ownerAnswerAuthentication` in `composition/answer-authentication.ts`,
over `webSocketSenderTier`); `Gateway.RequestAnswer.credential` admits the
empty string; with a token configured the token is required as before, and
a sender on any other surface goes to the token rule. The in-process
approvals facade (reached by tests alone) keeps the token rule. Found while
proving it, not fixed here: an authenticated answer naming a request that
does not exist never settles its frame (no receipt, no error) — recorded
as a follow-up on #1600. **A send to an Owner-only platform
without `as: owner` died at transport**: the preflight now refuses it
`identity_not_granted` naming the way (`router/messaging/authorize.ts`:
a platform with an Owner instance and no bot has no bot to send as). **The
typing pulse never reached an auto-replying Owner account** (`typingRouteFor`
in `composition/typing-route.ts`: the bot, else the identity-less surface,
else the Owner instance whose declaration auto-replies; a drafting one
never pulses, since a pulse would promise an answer). **A ws refusal was a
bare tag**: the error frame carries the operation, cause and message of a
`ChannelsFailure` (`gateway.ts`). **A Linear instance could mount deaf**:
keyless and nameless under `mentions_and_dms` nothing could ever name the
Owner, so the start refuses (`linear.owner.start`); under `all` it reads
everything. **A cold KakaoTalk send threw**: with no direct chat yet the
delivery is the typed `not_sent` receipt. **A rejected actor delivery was
reported as a handle**: `send_message` returns the contact outcome
(`not_sent` for a platform that rejected the letter, `unknown` for one
whose outcome is unknown), the same word a connector contact gives.

Receipts: `apps/oni/test/e2e.test.ts` (the declared webhook door:
unsigned 401, signed and refused 200 "Not ingested", undeclared 404),
`test/boot-wiring.test.ts` (the handler under its own key, gone with the
stage), `packages/channels/test/webhook-provider.test.ts` (refusal 200,
failure 500), `apps/oni/test/answer-authentication.test.ts` (the production ws
grant and a `connection:<uuid>` socket; another surface and a token boot
go to the token rule), `test/request-entry-auth.test.ts` (the booted
tokenless frame with an empty credential is authenticated),
`test/typing-route.test.ts`, `test/message-terminal-boundaries.test.ts`
(the error frame names the refusal), `test/send-message-contacts.test.ts`
(rejected and unknown deliveries on the result),
`packages/channels/test/router/messaging/identity.test.ts` (the Owner-only
platform refusal before transport), `test/linear-provider.test.ts` (the
deaf start refused; `all` reads), `test/kakaotalk-owner.test.ts` (the cold
send receipt). Suites: `packages/channels` 1017 pass, `apps/oni`
1045 pass, 0 fail.

## #1600 Messaging readiness — the reply door (lane R2)

On `feat/1600-reply-door` (2026-10-17, lane R2 of #1600). The readiness
sweep after #1569 found four answers that never reached the person who
wrote: **a GitHub reply never landed** — the inbound conversation was
`issue-7`/`pr-12`, no address a comment can be posted to, and the provider
refused every conversation hint, so the reply door's comment died at
transport. Now the inbound `channelId` is the issue itself
(`owner/repo#N`, `provider/github/surface.ts`) and the delivery route posts
into the conversation it is given (`provider.ts`; a cold send keeps the
direct `owner/repo#N` address), and the perimeter's refusal is answered
200 with the delivery claim kept (`dispatchWebhook`), as Linear already
did, so GitHub never redelivers a message the Owner's policy refused.
**A DM the Owner's account received was answered by the bot**, which
cannot reach that chat: the committed origin now records which instance
observed the prompt (`receivedBy` on the external origin,
`router/message-execution.ts`; the app's `CommittedOrigin` fold carries it
onto the binding, `composition/message-session.ts`), and `replyIdentity`
answers an Owner-received DM through the Owner's instance whatever else is
mounted — as the Owner where the declaration auto-replies, otherwise the
draft refusal, an inbound-only Owner instance (no outbound grant, so no
route) included, since the Owner needs no route to answer from their own
account (`router/messaging/reply.ts`; the review found the first cut
refused that default posture `reply_unbound`). A channel mention only the
Owner's account observed is still the bot's to answer (recorded limit: a
bot absent from that channel is rejected at transport). **A drafted
answer stayed invisible**: the Owner-draft arm the epic recorded as not
shipped is now the Resident's: when the reply door refuses
`message.resident.reply_draft`, the Resident delivers the draft to the
Owner — who, where, the words, and how to send it as the Owner — through
`send_message`'s actor door to the owner-tier Person (`ownerContactFor` in
`composition/owner-contact.ts`: a platform whose bot writes a person cold —
a messenger bot route, or the loopback socket; GitHub, a webhook target and
the Owner-only platforms address no person — where the Owner holds one
endpoint, two being ambiguous for a surface-named target; a live platform
before `ws`; the draft stays in the session when there is none), and a
draft the door did not carry is a Warn naming the conversation, never
silence. **The Owner is always the Resident's to write to**, in one layer:
the standing grants include the owner-tier Person whether or not `reach`
was declared (`grants` in `index.ts`), and the gateway asks no budget for a
letter to the owner-tier actor — a missing budget for the Owner is no
consent question (`ownerTarget` in `router/messaging/admission.ts`, read
by `admitSend` and the `preflight`; a budget the Owner declared for
themselves still governs) — so neither the draft arm nor the model's
`send_message` to the Owner mints a consent fact (the review found the
first cut asserting `consented: true` from the Resident itself). **A
button tap was answered on the tap**: the origin's `messageId` is the
postback's `messageRef` when the platform names the message the button
was on (Telegram does), so the reply quotes that message. The GitHub
`channelId` form is a key change: an automation condition, a
`trusted_channel` grant or a surface-key claim written against `issue-N`
or `pr-N` before this lane names nothing now and is re-declared or
re-claimed on the next comment (pre-release; no migration).

Receipts: `packages/channels/test/github-facts.test.ts`,
`github-pull-request.test.ts`, `automation-driver.test.ts` (the issue is
the conversation), `github-conversation.test.ts` (a conversation hint is
the comment's issue; a cold send keeps the direct address),
`github-retry.test.ts` (a refusal is 200 and never redelivered),
`provider-contract.test.ts` (GitHub joins the conversation targets),
`test/router/messaging/composition.test.ts` (an Owner-received DM is the
Owner's to answer — draft without auto-reply, draft through an inbound-only
Owner instance, the Owner's instance with auto-reply, the bot when the bot
saw it; a button tap answers the button's message),
`test/router/messaging/social-budget.test.ts` (a letter to the owner-tier
actor asks no budget and debits nothing; a declared one still governs),
`apps/oni/test/resident-reply-to-origin.test.ts` (the draft reaches
the Owner through the bot, unconsented, naming the conversation; with no
platform it stays in the session; another refusal is never a draft),
`test/reply-door.test.ts` (the app's origin fold carries `receivedBy`: an
Owner-received DM is a draft through the real gateway),
`test/send-message-e2e.test.ts` (an owner-tier Person without `reach` and
without a budget takes the letter, no consent asked),
`test/owner-contact.test.ts` (the contact's choice: a messenger bot or the
socket, one endpoint, never GitHub or an Owner-only platform). Suites:
`packages/channels` 1015 pass, `apps/oni` 1039 pass, 0 fail.

## #1600 Messaging readiness — admission: a declared instance can admit people (lane R1)

On `feat/1600-admission` (2026-10-17, PR #1601). The per-platform trace
after #1569 found that a declared instance admitted nobody: its ingress
grant mounted at `MOUNTED_CHANNEL_DEFAULT_TIER` (`assigned_worker`) and
the owner-policy row `message.external.grant_tier` passes only
owner/co_owner/manager, while `channel_add` could not raise the tier.
**The declaration's grant block has a write path.** `channel_add` (the
provision tool and the Owner's ws `channel_add` frame alike) takes
`grant: { defaultTier?, allowedSenders?, mentionOnly? }`
(`Provisioning.ChannelGrantDeclaration`; `GrantPolicy` gained
`mentionOnly`, and an empty allowlist is refused). The block is the
Owner's perimeter decision whichever field it carries (the review showed a
tier-only consent let the Resident widen the list and drop the posture
under it): any declaration carrying a block suspends for the Owner's
consent bound to the row's revision (`channelConsentRequired`), a
consented block replaces the stored three fields (a field left out is
cleared — the only way a list or a posture is withdrawn), and a
declaration without a block keeps what was consented to. The desired row
carries the allowlist and the posture (`desiredChannels`); the bot
instance's declaration is the platform grant's posture and an Owner
instance's block speaks only where the platform has no bot reader
(`settleGrant`; a union would have let an Owner-instance list lock
strangers out of the bot); the registrar takes the declarations over the
env lists `ONI_CHANNEL_ALLOWED_SENDERS`/`ONI_CHANNEL_MENTION_ONLY`,
which stand only where no declaration speaks — an explicit
`mentionOnly: false` included (`createMountedChannelGrantRegistrar`). A
guest on a surface declared at `manager` is admitted at that tier
(`message-admission.test.ts`). **An Owner instance's account is the
Owner.** A provider runtime may name the account it speaks as
(`ProviderRuntime.account`, `AccountIdentity`); the Slack (`TEAM:USER` in
workspace `TEAM`), Discord, Instagram and KakaoTalk Owner adapters do once
started, and the supervisor hands a started Owner instance's account to
`bindOwnerAccount`, which adds it as an endpoint of the owner-tier Person
— creating `person:owner` (reachable) when none exists — and
re-materializes the actors; an address another Person already holds is
never re-homed by a mount (the binding names the holder and the Owner is
warned), a binding that throws unwinds the stage like a failed start, and
because the session that decides which account that is can be rotated,
`secret_rotate` of a secret an Owner instance speaks as takes the Owner's
consent bound to those rows (`secretRotateDomainRevisions`; a bot
instance's secret stays the Resident's to rotate). So the Owner writing to
the bot on that platform is owner-tier without a `contact_add`, and
`as: owner` can be authorized from there. **A mention is addressed.** `ingressInput`
counts the surface's own `event: mention` classification as addressing the
Resident, so a channel @mention of the bot routes under a mention-only
grant whether or not the bot's account is a registered identity.
**Endpoints resolve without a workspace.** `findEndpoint` falls back to a
workspace-less row after the exact (channel, workspace, externalId) match,
so a Person declared as `{ channel: "slack", externalId: "T1:U1" }` is
recognized in workspace `T1`; the `contact_add` tool text names what an
endpoint looks like on every platform. Receipts:
`apps/oni/test/provision-tools.test.ts` (any block takes consent, a
consented block replaces, a declaration without one keeps, an empty list
is refused; an Owner instance's secret rotates only under consent),
`test/provisioning.test.ts` (the row carries it),
`test/identity-instances.test.ts` (the bot reader's policy is the
platform's, the Owner reader's only without a bot, an explicit
`mentionOnly: false` over the env list; a started Owner instance binds its
account; a throwing binding unwinds; `bindOwnerAccount` creates, extends,
never duplicates and never re-homes another Person's address),
`test/owner-account-binding.test.ts` (the booted composition binds a
mounted Owner instance's account; an address another Person holds stays
theirs and the Owner is warned), `test/request-domain-revisions.test.ts`
(`secret_rotate` reads back the Owner instances' revisions),
`test/channel-wire.test.ts` (the frame carries `grant`),
`test/message-admission.test.ts` (a declared manager tier admits a guest),
`packages/channels/test/router/mention-only.test.ts` (the surface's mention
is addressed), `test/store/actor/endpoint-filters.test.ts` (the fallback),
`test/{slack,discord,instagram,kakaotalk}-owner.test.ts` (each account);
suites: `packages/channels` 1010 pass, `apps/oni` 1032 pass,
0 fail. Not in this lane: the remaining #1600 lanes (reply door, dead
paths, the first live run).

## Media parts: audio and video on every fork platform (PR #1643)

On `feat/g1-media-parts` (2026-10-25, base `cd71e4bda` after #1619, no
issue). `Outbound.Part` gains `kind: audio` (`voice`, `durationMs`,
caption) and `kind: video` (`durationMs`, caption), with matching `Audio` and
`Video` catalog elements. Inbound attachments gain the `video` kind plus
`durationMs` and `voice`. `MediaLimits` carries `audioBytes` and `videoBytes`:
Telegram 50 MB, Slack 1 GiB, Discord 20 MiB, and the new
`KAKAOTALK_MEDIA_LIMITS` (image 10 MB, file/audio/video 50 MB), the KakaoTalk
figures declared rather than platform-verified because the fork's LOCO upload
enforces no cap. An oversize part is the typed `MediaTooLarge {kind, bytes,
limit}`, folded into a `not_sent` receipt with `reason: media_too_large <kind>
<bytes>><limit>`; `Outbound.Receipt` declares the optional `reason`, carried
through the send receipt and actor delivery result to the `send_message`
tool result. A rejection without a reason keeps the generic refusal text.
Telegram sends audio through `sendAudio`, a voice note through `sendVoice` and
video through `sendVideo`, `duration` rounded from `durationMs` (fork dist pin
`2e97492a9ff80cef98fe7790144d846e974cb83e`); Slack and Discord upload audio
and video exactly as they upload a file; KakaoTalk Owner delivery sends
`sendPhoto`/`sendVideo`/`sendAudio`/`sendFile` and the caption as a following
text message. `apps/oni`'s media resolver honors declared MIME types for audio
and video. Not in this change: model consumption of audio or video (no STT, no
frame sampling) and a KakaoTalk download client. Receipts:
`packages/protocol/test/{outbound,message}.test.ts`,
`packages/protocol/test/send-message.test.ts`,
`packages/channels/test/{telegram,slack,discord}-media.test.ts`,
`packages/channels/test/{translate,kakaotalk-owner,inbound-attachments}.test.ts`,
`packages/channels/test/router/messaging/actor-receipt.test.ts`,
`apps/oni/test/{media-resolver,attachment-inbox,send-message-contacts}.test.ts`.

## DoD sweep over the media-parts landing (PR #1643 follow-up)

On `feat/g1s-dod-sweep` (2026-10-25, base `5a1797a82` after #1643, no
issue). The #1643 diff was reviewed line by line twice and every High and
Medium finding fixed in the same tree: `attachments.ts` keeps every stored
outcome instead of evicting at 1,024; `media.ts` DNS admission races the
lookup against the request abort and bodyless successes check their declared
length; Discord reaction removal and the typed rejection callbacks in
`deliver.ts`/`attachment-download.ts` run inside the handled promise chain;
the Discord DM-opening failure message is retained in `DeliveryNotSent.cause`;
the KakaoTalk push schema extends the SDK export only at its attachment field;
and the Slack/Telegram bot `stop()` lives once in `support/sdk-listener.ts`.
Test duplicates folded into `test/helpers/inbound-queue.ts`,
`test/helpers/observation.ts` (`infoCollector`) and per-file helpers. Measured
against base `e9eaaf9e7` with the repository's own tools: jscpd clones 282 ->
246 with zero new pairs, patch coverage 100% of changed executable lines
(`check-patch-coverage.ts` on the lane LCOV), no new dead exports, cognitive
complexity findings 0 on every touched path, and the sixteen-step local gate
chain exit 0 (protocol 947, channels 1117, machines 341, apps/oni 1165 tests).
Not established: the scoped mutation run, because every campaign currently dies
in reach discovery on Bun macro imports (#1644, fix in PR #1645).

The #1644 reach follow-up on `fix/1644-reach-macro-const-init` (2026-10-25,
PR #1649) discovers named literal macro calls from the source inventory,
independently of selected candidates. The staged preload installs the overlay
before priming instrumented implementations, suppressing marker writes only
during priming in each Bun process. Priming is confined to execution-copy
processes; inherited external fixture children retain local LCOV sources.
Executable regressions cover colliding import names, shadowed ordinary calls
and inherited-child attribution. On Bun 1.4.1/macOS, the isolated real boot graph passes with only
`embed.ts` instrumented: implementation reach is present for boot and absent
for an unrelated test, and native LCOV parses without escaping the root.
A complete mutation campaign is not established.

## Model consumption of inbound media (PR #1651)

On `feat/g2-model-consumption` (2026-10-25, base `87f8f33c8` after #1645, no
issue; its transient media registry and parts-in-call shape are superseded by
#1671 above). `packages/llm` catalog rows carry `input` modalities (`text`, `image`,
`audio`, `video`), overlaid from the bundled snapshot when a cached
catalog predates the field, and `Capability.accepts(model, {kind, mime})`
admits an image or audio format against the effective call surface the SDK
selector picks in `provider/sdk.ts` (a proxy row and a declared `chat` row
call chat completions, everything else calls responses), so an audio file part
is never sent to a surface that rejects it. `RunInput.media = {parts, bytes,
derive?}` is resolved inside `run()` after router selection: the caller's
`PartDerive` runs only for the modality or format misses of the chosen
candidate (`message/parts.ts`); `stt.ts` is the transcription port the app
binds. `apps/oni` keeps one `DeliveryMediaRegistry` per app runtime
(`composition/delivery-media.ts`: remember, recall, bind). It lives in process
memory, so a restart between commit and run loses the held parts; the
parent's 256-entry retention limit is shared by all of its sessions, and each
process child holds its own registry. The app passes `mediaDerive` as
`input.media.derive`; `composition/
media-input.ts` sniffs the MIME type from bytes (an `ftyp` brand table maps
M4A/M4B to `audio/mp4`, `qt` to `video/quicktime`, `3gp*` brands; the MPEG
frame sync rejects reserved version, layer, bitrate and sampling fields),
derives a transcript from audio and sampled frames from video, and caches each
derivation per ref. Automatic reads require an export rooted exactly at the
inbox (implicit for self, required on a remote default machine), otherwise
`inbox_not_exported` refuses them; video frames are cut from a staged copy of
the confined bytes. `runtime.ts` loads media metadata lazily per
history message through one seen-set path, a lookup failure logged as a
warning instead of a Die; a process child requests bytes and derivations over
`request_media`, `request_bytes` and `request_derive` frames
(`composition/process-replies.ts`: 50 MiB cap, 30 s receipt deadline, expired
request ids retained so a late valid receipt is discarded instead of closing
the reply channel). Review rounds r1 (2 High, 4 Medium) and r2 (4 High,
1 Medium) were fixed in the same tree. Not established: a live Resident proof
(the hub route is blocked on #1647/#1648) and a derivation against a real STT
model (blocked on the realtime key, #1641). Receipts:
`packages/llm/test/{run-media,stt}.test.ts`,
`packages/llm/test/model/capability.test.ts`,
`packages/llm/test/message/parts.test.ts`,
`packages/llm/test/provider/media-wire.test.ts`,
`packages/protocol/test/media-part.test.ts`,
`apps/oni/test/{delivery-media,media-input,ws-parts}.test.ts`,
`apps/oni/test/{process-media,process-media-transport,process-replies-timeout}.test.ts`.

## Discord voice calls with a realtime model (PR #1656)

On `feat/g3-discord-voice` (2026-10-25, base `690f14487` after #1653, no
issue). The agent-messenger fork dist pin `5ff4c722` (source `410a0857`)
gives `discordbot` gateway opcode 4, voice-state and voice-server events and
`joinVoice`: a 48 kHz stereo s16le PCM handle subscribed to one speaker, its
speaker observer registered before any voice resource is acquired, a second
concurrent write refused `voice_busy`, received PCM bounded at 384,000 bytes
in flight (`voice_overflow` disconnects the call) and one idempotent cleanup
of every acquired resource. `packages/channels` declares the Discord bot
`voice: true`: its `voiceRoute` holds one joining or live handle per guild and
refuses with the typed `VoiceJoinRefused` (`address_incomplete`,
`not_started`, `busy`, `aborted`, `join_failed`); the nonprivileged
GuildVoiceStates intent turns an Owner voice-state join or move into an
inbound `event: "call"` fact (the newest sequence wins), an unrouted call is
filtered as `call_unrouted`, a refused author lookup is logged and emits no
call, a failing event pump emits one error event and frees the guild, and
`stop()` leaves every live handle. `Ingress.Trigger` gains `{type: "call",
surface}`. `packages/llm` `makeRealtime` opens one realtime WebSocket per
call: the `session.update` echo is checked (PCM16 24 kHz both ways, semantic
VAD, transcription, voice, tool names), the handshake is bounded at 10 s,
frames parse through Zod, queued model audio is capped at 48,000 bytes, each
tool call is surfaced once per call id and answered with `respondTool` then
`response.create`, and nothing retries. `packages/agent` `Core.sessionTool`
admits each external tool call as its own turn in the same session through the
session entity's activation and fence: it waits for the active turn's terminal
(bounded, `ToolTurnRefused{busy}`), refuses a call id already recorded in the
journal with `ToolTurnRefused{duplicate}` (also from a new activation), takes
authority from the initiating turn's recorded origin, returns the tool result
only when the turn sealed successfully, and recovery settles an interrupted
external turn without entering the model loop. `apps/oni` adds
`send_message(kind: "call")` through a `CallPort` with typed refusals;
`composition/live-voice.ts` bridges voice PCM and the realtime session and
sends every model tool call, in arrival order, through `bindSessionToolTurn`
(`composition/cluster-runtime.ts`, the binding the session's own runTool port
uses); `composition/live-pcm.ts` is a 63-tap FIR resampler between 48 kHz
stereo and 24 kHz mono; an interrupt first delivers and drains the durable
interrupt of a live turn and then ends the call, a failed leave reports one
`live call <id> release failed` incident, shutdown ends every call, and the npm artifact keeps the
voice and codec packages external. Review r1 (12 High, 13 Medium) was fixed in
the same tree. Not established: a live call, which needs a voice-capable guild
(#1639), host audio packages (#1640) and a realtime model lane (#1641).
Receipts: `packages/channels/test/{discord-surface,discord-sdk,discord-normalizer,provider-contract}.test.ts`,
`packages/channels/test/{automation-router,automation-matcher}.test.ts`,
`packages/llm/test/realtime.test.ts`,
`packages/agent/test/session/{tool-turn,admission-writer-fiber}.test.ts`,
`apps/oni/test/{live-voice,live-pcm,automation-delivery,npm-package}.test.ts`,
and the fork's `src/platforms/discordbot/voice.test.ts`.

DoD sweep PR #1660 (G3S): review r1 of the landed diff (3 High, 3 Medium) fixed; every terminal path of a live call closes tool admission before the voice leave, a batched turn and its external tools share the most restrictive delivery's authority, an old Discord voice handle never releases its replacement, and a realtime endpoint keeps its own query.

## Slack Owner huddle calls (PR #1657)

On `feat/g4-slack-huddle` (2026-10-25, base `3288877fc` after #1660, no
issue). The agent-messenger fork dist pin `eb65d4b8` (source `2d9d99e6`) gives `slack`
`joinHuddle`: a supervised browser host process joins the huddle under the
Owner's sealed `{token, cookie}` and exchanges bounded PCM frames with
transport credit (38,400 bytes in flight), refuses with four typed codes
(`voice_not_ready`, `voice_busy`, `voice_aborted`, `voice_join_failed`) and
reports one event iterator (`speaker_left`, `disconnected`, `error`).
Capture starts only after the huddle admission settles, readiness re-checks
room isolation after an unmute, and the parent owns a 0700 browser profile
(an `owner.json` with its pid) that every cleanup path removes; the next
join's sweep removes a profile whose recorded owner is dead, or an ownerless
one older than 10 minutes. Discord voice uses the extracted shared
event queue. `packages/channels` declares the Slack Owner account
`voice: true`; the Slack bot stays `voice: false`. Its `voiceRoute` admits
locally before any fork I/O (a started account, a `TEAM:USER` speaker equal to
the Owner, the account's workspace, a `C`/`D`/`G` conversation, one pending or
live call, a signal not already aborted) and maps the fork refusals onto
`VoiceJoinRefused` (`not_started`, `busy`, `aborted`, `join_failed`) with
sanitized details. `stop()` is generation-fenced: it aborts a pending join,
leaves a handle that arrives late and awaits the one retained leave that any
terminal path starts (a terminal event, an iterator error or end, an explicit
leave). An Owner RTM `user_huddle_changed` into a huddle becomes an inbound
`event: "call"` fact once `sh_room_join` associates the room with its
conversation, in either order: at most 32 rooms in one FIFO map where a
conflicting association is stored as blocked, and an unresolved room warns
`huddle_channel_unresolved` after 10 s run through the injected Effect runner.
A reconnect drops the associations but keeps the current room and timestamp,
only `not_in_a_huddle` counts as leaving, and the account's own browser seat
never raises a call while one is pending or live. The account never joins by
itself, and mention-only routing still filters an unaddressed call. `apps/oni`
stages the SDK's compiled `huddle-host.js` beside both npm bundle entries (the
artifact test forks the staged host and receives `left`), and the
`send_message` call description names the account-specific `call_as_owner`
refusal. Review r1 (3 High, 8 Medium) was fixed across both trees. Not
established: live acceptance (#1655) — current Slack selectors, the cookie
bootstrap, room association delivery, browser media and the PipeWire-Pulse
devices, duplex audio and latency, notification-sound exclusion,
force-kill membership expiry, same-identity Owner departure and
selected-speaker isolation. Receipts:
`packages/channels/test/{slack-voice,slack-normalizer,slack-owner,provider-contract}.test.ts`,
`packages/channels/test/router/mention-only.test.ts`,
`apps/oni/test/{live-voice,send-message-contacts,channel-composition,npm-package}.test.ts`,
and the fork's `src/platforms/slack/huddle*.test.ts`.

DoD sweep PR #1661 (G4S): review r1 of the landed diff (R01-R06, L01) fixed; a Slack Owner voice join is admitted only after the current start generation authenticated and received the RTM hello, a rejected leave of a late handle reaches `stop()` as the typed join refusal, `not_in_a_huddle` without a `call_id` ends the current room, a conflict for an older room clears only that room's pending resolution, and the unconsumed SDK `off` seam is removed.

Issue #1686 (`fix/1686-huddle-call-contact`, 2026-10-28): a Resident's
`send_message` call can target a registered non-Owner Person with a matching
platform endpoint, without a standing `reach` grant. Each such call suspends for
the Owner's approval bound to that Person's revision before the body runs;
refusal starts no voice route, and an edit of the Person row between the ask
and the answer refuses as `stale_approval`. A call to the Owner's own Person
and a call to a contact the store does not hold run directly (the route
refuses the latter as `call_contact_missing`). The Owner voice surface remains the seat, while
the selected speaker is the contact's `TEAM:USER` endpoint. The Slack route
passes `mode: "join"` for an Owner contact and `mode: "call"` for other
contacts, opening the huddle in `to.conversation.channelId`; the fork's
`speakerId` receives the `USER` portion. On the host the Owner huddle
opens live in the contact's DM (evidence under
`.omo/evidence/g4-huddle-host/1686-soju-call/`); a coworker answer remains to
be established. Receipts:
`apps/oni/test/{live-voice,send-message-contacts}.test.ts`,
`packages/channels/test/slack-voice.test.ts`.

## Telegram Owner account over TDLib (PR #1659)

On `feat/g5-telegram-owner` (2026-10-25, base `47b51f61a` after #1661, no
issue). The agent-messenger fork dist pin `de49e8fb` (source `914ea5be`) gives
`telegram` an account client with one TDLib receive owner, Bot API chat ids
and forum topics, staged byte sends settled per chat that report a definite
`not_sent` apart from an ambiguous outcome, one awaited native close, and an
account-state stream in which TDLib parameter setup is not a login step.
`packages/channels` adds the `telegram:owner` arm behind `owner-sdk.ts` (the
only importer of `agent-messenger/telegram`). It subscribes to account state
before it starts and withdraws once, with a latched reason, on
`login_action_required` or `session_lost`; an optional `onWithdrawn` hears it.
Its byte sends use the Telegram media limits (10 MB image, 50 MB file, audio
and video, 1,024-character caption), and an oversized attachment is refused
`too_large` before any request. `OwnerLogins.telegram` signs in through the
same client. The login and the mounted account share one exclusive session
under `~/.oni/telegram/owner/{db,files}`: 0700 directories that refuse
symlinks and foreign owners, and a pid lock that refuses a live holder
(`session_in_use`) and recovers a dead one; a native close that is not
confirmed keeps that custody. A generic `historyRoute` pages an Owner
account's chat (`Channel.HistoryRequest`/`HistoryQuery` in
`packages/protocol`: limit 1..100, a `before` cursor, a page of at most 100
messages) and refuses with `owner_auth_required`, `owner_not_ready`,
`session_in_use`, `session_lost`, `login_action_required`,
`history_unavailable` or `invalid_request`. `packages/machines` adds
`fs.writeStream`: bounded chunks over `machine.fs_stream` that succeed only
when the digest-checked atomic finish is acknowledged; a held write
acknowledgment pauses the producer, and a detach or caller interruption
aborts the transfer and releases it. `apps/oni` adds `oni login telegram`,
which refuses a non-interactive terminal, reads
`ONI_TELEGRAM_API_ID`/`ONI_TELEGRAM_API_HASH` from `~/.oni/env` or asks for
them, asks for each sign-in step (phone number, code, password, email)
without echo, and declares a `telegram` channel with identity `owner` and the
sealed credential. It also adds `oni channel history <instance-id> <chat-id>
[--before <cursor>] [--limit <1..100>]` against the local daemon, and
attachment intake that streams onto the attached machine under a 2 GiB bound
with one deadline signal; app shutdown aborts a held download. The
provisioning supervisor reports a withdrawn Owner instance as `withdrawn`
with its typed cause and revokes its mounted history. Review r1 (2 High,
10 Medium) was fixed in the same tree; its two Lows are PR comments. A local
end-to-end scenario (`apps/oni/test/telegram-owner-local.test.ts`) runs
login, mount, history paging and a streamed attachment against an injected
account client. Not established: live acceptance, which needs the packed
build on the host (#1648) and the Owner's API id/hash and private sign-in
(#1642). Receipts:
`packages/channels/test/{telegram-owner,owner-login,provider-owner-arm,provider-contract,provider-golden}.test.ts`,
`packages/machines/test/stream-write.test.ts`,
`packages/protocol/test/channel-history.test.ts`,
`apps/oni/test/{telegram-owner-local,channel-history,cli-history-socket,cli-telegram-login,cli-login,attachment-inbox,attachment-inbox-stream,npm-package}.test.ts`,
and the fork's `src/platforms/telegram/account.test.ts`.

DoD sweep PR #1663 (G5S): review r1 of the landed diff (1 High, 8 Medium)
fixed. The fork dist pin is now `0bae10f2` (source `e7da329c`): an abort
before the download request's reply ends the download without an unhandled
rejection, a byte send is staged under its requested filename reduced to one
safe segment, an explicit TDLib `sendMessage` error reply marks the error
`requestRefused`, and native inputs, updates and history are parsed at their
boundary. Session custody is now an exclusive nonblocking `flock` held on the
open descriptor of a stable, private `session.lock` file: closing the
descriptor (or the holder's exit) releases it and the file is never unlinked,
replacing the pid lock and its dead-holder recovery. The adapter fences its
start with a stop generation, releases custody acquired after a stop and
joins a start in flight; the provisioning supervisor serializes
reconciliation, stops pending mounts in `stopAll`, publishes routes only after
startup and account binding, and refuses a second declaration of a busy
surface with `session_in_use` without touching the incumbent's routes. Topic,
media and readiness admission run inside a new attempt, so a retained
`unknown` receipt is answered first. An explicit native refusal is
`rejected` whatever its recovery code, and a refused size carries
`media_too_large <kind> <bytes>`. SDK listener custody settles a start still
waiting for its first hello when it is stopped. Receipts:
`packages/channels/test/{telegram-owner,telegram-owner-lifecycle,sdk-listener}.test.ts`,
`apps/oni/test/channel-lifecycle.test.ts`, and the fork's
`src/platforms/telegram/account.test.ts`.

Gate fix PR #1664 (G5S B1): the fork dist pin is now `6374b5b7` (source
`be06d64b`). A stop that lands while the account client's start is still
creating its directories or loading the TDLib binding now ends that start
with `session_lost` before any native client exists. Before, the SDK close
returned at once, the adapter released session custody, and the late start
created a TDLib client that was never closed natively. Receipts: the fork's
`src/platforms/telegram/account.test.ts` (a close in each window before
native allocation).

## #1569 Messaging on the agent-messenger SDK — epic closure (lane 10)

On `feat/1569-cleanup` (2026-10-17, PR #1598, lane 10). The twelve lanes below are all on
main (PRs #1586–#1597); this section is the one place the shipped state is
summarized, and the per-lane sections under it are the receipts. Messenger
I/O is the repository's agent-messenger fork pinned by commit in
`packages/channels/package.json` (byte uploads, per-client retry control:
Discord bot, Discord Owner and Telegram bot SDK clients set `retries: 0`;
Slack pins its inner Web API client to one attempt but retains up to three
SDK retries after an explicit 429 refusal — Telegram
`getFile`/`answerCallbackQuery`/`sendChatAction`, Discord typing/DM/interaction
responses, errors carrying `httpStatus`/`retryAfter`); the hand-rolled Discord
and Telegram REST clients are gone and every REST call goes through the SDK
seam. When `ONI_MACHINES_INBOX` (or `machines.inbox`) is configured,
`composition/attachments.ts` best-effort stores inbound attachments on the
default machine before handoff and rewrites successful references to
`<machine>:<path>`. Telegram `file_id` and Slack file IDs use the bot's
authenticated `ProviderRuntime.attachments` download (Slack needs
`files:read`); public URLs such as Discord CDN links use the composition
media resolver. Slack Owner exposes no attachment download port, and
private-URL-only references cannot be fetched through the bot's file-ID
download; those references remain as received. A failed fetch or write keeps
the original reference and warns. Authenticated downloads are bounded by the
50 MiB media cap and a 30-second deadline; conversation-scoped hashed inbox keys distinguish messages,
and exclusive-create writes refuse an existing leaf or symlink. Receipts:
`apps/oni/test/attachment-inbox.test.ts`, `test/config.test.ts`.
Before that, messenger I/O was `agent-messenger@2.39.0`, one `sdk.ts`/`owner-sdk.ts` seam per
messenger provider (Slack, Discord, Telegram, Instagram, KakaoTalk), under
`support/sdk-listener.ts` custody; GitHub, Linear, webhook and A2A are
hand-rolled over fetch and webhook ingress. The SDK's own credential store
is never used — every account session and bot token is a vault row
declared through `channel_add` or sealed by `oni login`. **Identity**
(P1, P2, P5): a mounted messenger channel is one `(platform, identity)`
instance, `bot` the default on Slack, Discord and Telegram (GitHub, webhook
and ws stay identity-less platform surfaces reached as the bot), `owner`
the account instance that sends cross-conversation only on the Owner's
authenticated instruction (`as: owner` under an Owner-origin turn and the
declared `outbound` grant) and reads under its declared intake posture
(`mentions_and_dms` default, `all`, `none`); Instagram, KakaoTalk and
Linear are Owner-only platforms with a refusing bot arm and a per-instance
`autoReply` switch. **Doors** (P3, P4): the reply door answers the
conversation a turn came from, authorized by the conversation binding
alone — as the bot where a bot instance reaches it, as the Owner where
only an auto-replying Owner instance does, and otherwise refused as a
draft (`message.resident.reply_draft`); `send_message` reaches
every other party — a session, a new child, a Person on a channel (its
`reach` the Owner's standing grant; a missing social budget takes the
Owner's consent on the invocation, `approval_required` otherwise), a CLI
agent (`cli:`), a declared webhook target (`webhook:`, a signed letter) or
an A2A peer (`a2a:`, one blocking `message/send` with the peer's answer on
the result). **Inbound from other agents**: the one A2A door at `POST /a2a`
admits every declared peer at its contact's tier, the context being the
conversation. **Retired**: the hand-rolled Slack/Discord/Telegram
transports, the reply-grant machinery and the post-turn `send_message`
report, `ONI_ACTORS` and env actors (Person rows are the one
declaration), the #1110 "only the Owner is public" identity amendment.
**Not shipped by the epic** (recorded, not implied): the Owner-draft arm
for conversations only the Owner instance can reach (shipped by #1600 lane
R2, the section above); the Telegram Owner
instance (no SDK export yet); a contact's later answer delivered as a
prompt (A2A answers ride the tool result; the inbound door is the
asynchronous path); A2A streaming, push notifications and durable tasks;
budgets as Person fields (`ONI_SOCIAL_BUDGETS` stays env). Dead
exports: the baseline is empty and `check-dead-exports` passes at this
commit; SLOP receipts for the epic's deletions are in `docs/SLOP.md`
(the #1569 table). Suite counts at the epic's close: see each lane's
section; the last full runs were `packages/channels` 1005, `apps/oni`
1023, `packages/protocol` 656, 0 fail.

## #1569 Perimeter collapse for addressed sends (lane 8)

Merged to main as PR #1597 (2026-10-17, reviewed and
corrected). Who the Resident may write to, and when the Owner is asked, are
now the Owner's declarations alone. **Person `reach`**:
`Provisioning.Person` carries `reach?: boolean`
(`packages/protocol/src/provisioning/schema.ts`), set through `contact_add`'s
manifest (`apps/oni/src/bundles/provision/contacts.ts`) — and it is the
Owner's to grant: a manifest carrying `reach: true` (a new Person, or a
re-declaration of a reachable one, so the endpoints behind the grant are
the Owner's too) suspends `contact_add` for the Owner's consent bound to the
row's revision (`approvalRequirement`), like a tier raise; without consent
the row never lands. The standing `SenderTargetGrant` for every resident
session is built from the Person store at each send (`grants` in
`apps/oni/src/index.ts`: residents × Persons with `reach: true`,
operations `awaited` and `fire_and_forget`), so a contact named mid-run is
reachable at once and a Person without `reach` is an inbound identity only
— a letter to it is `ungranted` (the tool sees the
`message.resident.actor_grant` policy row). **`ONI_ACTORS` is
retired**: `config.actors`, `RegisteredActor`, `actorsFromEnv` and
`registerActors` are gone; `materializePersons` is the one path from a
declaration to an actor row (the loopback `ws` Owner bootstrap is
unchanged), and `loadConfig` refuses the variable when it is still set
(`retired_env`) rather than dropping an authority silently. **A missing
social budget is the Owner's to approve, never a silent denial**: the
consent is one judgement made in two places that read the same facts — the
Person's `reach` and the active budgets (`activeBudgetFor`, exported by
`@oni/channels`: a lapsed allowance is no budget). At the tool,
`send_message`'s approval hook (`ownerConsent`) suspends a letter to a
reachable Person with no active budget for the Owner's consent, bound to
the Person row's revision (`domainRevisions: { [personId]: revision }`,
read back by `createRequestDomainRevisions`, so an edit of the row between
the request and the answer is `stale_approval`); connector contacts
(`cli:`, `webhook:`, `a2a:`), sessions, new children, budgeted Persons and
Persons the Owner never made reachable never wait. The kernel runs the
body only after the Owner's answer, and the body's consent fact is the
non-empty bound revisions the kernel hands it — never the budget list read
again — setting `consented: true` on the gateway send
(`Gateway.SendMessage.consented`, threaded to `SendInput.consented`). At
the perimeter, the actor-send preflight returns `approval_required` for a
granted cold send with no active budget and no consent, which the compiled
row `message.resident.approval_required` (`check.kind: consent`, the gate's
`consentGranted` fact) denies before any admission; `admitSend` admits a
consented budget-less send once with no debit and denies `approval_required`
itself when reached without one (a composition that wires only the
router's budgets port). A declared budget is never widened by consent: the
pure `evaluateSocialBudget` fold is reached only with an active budget in
hand and its window/cooldown/quiet-hours/do-not-contact suppressions
stand. Receipts: `packages/channels/test/router/messaging/social-budget.test.ts`
(preflight's `approval_required`, the lapsed budget, the consented send
with no debit, consent under a declared budget), `test/barrel.test.ts`,
`apps/oni/test/send-message-contacts.test.ts` (the hook per target
kind and the bound revision; the consent fact from the kernel's revisions;
the kernel leg through `protectedDispatch`: suspend, answer, one consented
send; refusal sends nothing; an edited row is stale consent),
`test/gateway-contracts.test.ts` (the compiled consent row denies cold
egress before any delivery), `test/owner-policy.test.ts` (the row),
`test/provision-tools.test.ts` (`reach` suspends for consent and lands on
the Owner's answer; re-declaring a reachable Person's endpoints takes it
again), `test/send-message-e2e.test.ts` (a Person without `reach` is
`ungranted` on the booted daemon; `reach` set on the row makes the next
letter land with no reboot), `test/app-surface.test.ts`,
`test/request-channel-e2e.test.ts` and `test/helpers/request-owner-process.ts`
(Person rows with `reach`, never env actors), `test/config.test.ts`
(`ONI_ACTORS` refused); suites: `packages/channels` 1005 pass,
`apps/oni` 1023 pass, 0 fail (the earlier 1024 counted the child process a cleanup test spawns).

## #1569 A2A: the door and the `a2a:` contact (lane 9c)

Merged to main as PR #1596 (2026-10-17, reviewed and corrected). Other
agents reach the Resident through ordinary ingress with their own actor and
tier, and the Resident reaches other agents through `send_message` — both
on the A2A 0.3 JSON-RPC binding (`kind` discriminators; the 1.0 spellings
`SendMessage`/`GetTask`/`CancelTask` accepted as aliases). A peer is a
`channel:a2a:<id>` declaration whose sealed credential carries `token` (the
shared bearer the peer presents inbound and this daemon presents when
writing to it), optionally `url` (the peer's base, where its card is
served; absent leaves the peer inbound-only) and `name`
(`packages/channels/src/provider/a2a/{types,client,surface,provider}.ts`,
registry key `a2a`). Naming a `url` is an outbound destination, so the
declaration takes Owner consent like a webhook target's and a rotation
never introduces one (`channelConsentRequired`, `executeSecretRotate`).
**One door for every peer**: `declaredChannelProfile` turns every a2a
declaration into a `ready` roster entry and mounts one row, `A2A_DOOR_ID`
(`channel:a2a`, surface `a2a`), while any peer is declared — keyed by
nothing a peer's revision or rotation changes, since the roster
(`a2aRoster` in `apps/oni/src/channels.ts`) lists the instance store
and opens each credential from the vault at request time; disabling,
rotating or declaring a peer takes effect at the next request with no
remount, and the door goes only with the last peer
(`apps/oni/test/a2a-door.test.ts`). The door (`A2AAdapter`, `POST
/a2a` and `GET /.well-known/agent-card.json` — `/.well-known/agent.json`
too — through `WEBHOOK_ROUTES`/`CARD_PATHS` in `apps/oni/src/index.ts`)
compares a bearer in constant time against every peer; the match's id is
the peer's actor id, and the peer's tier is the Owner's `contact_add` of an
actor with endpoint `{ channel: "a2a", externalId: <id> }`, never the
door's: a peer the Owner has not named is refused by policy at the mount
tier (`message.external.grant_tier`) and its task fails. The peer is a bot
author on surface `a2a`, and the perimeter admits it as an agent rather
than an echo: `BOT_AUTHORED_SURFACES` (`webhook`, `alarm`, `a2a`) is
exempt from `rule/bot-author`, and the granted-direct automation those
surfaces migrate carries `includeBots: true`. `message/send` creates a task
in a context — **the context is the conversation** (`channelId`), the task
one exchange in it, so every task a peer opens in one context reaches the
same session — hands the text parts off as one inbound message (`surface:
a2a`, `event: message`, `dm: true`) and answers with the task `working`;
`configuration.blocking` waits for the Resident's answer, bounded at 30 s
on the injected run port, every blocking send on a task woken by it, and
returns the task as it stands, its history cut to
`configuration.historyLength` (0 omits it); a follow-up naming the task
continues it, one naming a finished task is refused, and a task is its
peer's alone (another peer naming it in `message/send`, `tasks/get` or
`tasks/cancel` gets `Task not found`). The reply door's delivery into the
context lands on its newest open task, appends the agent's message and
completes it; `tasks/get` reads a task back (`historyLength` honoured, 0
omitting); `tasks/cancel` cancels an open task, never a finished one; a
handler throw fails the task loudly; streaming, resubscription and push
notifications are declared unsupported (-32004 / -32003); malformed calls
are the standard JSON-RPC errors; a stranger is 401 with a JSON-RPC body.
Tasks live in the process, bounded at 1000: the oldest finished task goes
first, then the oldest open one is canceled (its waiters woken, the Owner
warned); a restart forgets them. The card names this agent (`A2A_CARD`),
`protocolVersion: 0.3.0`, `preferredTransport: JSONRPC`, a bearer security
scheme, and as its url the door the request came through — the forwarded
scheme and host when a proxy terminating TLS sets them. Out: the
`a2a:<id>` contact kind on `send_message` (`a2aConnector`,
`apps/oni/src/composition/a2a-contacts.ts`): the peer's card is read
once from either well-known path (a GET that fails in any way is no card)
and honoured only when its url shares the declared url's origin — a card
pointing elsewhere is `not_sent` with nothing sent and the Owner warned
where it pointed, since the bearer goes nowhere the Owner did not declare;
one `message/send` (blocking) per tool call under `deliverKeyed` custody
with the peer's own bearer and never a redirect followed (`A2AClient`); a
replayed call keeps its `sent` receipt with no answer (the answer went to
the first). The peer's answer — its message, or its task's status message
and artifacts, bounded at 64 KiB — returns on the tool result as
`response`; a task still `submitted`/`working` is read back (`tasks/get`,
`historyLength: 0`) every 2 s until it leaves those states or the send's
`deadline_ms` (default 30 s, ceiling 5 min) passes, a read that fails
ending the wait with the task as last seen (Warn `a2a task read failed`),
then reported as it stands. Every task that did not complete is named with
its state on `reason` (still working; waiting on the sender for
`input-required`/`auth-required`; ended `failed`/`rejected`/`canceled`),
and `thread` on the result is what a later `reply_to` continues:
`task:<id>` while the task is open (the letter carries `taskId`),
`context:<id>` once it is not or for a message answer (the letter carries
`contextId`; a bare id is a context). A 4xx, a redirect, a JSON-RPC error
and a request that never left are `not_sent`, a 5xx and a lost or
unreadable answer `unknown`, never re-sent; an undeclared, disabled,
url-less, cardless or foreign-carded peer, or an unreadable credential, is
the sender's `not_sent` reason with nothing sent (the detail as a Warn for
the Owner). Not in this lane: a contact's later answer delivered as a
prompt (the door's inbound path is that today — a peer asks and the
Resident answers; the outbound path returns what the peer said within the
wait), streaming, push notifications, file and data parts (passed through,
not read), durable tasks. Receipts: `packages/channels/test/a2a-provider.test.ts`
(the card and its forwarded origin, the roster's bearers, the inbound facts
and the context conversation, ownership, the answer on the newest open
task and its read-back, `historyLength` 0, blocking and the woken second
waiter, cancel, bounded retention, every JSON-RPC error, the failed task),
`test/a2a-client.test.ts` (the card from either path, a failed GET, the
foreign card, one send per key with every receipt, the task read-back),
`test/router-bot-filtered.test.ts` and `test/automation-store.test.ts` (the
a2a exemptions), `test/provider-contract.test.ts`,
`apps/oni/test/a2a-door.test.ts` (one door for two peers, the live
roster, the door going with the last peer),
`apps/oni/test/a2a-contacts.test.ts` (the card, the foreign card, the
send, the replay, every answer shape and task state, the thread, the wait,
its ceiling and the failed read, the bounded answer, every withheld peer),
`test/send-message-contacts.test.ts`, `test/provision-tools.test.ts` (the
url consent), `test/e2e.test.ts` (two peers on the booted daemon: the
named peer's blocking send answered by the Resident, the unnamed peer's
task failed); suites: `packages/channels` 1003 pass, `apps/oni` 1020
pass, 0 fail.

## #1569 Linear provider (lane 9b)

Merged to main as PR #1595 (2026-10-16). Linear
joins the registry as a hand-rolled, Owner-only provider, not an
agent-messenger module: a personal API key is a person's — the Owner's —
so there is no bot account; the bot arm refuses every declaration
(`identity_unsupported`) and the platform is reached through its `owner`
arm alone, mounted as `linear:owner` under the identity axis
(`packages/channels/src/provider/linear/{types,client,surface,provider}.ts`).
The Owner arm's credential is `{ secret, token?, ownerUserId? }` — the
webhook's signing secret, the Owner's personal API key for commenting back
as the Owner (absent leaves the instance ingress-only, loudly: a reply
without a key is a Warn and `not_sent`), and the Owner's user id for when
the key cannot say; with a key the start reads `viewer` and fails closed
when it cannot name its user. Ingress is the workspace webhook at
`/linear/webhook` (`WEBHOOK_ROUTES` in `apps/oni/src/index.ts` maps
`/github/webhook` and `/linear/webhook` to their provider's handler, read
live from the supervisor's table) under the declared posture: `all` reads
every new issue and comment; `mentions_and_dms` reads the comments that
mention the Owner (by user id, or by `@` and either name the key reports —
the platform has no DMs, and a new issue is intake only under `all`);
`none` answers without reading. `Linear-Signature` is checked as the hex
HMAC-SHA256 of the raw body (compared by bytes, in constant time), the
envelope's `webhookTimestamp` must be within a minute of the injected
clock either way (`LINEAR_REPLAY_WINDOW_MS`, the window Linear's own
reference handler allows; a later retry is admitted with the stamp Linear
gives it and refused as stale past the minute), `Linear-Delivery`
deduplicates a redelivery, a new `Issue` (`create`)
reads its title and description, a new `Comment` its body, anything else
is answered 200 with a typed `unsupported_event` observation and a Warn,
and Linear's explicit nulls on absent relations parse. The facts carry
`surface: linear`, `receivedBy: owner`, the new ingress `event: linear`
(`mention` when the Owner is named, with the Owner as the addressee), the
issue's id as both the channel and the thread, the organization as the
workspace, and the actor (else the creator or the commenter) as the
author; the Owner's own actions are never an outside event. The router's
refusal of a message is answered 200 so Linear does not redeliver what the
perimeter refused; a handler failure releases the delivery claim and
answers 500 so Linear redelivers. Out, as the Owner: a comment on the
issue the conversation names through `commentCreate` at
`https://api.linear.app/graphql` (the key rides `Authorization` bare, as
Linear documents), under the reply door's Owner path (`autoReply` and the
outbound grant, else a draft); the comment's own id is derived from the
idempotency key in UUID v4 shape and looked up (`comment(id)`) before
posting, so a re-run after a crash finds the comment it already posted and
reports `sent`, and the retrying `fetchWithRetry` underneath can never
double-post; receipts: `success` → `sent` with the comment id, a GraphQL
refusal whose every `extensions.code` is the platform's own refusal
(`RATELIMITED`, `INVALID_INPUT`, `ENTITY_NOT_FOUND`, `FORBIDDEN`, …) or a
4xx → `not_sent`, any other error, a 5xx or an unreadable answer →
`unknown` with a Warn; a reaction has no comment to land in and is
`not_sent`; a cold send to a person (no conversation) is `rejected` —
Linear comments land on an issue. Not in this lane: issue state changes
out (no tool surface names them), Linear's own mention markup (names are
matched as `@name`), attachments, a bot identity through an OAuth
application (`actor=app`). These corrections — Owner-only, the router's
refusal answered 200, the comment looked up before posting, the
platform's refusal codes and `userError`, nulls and bot actors, the byte
compare, the issue id as the thread, the failed-closed start — came out of
the PR's adversarial review. Receipts:
`packages/channels/test/linear-provider.test.ts` (mentions and `all`
under the posture, the Owner's own actions, nulls, the window, the byte
compare, duplicates and unsupported events, the
router's refusal and a failure, comments out with every receipt and the
re-run's lookup, the keyless instance, the failed-closed start, the
Owner-only arms), `test/provider-contract.test.ts` (the Owner-only
conformance case, webhook-fed), `apps/oni/test/e2e.test.ts` (the
`/linear/webhook` route beside GitHub's); suites: `packages/channels`
982 pass, `apps/oni` 1013 pass, `packages/protocol`
656 pass, 0 fail.

## #1569 Outbound `webhook:` contact (lane 9a)

Merged to main as PR #1594 (2026-10-16).
`send_message` reaches a declared webhook target as a contact kind,
`webhook:<id>`: the letter is POSTed to the target's URL as one JSON body
(`{ id, contact, from, message, replyTo?, sentAt }`) signed with the
target's shared secret in `X-Signature` (`sha256=<hex HMAC-SHA256 of the
raw body>`, the signature the inbound `webhook` provider verifies) and
carrying the idempotency key in `X-Oni-Delivery`. A target is a
`channel:webhook:<id>` instance whose sealed credential names a `url`
(`WebhookCredentials.url`, http or https; absent leaves the declaration
ingress-only as before) beside `id` and its shared secret — `secret`
inline, sealed with the declaration, or `secretRef` to a separately sealed
vault row (the inbound side verifies with the same field, and a
declaration naming neither is refused by the schema). Declaring a url is
an outbound destination, so it takes Owner consent like an Owner instance
or an outbound grant (`channelConsentRequired`): the Resident cannot
declare a target of its own. The target and its secret are read from the
vault at send time (`apps/oni/src/composition/webhook-contacts.ts`,
`webhookContacts` over the instance store, `vaultCredentialReader` and the
sender), so nothing about a target lives outside its declaration; an
undeclared target (or another provider's row), a disabled one, one
without a credential or a url, an unreadable credential or a locked vault
is the sender's `not_sent` reason with nothing posted — a plain word for
the model, the vault's detail as a Warn for the Owner. The sender
(`packages/channels/src/provider/webhook/outbound.ts`,
`createWebhookSender`, exported from the channels index with
`signWebhookBody` and `WebhookCredentials`) runs under the same custody as
every platform send — one physical attempt per idempotency key through
`deliverKeyed`, and that attempt never follows a redirect (`redirect:
manual`; the signed body goes nowhere the Owner did not declare): a 2xx is
`sent` with a textual answer (`text/*`, JSON) carried back, cut at 64 KiB
of bytes; a 5xx came back after the target had the request and may have
acted before failing, so it is `unknown`; any other status, a redirect
included, is the target's refusal, `not_sent`, with its HTTP status as the
reason; a request that never left this host (connection refused, no such
host, a failed TLS handshake) is `not_sent`; a request that may have
landed (the 15 s timeout, a reset after it left) is `unknown`, surfaced to
the Owner once and never re-sent. Custody is the process's own, as for
every driver: a daemon that crashes between the POST and the journaled
receipt holds no memory of the attempt. The connector
(`webhookConnector` in
`apps/oni/src/bundles/messaging/send-message/index.ts`, registered
beside `cli`) keys the attempt by the tool call (`<sessionId>:<callId>`,
so a replayed call is the same attempt) and returns the target's textual
answer on the tool result itself (`ContactOutcome.response`): a webhook is
one request and one response, so the Resident reads the answer where it
reads the receipt, and no reply port is involved — the `ContactReplyPort`
the CLI connector was designed around is still composed nowhere in
production, and this lane stops promising it; `ContactOutcome.status`
gains `unknown`; a reaction to a connector contact is refused. Not in this lane: a delivery route for
Person contacts on the webhook surface (the provider's `deliver`
capability stays false), an HTTP route for the inbound generic `webhook`
provider (it has none today: a declared row mounts a handler nothing
serves, as before this lane), more than one webhook instance mounted per
daemon (surface ids are still per platform), durable custody across a
restart, retries (none, by custody), a contact answer delivered later as a
prompt (that is lane 9c's, with A2A). These corrections — the answer on
the result instead of an uncomposed reply port, 5xx as `unknown`, no
redirects, consent for a url (and none introduced by `secret_rotate`), the
inline secret, the TLS never-left codes, the byte bound and the textual
gate on the answer, the plain reasons — came out of the PR's adversarial
review.
Receipts: `packages/channels/test/webhook-outbound.test.ts` (the signature
the inbound side verifies, one POST per key never followed anywhere with
the textual answer cut at the byte bound, the refusal / redirect /
never-left / 5xx / lost-answer receipts with their Warns, the bounded
request), `packages/channels/test/webhook-provider.test.ts` (the inline
secret on the inbound side), `apps/oni/test/webhook-contacts.test.ts`
(the body and the vault-read target, the inline secret, every `not_sent`
reason with nothing posted and the Owner's detail),
`apps/oni/test/provision-tools.test.ts` (consent for a url, none
introduced by a rotation), `apps/oni/test/send-message-contacts.test.ts`
(the address, the connector's outcomes, the answer on the result),
`packages/channels/test/barrel.test.ts`; suites: `packages/channels`
969 pass, `apps/oni` 1012 pass, 0 fail.

## #1569 Login helpers and the channel wire: the Owner's own sign-in (lane 5b)

Merged to main as PR #1593 (2026-10-16). The Owner's
own account is signed in through the agent-messenger SDK's flows and
declared as the `owner` instance without any credential touching disk on
the CLI side. `packages/channels/src/provider/owner-login.ts` gathers the
four flows as `OwnerLogins` (exported from the channels index as the
`OwnerLogin` port); each lives in its platform's `owner-sdk.ts` seam, the
SDK subpath's one home: `slackOwnerLogin` walks Slack's QR magic login
(the "Sign in on mobile" QR's image address, a mailed confirmation code
asked for through the prompt only when Slack asks) and returns
`{ token, cookie, workspace }`; `discordOwnerLogin` runs the remote-auth QR
(the URL shown through the prompt) and returns the account token with the
user when known; `instagramOwnerLogin` takes username and password, then
the two-factor code or the security-challenge code through the prompts
(`two_factor_required` / `challenge_required` / `login_incomplete` typed
when the SDK offers no way on), and returns the SDK's session state —
the SDK's device file is written into a scratch directory of the login's
own, removed before the session is returned; `kakaoTalkOwnerLogin` takes
email and password, shows the device passcode through the prompt, and
returns `{ oauthToken, userId, deviceUuid, deviceType }`. The SDK's own
credential store is never used. The wire: `Provisioning.ChannelDeclareRequest`
/ `ChannelDeclareRefused` / `ChannelDeclareResponse`
(`packages/protocol/src/provisioning/wire.ts`) is the provision tool's
`channel_add` as a ws frame; `packages/channels/src/websocket.ts` decodes it
(`decodeChannelDeclare`: a malformed frame is answered `invalid_record`
naming its issues, never routed as chat); `apps/oni/src/composition/channel-wire.ts`
(`channelWire`) answers it — only the Owner's socket (the automation wire's
admission: the registered identity, else the ws bootstrap grant) may
declare, `owner_only` otherwise, `store_unconfigured` without provisioning,
the tool's own refusal verbatim as `refused` — through `executeChannelDeclare`
under `channelDomainRevisions`, so the declaration is bound to the instance
revision exactly as an approved tool invocation is and an Owner instance
passes consent by the call itself; `gateway.ts`'s `webSocketCallbacks`
takes the wire as its `channels` port and `index.ts` composes it over the
provisioning port. The CLI: `oni login <slack|discord|instagram|kakaotalk>
[--id channel:<platform>:owner] [--intake mentions_and_dms|all|none]
[--outbound] [--auto-reply] [--print]` (`apps/oni/src/cli/login.ts`)
runs the sign-in, declares the instance over the Owner's socket
(`main.ts`: `ws://$ONI_WS_HOST:$ONI_WS_PORT/ws` with the `auth`
subprotocol from the env file, one frame out and the matching frame back)
and prints its status; `--print` prints `{ provider, identity: "owner",
credential }` instead, for an Owner declaring through the Resident's
provision tool. The CLI fails closed
around the sign-in, out of the PR's adversarial review: the declaration
client is loopback-only and bounded — a refused upgrade, a socket closed
before the answer, the gateway's id-less `error` frame and a silent daemon
are typed errors within 60 s, never a hang with the session in memory; a
declaration the daemon cannot take after the platform counted the sign-in
(a device registration, a single-use code) shows the `--print` payload
instead of losing it, and a failed sign-in declares nothing; the declared
instance's own status decides the exit code (`mounted`, `ready` or
`disabled`); `--auto-reply` needs `--outbound`; a wire-declared row is
`createdBy: owner`; the KakaoTalk sign-in reads the SDK's own
`authenticated` verdict and carries its reason (`passcode_request_failed`,
`bad_credentials`, `choose_device`); the Instagram sign-in ends on a
logged-in user — a checkpoint that closes without one re-runs the password
login once — or not at all. Not in this lane: a live sign-in on any platform (the SDK
flows are faked at the seam), a desktop sign-in, re-login on session
expiry. Receipts: `packages/channels/test/owner-login.test.ts` (the four
flows and their prompts, the Instagram scratch directory gone, the typed
refusals), `test/websocket-channel-declare.test.ts` (decode and the
`invalid_record` answer), `apps/oni/test/cli-login.test.ts` (parsing,
each platform's prompts, the declared request, the refused report,
`--print`, the payload kept when the daemon cannot take the declaration,
the own status deciding the exit, the secret prompts),
`test/channel-wire.test.ts` (the Owner's socket over a booted daemon with
an open vault: a refused bot credential lands nothing, the Owner instance
is declared disabled with its credential sealed as `createdBy: owner`, a
malformed frame is `invalid_record`, a collaborator's socket is
`owner_only`; the CLI's real client against the daemon and against bare
sockets that close, refuse the frame, refuse the token or sit off
loopback), `test/cli.test.ts`; suites: `packages/channels`
963 pass, `apps/oni` 1009 pass, 0 fail.

## #1569 Owner-only platforms: Instagram and KakaoTalk through the Owner's account (lane 7)

Merged to main as PR #1592 (2026-10-16). Two
platforms with no bot account join the registry: their bot arm admits no
credential and never constructs (a bot declaration is `identity_unsupported`
naming `identity: owner`), and each is reached through its `owner` arm alone.
Instagram (`provider/instagram/`, `agent-messenger/instagram` only in
`owner-sdk.ts`): the vault-opened session state (the SDK's own session JSON
with its cookies, as the login helper will seal it) is restored through a
file the surface writes with mode 0600, loads and removes at once, then
clears the SDK's session path so nothing is persisted — the vault stays the
one copy; the hybrid inbox listener (realtime, polling fallback) runs under
`listenerCustody`: a realtime failure at boot is the one pre-connected error
the SDK recovers from on its own (custody's `recoverableBeforeConnected`;
polling's `connected` settles the start, a refused inbox read or any second
error fails it), and because the SDK folds every refused inbox read — a
revoked session and an outage alike — into one `inbox_error` with no
reason, a streak of them as long as `RECONNECT_ATTEMPT_BOUND` with no
message or reconnect between is the typed dead surface (the poller never
re-emits `connected`, so it would otherwise poll a dead session forever);
every inbox message is a DM to the Owner (`mentions_and_dms` and `all` read the whole
inbox; the account's own messages never count); delivery posts into the
person's thread, or cold into the direct thread with them; `rate_limited`
and `send_failed` are proven `not_sent`, a lost response is `unknown`; the
platform offers no media upload, reactions or typing to the account.
KakaoTalk (`provider/kakaotalk/`, `agent-messenger/kakaotalk` only in
`owner-sdk.ts`): the account logs in in memory (a registered device's OAuth
token, user id, device uuid) and its profile's nickname is what a mention
names; the LOCO push listener runs under custody, and because the SDK's
listener never reopens a dropped session (and still counts itself running
after one, so a bare `start()` is a no-op) the surface stops and restarts
it under a bounded backoff through the injected run port, from a drop and
from a refused reopen's `error` alike, with a session kicked by another
device terminal; a chat's shape is read once through the SDK (the account
plus one person is a direct chat; a failed lookup counts as a group), a
direct chat is a DM, and a group message is intake only when it names
`@nickname`; delivery posts into the conversation's chat or into the direct
chat the person last wrote from (a stranger the account never chatted with
cannot be reached cold), `success: false` and the preflight codes are
`not_sent`, the SDK's synthetic status −1 (the socket closed before the
reply: the WRITE may have landed) and a thrown send are `unknown` — the SDK
re-runs a thrown send once when the session died under it — and an
`unknown` key is never re-sent; typing rides the same chats. The SDK
keeps the LOCO sync state (no secret) under `AGENT_MESSENGER_CONFIG_DIR`.
The reply door through an Owner instance (`OwnerPosture.autoReply`, default
false): a conversation reachable only through `<platform>:owner` is answered
as the Owner when the declaration auto-replies (and grants outbound);
otherwise the reply door refuses `message.resident.reply_draft` — the new
Table B check `reply_auto` (`Gateway.RuleTableB`, gate `replyAutoAllowed`,
policy row) — and the Resident's answer stays a draft the Owner sends; a bot
instance of the surface always answers as the bot. `ReplyPorts.autoReplies`,
`GatewayRouterPorts.messaging.autoReplies` and the app's
`OutboundMessaging.autoReplies` carry the set the supervisor keeps with the
routes (`BuiltChannel.autoReply`, from the posture and the outbound grant).
The reply door's DM binding keeps its chat: `replyConversation` folds a DM
to `{ channelId }` (unthreaded, unquoted), so a KakaoTalk or Instagram DM
is answered in the chat the binding recorded rather than from the
instance's memory of who last wrote, which a re-declaration or a restart
empties; Slack, Discord and Telegram post into the same DM channel either
way. These five corrections (Kakao reopen, Kakao closed-socket send,
Instagram boot handover, Instagram dead-session evidence, DM binding) came
out of the PR's adversarial review against the pinned SDK.
Not in this lane: the login helpers (lane 5b: Instagram password/2FA,
KakaoTalk passcode), surfacing a draft to the Owner beyond the refusal the
Resident sees, group-chat mentions by anything but the nickname. Receipts:
`packages/channels/test/instagram-owner.test.ts` (session restore and
cleanup, no account fails start, inbox intake and own echo, media
attachments, `none`/`all`, thread and cold delivery with the three receipts,
the realtime-to-polling handover at boot, the refused-read streak beside
custody's unreachable alarm, refused boot reads),
`packages/channels/test/kakaotalk-owner.test.ts` (login/profile/listener,
DM and `@nickname` intake with the chat shape read once, unknown chat as a
group, `all`/`none`, conversation and direct-chat delivery, cold stranger
refused, typing, receipts, reopen on drop as stop-then-start, a refused
reopen retried, kicked dead, refused start, the closed-socket send unknown
and never re-sent),
`test/provider-contract.test.ts` (Owner-only conformance cases),
`test/provider-owner-arm.test.ts`, `test/channel-band-boundary.test.ts`,
`test/router/messaging/composition.test.ts` (draft, auto-reply, bot
precedence, the DM answered in its chat), `test/sdk-listener.test.ts`
(the recoverable pre-connected error), `apps/oni/test/reply-door.test.ts`
(the DM binding's chat), `apps/oni/test/identity-instances.test.ts` (Owner-only
rows, `autoReply` gated by outbound, the supervisor's auto-reply set),
`apps/oni/test/owner-policy.test.ts`; suites: `packages/channels`
956 pass, `apps/oni` 998 pass, 0 fail.

## #1569 Owner intake: the Owner instance reads what the account sees (lane 6)

Merged to main as PR #1591 (2026-10-16). An `identity:
owner` instance now listens as well as sends. The provider contract's
`OwnerArm` declares `listen` and takes an `OwnerPosture` instead of the empty
config: the declaration's `settings.intake` is `mentions_and_dms` (default:
a DM to the Owner, a mention of the Owner, or a reaction to the Owner's own
message), `all` (everything the account can see, the bot posture) or `none`
(send-only, no listener). Slack's Owner surface (`provider/slack/owner.ts`)
opens the user SDK's RTM listener through `owner-sdk.ts` under
`listenerCustody` (settles on hello, fails start on an error before it; a
revoked session after hello is a typed dead surface — `isSlackTerminal`
reads the error shape so the user SDK's `SlackError` counts and custody
stops the SDK's otherwise endless reopen); RTM frames (no `channel_type`; a
`D…` channel is a DM) go through `SlackNormalizer` with the Owner's own user
id as self, so the account's own messages are never an outside event and a
mention of the Owner is `event: mention`; what the posture admits is handed
off with `receivedBy: owner`. Discord gains its Owner arm
(`provider/discord/{owner-sdk,owner}.ts`; `agent-messenger/discord` has its
one home in `owner-sdk.ts`): the account logs in, `/users/@me` verifies it,
the user gateway listener runs under the same custody as the bot's
(`failOnCloseBeforeConnected: false`, non-recoverable close codes terminal),
`DiscordNormalizer` with the Owner's id as self; delivery, reactions and
typing ride the package's REST client under the bare account token
(`DiscordClient` `auth: "user"`, one physical attempt per idempotency key;
`discord/delivery.ts` is the one delivery path both instances share). Reactions
are not intake on either platform: the router routes a reaction only as the
answer to a request (`reaction_unrouted` is the one layer), and nothing the
Owner's account receives is one. `Gateway.IngressFacts.receivedBy`
(optional; absent is the bot) records the instance that observed a message
and gives the Owner's copy its own inbound id (`…:owner`), so the bot's
recorded refusal of the same message is never replayed against it.
Addressing is a fact of the message, not of the observer: the platform's
channel grant carries `ownerIntake` while an Owner instance reads it, and
`ingressInput` treats a mention of the registered Owner (the Owner Person's
endpoint on that platform) as addressed to the Resident under such a grant,
whichever instance observed it — a mention-only grant admits both copies,
and the Slack Owner surface opens no thread root for a top-level Owner
mention so both copies bind to the same conversation. The app:
`ChannelComponent.listens` (every bot row; an Owner row only when its arm
listens under a posture other than `none`); the platform's one ingress
grant is held by every reading instance and revoked with the last
(`provision/supervisor.ts`), re-registered whenever the readers change at
the least tier any current reader declares (fail-closed) and naming the
Owner reader; `channel_add` validates an Owner row's settings as its
posture (a bot row still refuses any knob) and a re-declaration that omits
`settings` keeps the stored ones; an Owner row without `grant.outbound`
mounts neither a delivery nor a typing route; and `inboundOnce`
(`packages/channels` `support/inbound-once.ts`, wrapped around the app's
routing handler) hands one physical platform message to routing once when
both the bot and the Owner instance observe it — a copy arriving while the
other copy is in flight waits for that outcome and carries the message
only if the first copy was refused. Upgrade note: an Owner row declared
before this lane (empty `settings`) now reads under the default posture;
declare `settings.intake: none` to keep it send-only — every Owner-row
declaration passes Owner consent. The reply door answers an Owner-received
DM as the bot in the bot's own DM with that person, and an Owner-received
channel mention in the channel when the bot is a member (else `not_sent`;
the Resident may send `as: owner` on explicit instruction). Not in this
lane: Instagram and KakaoTalk (lane 7), the login helper (lane 5b); the
Telegram Owner instance stays blocked on the SDK (no `./telegram` export).
Receipts:
`packages/channels/test/slack-owner.test.ts` (listener under the default
posture, DM/mention intake with `receivedBy` through a sentinel ordering,
own echo never intake, no thread root for a top-level Owner mention,
reactions not intake, `all`, repeated frame once, refused connect fails
start, revoked session dead, no handler no listener),
`packages/channels/test/discord-owner.test.ts` (login, `/users/@me` through
the package's client, DM and mention intake, `all`/`none`, error before
READY and non-recoverable close, REST and typing under the bare token with
one attempt per key), `test/provider-owner-arm.test.ts` (both arms listen;
the posture schema), `test/inbound-once.test.ts` (admitted copy dropped,
refused copy carried, in-flight copy waits), `test/router/mention-only.test.ts`
(an Owner mention is addressed under an `ownerIntake` grant whichever copy
arrives, filtered without one; the Owner's copy has its own inbound id),
`test/channel-band-boundary.test.ts` (`agent-messenger/discord` home),
`apps/oni/test/identity-instances.test.ts` (posture → `listens`, the
one grant row re-registered at the least reader tier naming the Owner
reader, an Owner-only reader registers the grant),
`apps/oni/test/provision-tools.test.ts` (posture knobs under the
resolved identity, sticky settings on re-declaration); suites:
`packages/channels` 922 pass, `apps/oni` 996 pass, 0 fail.

## #1569 the identity axis and the Slack Owner instance (PR 5 of the epic)

Merged to main as PR #1590 (2026-10-16). A mounted
channel is one `(platform, identity)` instance, `Channel.Identity` being
`bot | owner`: `Provisioning.ChannelInstance.identity` (default `bot`, so
every row declared before the axis is a bot instance) names it, and the
messenger surfaces mount under the instance id (`slack:bot`, `discord:bot`,
`telegram:bot`; the identity-less ws, github and webhook surfaces keep their
platform id and are reached as the bot). Delivery and typing routes key by
instance surface id; the ingress trusted-channel grant and the webhook path
key by the platform the inbound facts name, and only a bot instance
registers an ingress grant (`provision/supervisor.ts`) — the Owner listener
and its posture are lane 6. The provider contract gains an optional `owner`
arm (`OwnerArm`: the account-session credential schema, operator
preconditions, deliver/react/media/typing capabilities and `create`);
Slack's arm (`provider/slack/{owner-sdk,owner}.ts`, `agent-messenger/slack`
imported only by `owner-sdk.ts`) logs the Owner's own account in with the
vault-opened `{token xoxc, cookie d}`, pins the inner web client to one
attempt, verifies the identity at start, and delivers letters and
reactions as the Owner (DM through `conversations.open`, threads, no media
upload — reference lines stay in the text); it mounts a delivery route only
when the declaration's `grant.outbound` is true. `classifySlackFailure` and
`isSettledState` read both SDK error shapes (`SlackBotError`, the user
SDK's `SlackError` whose own `ok:false` check names the Slack error as the
code). The send door carries the identity: `send_message` contacts take
`as: bot | owner` (default bot) → `Gateway.MessageTarget.identity` →
`Gateway.DeliveryTarget.identity` → the `<channel>:<identity>` route
(`router/index.ts`, bare platform fallback for identity-less surfaces);
`messaging.sent` journals `identity`; the reply door always leaves as the
bot. `as: owner` is admitted only when the app's authenticated
`ownerOrigin` fact holds — `prepareMessage` reads the open turn's consumed
deliveries off the sender's ledger and the actor registry (`trustTier:
owner`), never message text — and a `<channel>:owner` route is mounted;
otherwise `authorizeSend` refuses with the new `identity_not_granted`
denial, projected onto the new `identity` policy check under
`message.resident.identity_not_granted` (the grant row keeps its own
verdict). The send-admission signature keeps the bot identity implicit, so
every admission recorded before the axis replays equal; an Owner send is
signed as such. `provision channel_add` takes `identity` and `outbound`
(the owner arm validates the credential; a platform without an arm reports
`identity_unsupported`; `outbound` lands on the instance's `grant`). An
Owner instance, and any change to its outbound grant, is the Owner's call:
`provisionApproval` suspends the invocation for Owner approval and
`executeChannelDeclare` lands the row only on the consented path, bound to
the instance revision the consent was given against (the contact_add
pattern; the gate's `when` cannot see tool arguments, so the hook is the
one layer). A re-declaration keeps the stored identity (`identity` is
optional on the wire; a fresh row is the bot), and `secret_rotate`
validates each consumer under its own arm's schema. The `ownerOrigin` fold
lets the newest external delivery decide: a sender the registry does not
hold (no actor) decides `false` even when an older Owner prompt shares the
turn. The Slack Owner surface binds the authenticated workspace at start
and refuses (`not_sent`, nothing attempted) an endpoint of another
workspace. Mounted stages report their instance surface
(`slack:bot`/`slack:owner`) and `provision status` lists the Owner arm's
preconditions under it. Conformance snapshots regenerated (additive). Not in this PR: the QR-login
CLI helper that seals the Owner session into the vault (its own branch
next), the Owner listener (lane 6). Receipts:
`packages/channels/test/slack-owner.test.ts` (login/pin/identity, DM open,
thread, reference-line media, reaction swap with settled states, failure
classification over both error shapes, the owner arm's runtime),
`test/provider-owner-arm.test.ts`, `test/provider-contract.test.ts`
(instance ids), `test/channel-band-boundary.test.ts` (`agent-messenger/slack`
home), `test/router/messaging/identity.test.ts` (bot default and bare
platform fallback, `as: owner` journaled through `slack:owner`, the three
`identity_not_granted` refusals before transport, a bot send never leaving
through the Owner's account), `apps/oni/test/identity-door.test.ts`
(the real gateway: Owner-origin turn + outbound-granted instance, non-Owner
turn, no Owner instance, no identity, the tool's `as`),
`apps/oni/test/identity-instances.test.ts` (declared Owner rows,
`identity_unsupported`, outbound gating the route, the supervisor keying
grant/webhook by platform and routes by instance, `channel_add` identity),
`apps/oni/test/provision-tools.test.ts` (Owner consent for an Owner
instance and its grant with the revision CAS, sticky identity on
re-declaration, Owner-arm rotation, instance-surface preconditions),
`apps/oni/test/identity-door.test.ts` (the newest external delivery
decides), `packages/channels/test/slack-owner.test.ts` (another workspace's
endpoint refused); suites on the stacked tree: `packages/channels` 899 pass,
`packages/protocol` 656 pass, `packages/agent` 1530 pass, `apps/oni`
991 pass, 0 fail each.

## #1569 the reply door (PR 4 of the epic)

Merged to main as PR #1589 (2026-10-16). The ordinary answer
to the conversation that prompted a Resident turn is no longer a synthesized
`send_message` dispatch (#1482) but the gateway's own reply door. The wire
carries one new target kind, `Gateway.OriginTarget` `{kind: "origin",
inReplyTo}` on `Gateway.Send` only — the model-facing tool never composes
it. The app (`composition/message-session.ts` `prepareMessage`) folds a
`ConversationBinding` (surface, external id, actor id, workspace, channel,
message, DM flag, thread) from the named prompt's recorded external origin,
read off the sender's own ledger: a prompt another session received, or an
id that never was a channel prompt, binds nothing. The router
(`packages/channels/src/router/messaging/reply.ts`) verifies before policy
that the sender is the session it routed the prompt to — it owns the
ingress surface key the inbound claimed (`stores.surfaceKeys.lookup(key)
=== sender.id`), or the automation ledger recorded it as that inbound's
routed target (`stores.automations.decisions(inboundId)[0].target`, since
an Owner automation's target never claims the key) — and that the surface
has a delivery route; the binding verdict rides the existing `actor_send` check
under the new compiled row `message.resident.reply_unbound` (targetKind
`origin`), while `message.child.reply` is an unconditional `type` denial (a
child has no reply door). Execution records one
budget-free admission fact per message id (`admitReply`: a replay with the
same content matches, different content is a typed `SendAdmissionConflict`)
inside the ledger transaction, then delivers through the surface's route
into the channel or thread the person wrote in (a DM directly) with the
message id as idempotency key, and publishes `messaging.sent` with
`grantId: binding:<surface key>`. The resident bundle
(`bundles/resident/index.ts`) sends the turn's result (or reported error)
through its `gateway` door as that origin send, under the turn's executor
(`Core.withExecutor`, the invocation scope a tool body carries — the
gateway's session `run` port reads `currentExecutor()`; the #1506 ack
reactions, which had been calling the door outside any invocation and
silently failing, ride the same scope now); a refusal or a failed send
never fails the turn. A `send_message` letter the model addresses to the
prompting conversation itself (same contact, same or unspecified surface,
same chat and thread, or a DM when the prompt was one) is refused in the
tool wave as `same_conversation` before it reaches the gateway; reactions
and letters to another conversation, channel or person pass, and the reply
still goes — the #1482 "suppressed when the model already reached that
contact" rule is gone with the tool row. Deleted: the reply-grant
materialization and its authority (`router/messaging/reply-grant.ts`,
scoped-grant arms of `grant.ts`/`authorize.ts`, the `replyGrantRules`
port, `Gateway.ReplyGrantRule`, `ruleId`/`replyScope` on
`Gateway.SenderTargetGrant`, `Storage.ReplyGrantSubAdapter`), the
`reply-grant` store and its SQLite adapter, the `reply_grant` table and two
indexes (dropped on reopen; `schema-roundtrip` keeps the legacy DDL bytes
for every other table), `createReplyGrantStore` from the barrel, and the
tests `reply-grant`, `reply-grant-durable`, `reply-scope-guard`,
`scoped-grant`, `store/reply-grant/persistence` and the reply arm of
`social-budget`. Kept byte-frozen: the `reply_grant.endpoint.*` fact
prefixes on `route.decided` (`router/endpoint-facts.ts`), now the
initiator-endpoint pin. The schema snapshot (`script/conformance/
schema-snapshot.json`) was regenerated for the removed contracts — that
diff is the Owner's sign-off surface. Not in this PR: the Owner-draft arm
for conversations only the Owner instance can reach (lane 5+). Receipts:
`packages/channels/test/router/messaging/composition.test.ts` (routed
session answers in-channel with the binding grant id and no debit; another
session, an unknown prompt and a route-less surface refused before
transport; receipt values; admission replay/conflict),
`apps/oni/test/reply-door.test.ts` (real gateway: binding fold, key
ownership, `reply_unbound`, `child.reply`),
`apps/oni/test/resident-reply-to-origin.test.ts` (origin send naming
the prompt, refusal/throw never fails the turn, `same_conversation` refusal
with the reply still sent, other-conversation and reaction sends pass),
`packages/protocol/test/gateway.test.ts` (grant shape),
`packages/channels/test/router/endpoint-facts.test.ts` (frozen prefixes,
malformed facts read as none). Adversarial review of the first cut
(3 lenses × 2 refuters, 16 confirmed) added: the reply and the #1506
reactions under `Core.withExecutor` with an end-to-end receipt driving the
resident's own runner against the real gateway (`reply-door.test.ts`), the
automation-ledger arm of the binding check with its composition pin, the
`workspaceId` the resident's origin parser now accepts (a Slack/Discord
prompt had lost its reactions, threaded typing and the `same_conversation`
refusal), the DM arm of `same_conversation` (a letter naming the DM chat
itself), DM/thread arms pinned on both routers, the budget exemption, the
router-side ownership refusal, post-commit progress retention
(`message-ingest`), and `Gateway.OriginTarget` exported and pinned in the
schema snapshot and `gateway.test.ts`. Channels suite 866 pass, protocol
622 pass, app suite 907 pass.

## #1569 messaging on the agent-messenger SDK — Telegram bot long-poll (PR 3 of the epic)

Merged to main as PR #1588 (2026-10-16). Telegram
ingest is the SDK's `TelegramBotListener` (`agent-messenger/telegrambot`,
imported only by `packages/channels/src/provider/telegram/sdk.ts`): it runs
`deleteWebhook` and `getMe`, emits `connected` with the bot user the surface
binds its normalizer to, long-polls `getUpdates` with the consumed classes
(`message`, `message_reaction`, `callback_query` on the first poll's
`allowed_updates`) and backs off on poll errors. Each failed poll is a
cause-less `disconnected` the custody wrapper counts: `RECONNECT_ATTEMPT_BOUND`
of them without a reconnect is one Operational Error (`unreachable`), and
because the SDK never re-emits `connected` after its first `getMe` the
streak alarms once per process — the deleted poller's per-cycle Warn with
the error cause has no SDK equivalent. `message_reaction` is not a typed
SDK event, so every update is read off the raw `telegram_update` event
through the surface's own `TelegramUpdateSchema`; a message, reaction and
callback are each handed off once, the callback answered through the raw
client first (a refused answer warns and still delivers; an answer still in
flight at `stop()` still hands off afterwards, since the SDK has already
confirmed the update server-side and dropping it would lose the tap — the
same shape as Discord's interaction ack). The SDK advances
its offset before dispatch: a failed handoff is an Operational Error with
the dedupe claim released, not a platform redelivery — the #1505
"checkpoint after handoff" receipt narrows to the same at-least-once
remainder Slack keeps after its ack. REST stays on the package's own
`TelegramClient` over `fetch-retry` (the SDK client re-sends on network and
5xx up to three times with no off switch, takes media as paths or URLs, and
has no `sendChatAction`/`answerCallbackQuery`); its `getMe`/`getUpdates`
were deleted with the poller. A terminal code (`unauthorized`, `conflict`)
is a typed dead surface. Deleted: `provider/telegram/poller.ts`,
`support/schedule.ts` (`RECONNECT_ATTEMPT_BOUND` now lives in
`support/sdk-listener.ts`; no reconnect schedule remains — every SDK
listener owns its backoff), tests `telegram-poller`, `poller-interrupt`,
`backoff-schedule`, `native-reconnect`, the fetch-driven Telegram arm of
`telegram-dedupe` and the `getUpdates` pin of `telegram-postback-client`.
Receipts: `test/telegram-surface.test.ts` (login, allowed updates, identity
on connected, self-echo, reaction, cross-chat ids, media-only update,
callback ack-then-handoff and refused answer, late handoff after stop,
malformed update, failed-handoff release awaited on its Error, error before
connected, poll-failure streak reported once without a stop, terminal code,
provider seam), `test/telegram-sdk.test.ts` (real seam, update classes, the
real listener's first poll carries offset 0 and the allowed updates, real
listener error on refused start, terminal codes), `telegram-media`/`telegram-markdown-send`/
`telegram-postback-client` (raw REST pins), `channel-band-boundary`
(`agent-messenger/telegrambot` → `telegram/sdk.ts`); channels suite 893 pass.

## #1569 messaging on the agent-messenger SDK — Discord bot gateway (PR 2 of the epic)

Merged to main as PR #1587 (2026-10-16). The Discord
gateway is the SDK's `DiscordBotListener` (`agent-messenger/discordbot`, imported
only by `packages/channels/src/provider/discord/sdk.ts`): identify with the
consumed intents (`DISCORD_INTENTS`, MESSAGE CONTENT included), resume,
heartbeats and reconnects are the SDK's; READY binds the bot identity the
normalizer filters and keys on, on the first connect and on every resume.
REST stays on the package's own `DiscordClient` over `fetch-retry` because
the SDK client re-sends on network errors and 5xx up to three times with no
option to disable it, and custody allows one physical attempt per key:
text, media, reactions, typing, DM-channel creation and the interaction ack
(`type 6` before handoff) are unchanged. The SDK dispatch overwrites `type`
with the dispatch name, so `DiscordInteractionSchema` no longer keys on the
numeric interaction type: a component tap is recognized by `data.custom_id`
and the normalizer tells an interaction by its callback `token`. New
`packages/channels/src/support/sdk-listener.ts` (`listenerCustody`) is the
one lifecycle wrapper for SDK listeners, back-applied to Slack: `error` is
subscribed before `start()`; start settles on the first `connected` and
fails (stopping the listener) on an error before it or on the SDK's own
`start()` rejection, and on a close before it only where the SDK would not
notice one (`failOnCloseBeforeConnected`: Slack's `start()` resolves before
hello, Discord's stays pending across a recoverable pre-READY close and
rejects on its connect timeout); a close or a refused reopen after that is
an Info with the streak count, a reconnect resets it, and
`RECONNECT_ATTEMPT_BOUND` consecutive failures without a reconnect publish
one Operational Error per streak (`unreachable`) while the SDK's bounded
backoff keeps trying — custody does not stop a listener that may still
recover, because nothing in the app remounts a stopped surface. A
`terminal` predicate names the errors after which the SDK listener has
stopped itself (Slack: `disconnect_terminal` and its fatal auth codes,
`isSlackTerminal`; Discord: a non-recoverable close code), turning them
into a typed dead surface (listener stopped, Operational Error) instead of
a Warn — this closes the limitation recorded under PR 1. The Slack seam's
`appsConnectionsOpen`/`openDm` fold the `@slack/web-api` throw (a plain
Error with `code: slack_webapi_platform_error` and `data.error`) into
`SlackBotError`: the socket-url refusal carries the Slack error string as
its code, which is what the SDK listener's fatal set and `isSlackTerminal`
read, so a token revoked after hello is dead rather than an endless reopen
streak. Deleted:
`provider/discord/{gateway,heartbeat}.ts`, `support/socket-shell.ts`,
`DiscordClient.fetchGatewayUrl` and `DiscordGatewayFetchError`, the gateway
schemas in `discord/types.ts`, and the tests `discord-gateway`,
`discord-facts-startup`, `heartbeat-watchdog`, `socket-shell-interrupt`,
`supervisor-bounce` plus the Discord arm of `native-reconnect`.
`support/schedule.ts` stayed for the Telegram poller until PR 3 (above)
deleted both. Receipts:
`test/sdk-listener.test.ts` (both close-before-connected policies, SDK
start rejection, close and reopen-error streaks reported once without a
stop, terminal errors), `test/discord-surface.test.ts` (READY binding,
intents, self-echo, reaction, ack-before-handoff ordering and warn-drop,
non-component interactions ignored, malformed dispatch, error before READY,
pre-READY close left to the SDK, SDK start rejection, resume rebinding with
the old id delivered and the new id filtered), `discord-audit`,
`discord-media` (raw REST pins unchanged), `provider-contract`,
`channel-band-boundary` (`agent-messenger/discordbot` → `discord/sdk.ts`),
`discord-sdk` (real seam, intents pinned onto the real listener, start
rejects on a refused connect), `slack-sdk` (web-api throw folded into the
Slack error code, `isSlackTerminal` table), `slack-surface` (revoked token
on reopen = dead, refused-reopen streak = one unreachable Error); channels
suite 885 pass.

## #1569 messaging on the agent-messenger SDK — Slack bot (PR 1 of the epic)

Merged to main as PR #1586 (2026-10-16). The Slack
provider's transport is `agent-messenger@2.39.0` (`agent-messenger/slackbot`,
pinned exactly): `packages/channels/src/provider/slack/sdk.ts` names the SDK
slice the surface speaks (`SlackBotApi`, `SlackBotEvents`, the `SlackSdk`
construction seam), `singleAttempt` pins the SDK's inner `@slack/web-api`
client to zero retries and an immediate typed rate-limit refusal (its default
ten-retries-in-thirty-minutes policy would re-post after a reset or 5xx the
platform may already have accepted), and `classifySlackFailure` reads the
forwarded `slack_webapi_*` codes into `rejected | not_connected | uncertain`.
The surface logs in with the vault's bot token through `login({ token })`
(the SDK's on-disk credential store is never used), reads identity from
`testAuth`, acks every Socket Mode envelope before dispatch through the SDK's
`slack_event` / `interactive` / `slash_commands` events, starts on the first
hello and fails start on an error or a close before it (the SDK's own hello
timeout included), opens the bot's direct channel first for a
conversation-less delivery (`openDm` on the seam over the pinned inner
client: uploads and reactions take a channel id and refuse a bare user id; a
refused open is a proven `not_sent`) or posts into `conversation.channelId`
threaded
under `threadId ?? replyToMessageId`, uploads through `uploadFile`, reacts
through `addReaction`/`removeReaction` with `already_reacted`/`no_reaction`
read as settled, and seeds thread sessions from `getThreadReplies`
(integration posts labelled `bot <username>`). Deleted: `provider/slack/client.ts`,
`provider/slack/socket.ts`, the `SocketEnvelopeSchema`, and the Socket Mode
protocol-pin tests (`slack-socket`, `slack-client`); Slack left the
fetch-boundary delivery suites (`delivery-chunks`, `delivery-receipts`,
`delivery-reconciliation`, `native-reconnect`) and its chunk, receipt and
custody evidence is pinned over the SDK error shapes in `slack-surface.test.ts`.
`channel-band-boundary.test.ts` admits each SDK subpath in exactly one home
(`agent-messenger/slackbot` → `src/provider/slack/sdk.ts`); a surface, the
router or a store importing the SDK is a band violation, and the real
`SlackBotListener` is pinned to emit `error` (not swallow) on a fatal auth code
during start. The seam's `appsConnectionsOpen` override builds the app
token its own pinned web client from the bot client's class (`appClient`;
the SDK's own builds a fresh web client per attempt under the ten-retries
policy, which would hold `start()` for up to half an hour on a network
failure) — the first live run (#1600, 2026-10-18) found the earlier form,
which passed the app token as a per-call argument to the bot client,
refused `invalid_auth` by Slack, since `apps.connections.open` reads the
app-level token from the Authorization header that `@slack/web-api` fills
from the client's own token. `classifySlackFailure` treats only the
SDK's pre-request refusals (`missing_token`, `invalid_token_type`,
`not_authenticated`, `missing_app_token`, `invalid_app_token_type`), platform
`ok:false` and the typed rate-limit refusal as `rejected`; `file_not_found`
(raised after a completed share) and `unknown_error` keep custody as
`unknown`. Known limitation closed by the Discord PR's custody wrapper: a
fatal post-hello stop (`disconnect_terminal`, a token revoked on re-open)
leaves the SDK listener stopped and is reported as a Warn only. Capabilities are unchanged (`typing: false` until the `assistant:write`
scope is declared). Discord, Telegram, GitHub and webhook are untouched; the
identity axis, the Owner instance and the reply-door split are later PRs of
#1569. Receipts: `packages/channels/test/{slack-sdk,slack-surface,slack-media}.test.ts`,
`provider-contract.test.ts`, `channel-band-boundary.test.ts`; channels suite 877 pass.

## #1557 capacity rows and host-owned leases (epic #1554, rung E)

On `feat/1557-machine-capacity` (2026-10-15, base `dc32b01a3`, PR #1580).
`packages/protocol` adds strict `Machine.CapacityRows` (tag rows apply in
array order, an exact machine row overrides their fields, duplicate
selectors are rejected, selectors for future enrollments are allowed, and
unknown slot capacity is `null` rather than a fabricated CPU count), the
decision-credit `LeaseRefusal` schema and the `machine.lease_refused` bus
fact. `packages/machines` is the one lease owner: `createMachineHost`
validates the rows before binding, `host.capacity()` resolves each member to
`{ machineId, slots, memReserveBytes, classCosts }`, and `host.place` reuses
the protocol fold while atomically reserving credit — weighted job cost,
whole-member exclusive claims, memory-reserve admission from the latest
non-stale report (stale reports supply no memory evidence), idle expiry on
the host's injected `now` and scheduler, retained named-terminal claims and
detach cleanup. A placed outcome carries a host-issued
`{ id, machineId, signal, renewWhile, renewPtyWhile, release }` lease so
admission, active credit, renewal and invalidation stay under one owner.
`packages/codemode` keeps only opaque lease references, translates
`machine_saturated` and `lease_expired`, and holds the lease across nested
execution; it owns no placement fold, counters, scheduler or TTL. The app
reads optional `ONI_MACHINES_CAPACITY` JSON, injects capacity and the
one Effect-clock scheduler (`composition/platform.ts`) into the host with a
scope finalizer for pending timers, and codemode receives no clocks or
schedulers. No new tool, wire method, store mechanic, capacity transport
constant or app DB mechanics; the exact-line session-writer pin moved with
the composition insertion.
Receipts on `998482b72` (base `dc32b01a3`): lead final chain on `998482b72` (base `dc32b01a3`): 13/13 gates exit 0 (build, check-types, lint, lint:tools, lint:docs, check-written-types, topology, deps, import cycles, dead exports, journal writers, tsconfig inheritance, effect boundaries); `check-deps-agent-bands.test.ts` 45/0; app machine/codemode/self/provision/config/code-mode-e2e suites 246/0; protocol 653/0; machines 282/0 (1 skip); codemode 53 pass, 1 fail = `browser.test.ts` host-only Chromium/playwright precondition; `check-patch-coverage --base origin/main` all changed executable lines covered (package lcov + `script/coverage/lcov.info` from the check-deps suites run in `script/`, 124/0). Lane receipts on `8af46f845` (base `5dffade3b`): app 63/0, machines 282/0, codemode 61/0, protocol 653/0, patch coverage all covered. Lead self-verify fix: the app's host scheduler now rides `effectScheduler` with a scope finalizer instead of an inline `setTimeout` (zero raw timers remain in `apps/oni/src`).

## #1556 pooled placement, pick-time leases and one `machine()` (epic #1554, rung B)

On `feat/1556-machine-place` (2026-10-15, base `ae351e71a`, PR #1576).
`packages/protocol` adds the pure fold `Machine.place(request, members)`:
`PlacementRequest` is a tag, optional required capabilities and
`prefer: spread | pack | exclusive | { sticky }`; the outcome is `placed`,
`no_member`, `all_stale` or `machine_saturated`. Stale members are skipped,
members with reported capacity rank before members without it, sticky keys
hash over the known-capacity members first, and ties are deterministic.
`packages/codemode` keeps one in-memory lease per tag pick: the injected
scheduler expires it after the idle TTL (default 10 s), every handle call
renews it, an expired retained handle fails with the typed `lease_expired`,
and a pick without an injected scheduler fails with
`lease_scheduler_missing` instead of a never-expiring lease. `cell.run`
targets the configured `self` machine and refuses `kernel_not_available`
when that machine lacks `kernel.py`; the first enrolled machine is no longer
implied. The prelude has ONE `machine(id=None, *, tag=None, prefer="spread",
requires=None)`: an exact id or a host-picked member by tag, the same handle
type with `.id`; fan-out stays `parallel()`, and the earlier prelude names
are gone. The app shares one Effect-clock scheduler between the `#1555`
machine reports and the leases, passes its own machine id as `self`, and
binds the composed runner into the self daemon so a loopback `cell.run`
reaches the same per-tenant interpreter; the daemon's runner proxy never
closes that interpreter — codemode's own `close()` remains the single owner.
Receipts on the rebased head (base `ae351e71a`): lead gate chain 14/14 exit 0 (install, build, check-types, lint, lint:tools, lint:docs, check-written-types, topology, deps, import cycles, dead exports, journal writers, tsconfig inheritance, effect boundaries); protocol 635 pass / 0 fail; codemode 44 pass / 1 fail where the one failure is the host-only `browser.test.ts` (no Playwright on the lead's machine; CI provides it); the eleven app machine/codemode suites 61 pass / 0 fail including `code-mode-e2e`; `check-patch-coverage --base origin/main` reports every changed executable line covered.

## #1559 managed machine enrollment and the Machines place (epic #1554, rung G)

On `feat/1559-machine-provision` (2026-10-15, base `ae351e71a`, PR #1579).
`provision` gains `machine_add`, `machine_remove` and `machine_list`. Enrollment
rows live in one additive channels store,
`createMachineEnrollmentStore(client)` over its own `machine_enrollment`
table: schema-validated JSON, monotonic revisions, removal tombstones,
`seed` never overwriting a live row or a tombstone, and `list` returning only
active rows; the package index adds that one export and nothing else in
`packages/channels` changes. `ONI_MACHINES` is a first-boot seed: an
env entry that differs from the stored row is ignored and logged as
`enrollment_seed_ignored`. `machine_add` is a shipped `require_approval`
policy row (`apps/oni/policy/owner-policy.json`); a session add binds
the approval to the public key and declaration revision stored in the
original invocation. Re-adding a live machine revokes the old attachment
with `enrollment_replaced`; `machine_remove` revokes with
`enrollment_removed`, and `MachineHost.unenroll` closes only that peer. The
app publishes `machine.enrolled` / `machine.unenrolled` after the durable
change and before the disconnect; the host keeps attach, report and detach
facts. `packages/protocol` adds the shared `Machine.Info` projection and the
correlated `machine_list` / `machine_listed` / `machine_list_refused`
gateway frames; the app decodes that frame at the authenticated WebSocket
callback, and `apps/desktop` renders a read-only Machines place (names,
tags, capabilities, capacity, load, staleness, with unreported, loading,
offline, error and empty states) over it.
Receipts on `c89127356` (rebased onto `ae351e71a`): app policy/provision/machine suites 235 pass / 0 fail (`provision-machine-add-consent` now a row in `apps/oni/policy/owner-policy.json`, pinned by `owner-policy.test.ts`); lane receipts before the rebase: protocol 629/0, machines 264/0 (1 skip), channels 879/0, desktop 517/0, scripts 74/0, patch coverage green; lead gate chain 14/14 exit 0 (install, build, check-types, lint, lint:tools, lint:docs, check-written-types, topology, deps, import cycles, dead exports, journal writers, tsconfig inheritance, effect boundaries). Forbidden surfaces grep-zero: `provider: "machine"` and `channel:machine:`.


## #1574 Pack conformance

Pack conformance: tool + policy kinds; dialect kind pending #1549.
`apps/oni/test/helpers/pack-kinds.ts` registers each loader, typed refusal
set and discovered fixture cases. `apps/oni/test/pack-conformance.test.ts`
runs the same non-empty, repeatable, typed-refusal and process-isolation checks
for every kind, including a throwaway probe kind. Adding a pack of an existing
kind requires only a fixture directory under `test/fixtures/packs/`; a new
kind adds one registry row and a fixture directory. A per-kind guard refuses
an empty case set or a declared code without a fixture. Receipt:
`apps/oni/test/pack-conformance.test.ts`.

## #1572 Owner policy rows

On `feat/1572-policy-rows` (2026-10-15, rebased onto `e1bb6369b`). The Owner's
approval values and every app-owned message, provision and delegation policy
row ship in one file, `apps/oni/policy/owner-policy.json`.
`ONI_POLICY_PATH` selects the file read at boot; blank selects the shipped
file. The file seeds missing rows: on an existing database, stored rows win per
id, and a reset starts a new generation. The loader parses the file through
Zod and refuses boot with `AppInvariantError` codes `unreadable_path`, `invalid_policy_file`,
`unknown_point` or `unknown_handler`. Named handler rows resolve only against
the guards and transformers the app bundles register, so data cannot invent an
executable handler.

`packages/agent` remains the owner of `SEEDED_POLICY_ROWS` and
`POINT_GENERATION_ROW`. The app compiler adds those kernel rows around the
Owner rows when seeding a generation. `apps/oni/test/owner-policy.test.ts`
pins the pre-move row id/point set and both C2 typed refusals; the real-run
receipts are `/tmp/ulw-r3/c2-unknown-point.txt` and
`/tmp/ulw-r3/c2-unknown-handler.txt`.

## #1573 external tool packs

`ONI_TOOL_PACKS_DIR` optionally names a directory of JSON manifests, one
bundle per pack. Boot validates each tool's JSON Schema, required command
placeholders, enrolled machine and name before composition; malformed packs,
unknown machines and built-in tool collisions fail closed with
`AppInvariantError` codes `invalid_tool_pack`, `unknown_machine` and
`tool_name_collision`. Pack tools use the same removable `Bundle.define({ tools })`
generation as built-in tools, so `provision{op:"bundle_disable"}` removes the
pack's tools from the next generation. Rendered arguments are standalone,
shell-quoted values; execution resolves the attached machine's `exec` port,
never a local process. Unset means no external packs. Receipts:
`apps/oni/test/tool-packs.test.ts`, `/tmp/ulw-r4/c4-machine-exec.txt`.

## #1558 streamed bulk fs, terminal output facts and named jobs (epic #1554, rung F)

On `feat/1558-machine-bulk-job` (2026-10-15, base `d1049470a`, PR #1571).
`machine.fs_stream` (begin / bounded chunk / finish / abort) joins
`machine.fs_op` in `packages/protocol`; `machine.pty_output` records machine
id, terminal name, byte count and cursor, never bytes. In `packages/machines`
a read without a larger explicit limit and a write of at most 256 KiB stay on
the one-frame `machine.fs_op` path; an explicit bulk read stops at 8 MiB per
call; a larger write streams into a sibling temp file, is digest-verified,
fsynced and renamed, so the original is untouched until finish and a
final-component symlink is refused. A daemon holds at most 32 transfers;
abort and the host finalizer release them on every settlement path, detach
and reattach clear them, and a replayed begin after the first chunk is
refused as `invalid_sequence` (the latest chunk sequence replays its
acknowledgement; the host does not retry dropped replies). `packages/codemode`
adds `m.job(name, command)`, `job_wait(name, timeout)` and `job_read(name)`
over named persistent terminals that survive Python handle loss: `job_wait`
scans only the newest bytes plus a bounded sentinel tail and returns
status/cursor without retaining output, and a gone terminal answers
`status: lost` from both. Receipts on main `d1049470a`: protocol 627/0,
machines 263/0, codemode 40/0 (the one remaining codemode failure is the
host-only Playwright recipe test, identical on main), gate chain and
written-types exit 0, patch coverage all changed lines covered.

## #1561 every model tool is a removable bundle (base `35d60a491`)

- Shipped: `apps/oni/src/manifest.ts` lists the `file` (read, write, edit, ls, find, grep), `bash`, `eval`, `send-message`, `provision` and `completion` bundles beside `monitor`; each declares its tools through `Bundle.define({ tools })` over late-bound ports (`appManifest`'s `tools` input reads `composition/composed.ts` `ToolPortsSlot`, bound by boot like the monitor's alarm slot; `bundles/seams.ts` `boundTool` resolves the current ports per call). The hard-wired `catalogDefinitions` list is deleted (`composition/catalog.ts` keeps only the `ToolPorts` shape), and `send-message` is the sole owner of the `send_message` face.
- A generation's tools are exactly the composed bundles' tools: `GenerationLayers.initialize` refuses a non-empty per-role definition list with `tools_are_bundle_owned`, and the old `send_message` duplicate exception in `composition/generation-layers.ts` is gone, so a second bundle declaring a shipped tool name is the typed `duplicate` compose refusal.
- `provision{op:"bundle_disable", name:"bash"}` drops `bash` from the next generation: `apps/oni/test/tool-bundles.test.ts` asserts the next turn's offered tools, the generation bump and the journaled compose `disabled` entry. Turning the `tool` capability off now cascades every tool bundle.
- Tool order on the model door is the composed bundle order (dependency-sorted, then manifest order).

## #1563 prompt catalog session wiring

On `feat/1563-prompt-wiring` (2026-10-15, base `3364537f6`), the booted
Resident receives `config.prompts` and renders its skills and templates in
both the Resident and child system presets. Process-session requests now carry
the configured prompt and skill directory paths; child entries validate those
paths and reload the same catalog before creating their Resident. The
regression fixture proves one configured skill is present in both generated
presets. Receipts: `apps/oni/test/prompt-wiring.test.ts` and
`/tmp/ulw-1563/evidence.txt`.

## #1562 provider rows

On `feat/1562-provider-rows` (2026-10-15, base `35d60a491`). Providers are
data: `packages/llm/src/provider/rows.ts` defines the `ProviderRow` schema
(id, npm package among `@ai-sdk/anthropic` | `@ai-sdk/openai`, optional
baseUrl, headers, auth environment-variable name and API surface
`responses` | `chat`) and `readProviderRows`. The two bundled providers ship
as `bundled-rows.json` (the anthropic beta header, the openai responses
surface). Model resolution applies the provider's row; a row id absent from the
catalog resolves to a catalog-free model on that row. `sdk.ts` keeps only the
npm-package -> factory selection; proxy auth still selects Chat Completions.

`ONI_PROVIDERS_PATH` is optional. When set, rows replace bundled rows by
id, and the configured provider's row outranks `ONI_MODEL_BASE_URL`,
`ONI_MODEL_HEADERS` (row headers win by name) and the API key variable;
row ids are admitted in `ONI_MODEL_FALLBACKS`. Env-only deployments are
unchanged. A malformed, unreadable or unsupported-npm file refuses boot with
`invalid_providers_file` (config) / `ProviderRowsError` (llm), never a
fallback. The scope named `packages/agent/src/model`; that code now lives in
`packages/llm` (#1352).


## #1560 prompts and skills as data

On `feat/1560-prompts-skills-data` (2026-10-15, base `b74f3c652`). The
Resident and child role presets are markdown files with `name`/`role`
frontmatter and `## Identity`, `Mandate`, `Policies`, `Style` sections under
`apps/oni/prompts/roles/`; `bundles/prompt/roles.ts` parses them into the
same `RolePreset` shape (imported as text, so the bundled CLI carries them).
`ONI_SKILLS_DIR` lists every `<dir>/<skill>/SKILL.md` (frontmatter
`name` + `description`) and `ONI_PROMPTS_DIR` every `<dir>/*.md`
template (`description`, optional `name`) as `<skills>` and
`<prompt_templates>` blocks with absolute paths, rendered by
`buildAgentPrompt(preset, { catalog })`. `loadConfig` loads the catalog into
`config.prompts`, so an unset or absent directory lists nothing and a malformed
file, bad YAML, an unknown role section or a duplicate name refuses boot with
the typed `OniPromptDataError`. Wired in #1563: `config.prompts` reaches
the Resident/child `buildAgentPrompt` calls and both directories reach process
children. Receipts:
`apps/oni/test/prompt.test.ts`, `test/config.test.ts`.

## #1555 machine capacity facts and the `machine.report` heartbeat (epic #1554, rung A)

On `feat/1555-machine-report` (2026-10-15, base `35d60a491`).
`Machine.Offer` carries optional `resources: { cpus, memoryBytes }`; Rust
`mclient` probes available CPUs and total memory into its offer. After attach
it runs a Tokio interval (5 seconds by default), sending `machine.report`
immediately and on each tick with `loadAvg1`, `memoryAvailableBytes` and
the number of in-flight inbound calls. A refused report ends that connection
and enters the reconnect loop; a failed report call leaves the connection
running. Only `stale_generation`, `unsupported_contract` and
`peer_key_mismatch` are terminal attach refusals. The host accepts a report
only from the attaching connection for the machine it attached as, keeps the
latest per attachment, drops it on detach, and publishes `machine.reported`
(ephemeral; `time` is host receipt, `reportedAt` the client's clock).
`MachineHost.list()` projects `resources?` and
`live?: { reportedAt, load, screen?, stale }` with `stale` judged by the host clock
against `staleAfterMs` (default 15 000 = three missed default beats);
`codemode.listMachines` exposes both. The self machine runs the same Rust
client: `composition/self-machine.ts` subscribes before spawning, observes
`Machine.Events.Attached` with a generation greater than the previous one,
then waits for `Machine.Events.Reported` before admitting startup (within
`attachTimeoutMs`, configured as 10 000 ms). It also probes the admitted
connection before publishing tool ports. Receipts:
`clients/machine-client/src/attach.rs`,
`apps/oni/src/composition/self-machine.ts`,
`packages/machines/test/report.test.ts` and
`apps/oni/test/self-machine-boot.test.ts`.

## #1545 inbound postback (L3)

On `feat/1545-inbound-postback` (2026-10-15, base `7eb1a02e4`).
Slack Socket Mode `interactive` block actions are acknowledged before dispatch;
Discord message-component interactions are deferred through the callback API
before handoff; Telegram callback queries are answered before handoff and
included in the long poll's explicit `allowed_updates`. A failed Discord
acknowledgment warns and drops the interaction; a failed Telegram acknowledgment
warns but still hands it off. Each button tap carries the parsed tap facts:
action id, visible label, sent-message reference when available, and actor.
The label is the inbound rendered text. The existing ingress grant and
prompt/action route applies.

This lane receives button taps; native button rendering is the separate L2
lane. Slack Interactivity and Discord developer-console setup belong to #1546.
Receipts: protocol schema and driver normalizer tests, Slack Socket Mode,
Discord interaction callback and Telegram poller ordering tests.

## #1545 outbound catalog (L1)

On `feat/1545-protocol-catalog` (2026-10-15, base `35d60a491`). The protocol
ships a static `Outbound.catalog` (Stack, Markdown, Code, Table, Image, File,
Buttons/Button, Card, Carousel, Poll, Status, Divider, Context) and a
validated flat `Outbound.Spec`: one tree hung off `root` (no orphans, sharing
or cycles), leaf elements carry no children, Button lives only under Buttons,
Carousel holds 2–10 Cards, Buttons 1–5 Buttons, a Poll 2–10 options, a table
row one value per column, and a Button URL an http(s) link. Fields the catalog
does not define are refused rather than dropped, and a client-state field
(`$`-prefixed, `visible`, `watch`) inside props is refused while element ids
stay plain names. `Outbound.text` digests a spec to readable text and
`Outbound.prompt()` is the model-facing catalog description the Resident
preset carries. `send_message.message` is plain markdown or a spec; the
ordered-parts form left the tool (the catalog's Code, Image and File elements
cover it). `Outbound.Message` is one object carrying exactly one of `parts`
(the text doors) or `spec`, so the schema snapshot only grew; the reviewed
`send_message` tool snapshot was regenerated for the new input.
`Outbound.parts` reads a spec depth-first into ordered parts — runs of text
collapse into one text part while Code, Image, File and a Card's image keep
their own part — so channels still upload a spec's media before L2 renders it
natively; desktop rendering belongs to L4 and postback delivery landed in L3.
Receipts: `packages/protocol/test/outbound.test.ts`, the channels translate
and admission spec tests, `apps/oni/test/send-message-contacts.test.ts`,
and `apps/oni/test/prompt.test.ts`.

## #1506 auto-ack reaction

On `feat/app-ack-reaction` (2026-10-14, base `72ce6b7be`). A Resident turn
that originates on a channel puts a pending reaction on the originating
message while the model runs and, once the turn settles, swaps it for an ok
or failed reaction. The policy is data: `ONI_ACK_REACTION` is JSON with
`pending`, `ok` and `failed` emoji, or `off`; it is off by default and a
malformed value refuses boot with `invalid_ack_reaction`.

Both reactions are ordinary sends through the gateway's ingest door (sender
= the session, target = the actor on that surface), so grants, budgets and
the sent audit apply as to any letter; no provider route is reached around
the kernel. The bundle names the door it needs as its own `reactions` port
and `composition/resident.ts` hands it the message port. The pending send is a forked fiber the model never waits for;
the terminal send runs on the turn's exit, so an interrupted or failed turn
(or a failed report) settles as `failed`, and a refused pending reaction
still ends with the terminal emoji. An evidence-only message is never
reacted to. `Outbound.React` carries `replaces`, the sender's earlier emoji:
Slack and Discord take it off first (`reactions.remove` with `no_reaction`,
`DELETE .../reactions/<emoji>/@me` with 404 counting as already gone, and
`already_reacted` as already added), Telegram's `setMessageReaction` sets the
bot's whole list so the swap is one call.

Receipts: order ack -> report -> terminal with the swap payload, default
off, failed turn, evidence-only, throwing port and refused pending in
`apps/oni/test/resident-reply-to-origin.test.ts`; config parsing
(`off`, strict shape, typed code) in `apps/oni/test/config.test.ts`;
replace-and-settle per platform in
`packages/channels/test/{discord,slack}-media.test.ts` and
`packages/channels/test/translate.test.ts`.
Local gates (`mise exec bun@1.4.1`): types, lint, lint:tools, deps, dead
exports, docs, cycles exit 0; protocol 611/0, channels 858/0, script 124/0,
app 881 pass with the known environment-only failures (m.pty #1273, tmux
monitor watch, bash session door, 967-U1); patch coverage 0 uncovered.

Not here: platform permission provisioning for reactions (#1507, Owner).

## #1496 bash sessions drain through command sentinels (PR #1539, base `030d50500`)

On `fix/1496-bash-session-sentinel` (2026-10-14). Named bash sessions
write a split nonce on a separate line for shell readiness and command
completion, preventing echoed input from matching the marker. Terminal
CSI/OSC sequences and carriage returns are removed before matching and
echo stripping. Commands returning within the 20-second drain deadline
report their numeric exit code; longer commands return output with
`pending: true` and `exitCode: null`, and an empty command resumes the
drain. New commands are refused while one is pending. An empty command
on an idle open session reads once from the saved cursor. Tool-wiring
tests cover these transitions and the persistent-terminal e2e exercises
the daemon path. No concurrent-loop receipt is claimed here, and the
machine PTY endpoint is unchanged.

## #1498 app test lane bounds a synchronous Bun PTY wait (PR #1535, base `2047087ba`)

On `fix/1498-watch-sources-hang` (2026-10-14), the generated `Test (oni
app)` step in `.github/workflows/ci.yml` has a 10-minute deadline, beneath the
matrix job's 30-minute limit. `script/topology.ts` owns the generated step and
`script/check-topology.test.ts` pins the app-specific timeout.

On Bun 1.4.1/macOS arm64, 35 completed, externally bounded trials of the
filtered command-watch test under concurrent app-suite load passed 31 times
and hit the 120-second alarm 4 times (iterations 14, 17, 22, and 26). A
five-second `sample` of iteration 14 captured all 2,702 main-thread frames
ending in `__wait4_nocancel` under Bun frames; the test's JS deadline cannot
run while that thread is blocked. The concurrent suite exceeded its separate
300-second measurement cap; a second complete-app attempt under continued
machine contention also reached its external 600-second cap before finishing.
The standalone `/tmp` PTY reproducer completed 50/50 iterations; the PR
carries its text and the sample excerpt.

`apps/oni/src/composition/watch-sources.ts` kills the detached process
group, awaits `child.exited`, then closes the terminal; that order is unchanged.
One repo-side teardown defect was fixed: when `killCommandGroup` throws the
typed `AlarmProcessGroupError`, the PTY master was never closed and EOF never
resolved; `terminate()` now closes the master in a `finally`, and the
kill-failure tests assert the close. This PR bounds CI's failure time; it does
not fix Bun's internal synchronous wait or establish that every runner
triggers it, so the issue stays open.

## #1454 remove pinned sibling-bundle imports (PR #1540, base `030d50500`)

On `refactor/1454-bundle-sibling-edges` (2026-10-14). The exact sibling
ratchet in `script/check-deps.ts` shrinks from 16 imports across 10 files to
zero. No sibling edge remains pinned. Cross-bundle construction belongs to
the composing app; bundle-owned schemas and ports stay with their consumer.

Paths below are relative to `apps/oni/src/bundles/`.

| Former importer | Former sibling targets | Before | After | Replacement |
| --- | --- | ---: | ---: | --- |
| `messaging/index.ts` | `delegation-policy/index` | 1 | 0 | Both read `Gateway.DelegationCaps` from `packages/protocol` (the Owner's #1454 ruling: delegation caps are a protocol-level contract); `seams.ts` keeps only the two capability ports. |
| `core-policy/index.ts` | `messaging/index`, `provision/provision` | 2 | 0 | `composition/policy.ts` composes and seeds the mandatory rows in their original order; core-policy retains gate-row projection. |
| `alarms/index.ts` | `tools/core/watch` | 1 | 0 | The existing monitor port contract moves to `alarms/monitor/ports.ts`. |
| `alarms/monitor/index.ts` | `tools/core/watch` | 1 | 0 | The tool adapter consumes its own alarm-local ports; its live capability remains composition-injected. |
| `resident/index.ts` | `prompt/build`, `prompt/roles`, `tools/core/catalog` | 3 | 0 | `composition/resident.ts` injects role presets; since #1561 the tool faces come only from the composed generation. |
| `tools/core/request-domain-revisions.ts` | `provision/automation-schema`, `provision/automation` | 2 | 0 | The request-precondition adapter moves to `composition/request-domain-revisions.ts`. |
| `tools/core/catalog.ts` | `provision/provision`, `provision/channels`, `messaging/send-message/index` | 3 | 0 | Since #1561 there is no catalog module: each tool bundle declares its own definitions in `manifest.ts`. |
| `provision/provision.ts` | `tools/core/contact-mutations` | 1 | 0 | Contact schemas move unchanged into `provision/contact-mutations.ts`. |
| `provision/contacts.ts` | `tools/core/contact-mutations` | 1 | 0 | Uses the provision-local contact schema and digest reader. |
| `provision/execution.ts` | `tools/core/contact-mutations` | 1 | 0 | Uses the same provision-local digest reader; both directions of the provision/tools cycle change together. |
| **Total** | | **16** | **0** | |

The separate deep-relative ratchet also shrinks from 2 to 0: monitor ports
use `Core.SessionKernel`, and the request-precondition adapter no longer
traverses three parents. The independent bundle-to-app-module ratchet
shrinks from 23 to 20; those remaining composition/configuration imports
are not removed or concealed by this change.

Hashed manifest names, row data/order, tool schemas/order and `Bundle.port`
keys are unchanged. Default, tool-off, compaction-off and monitor-off manifest hashes, the
catalog's tool names/order/schema digest and the kernel policy-row digest
were compared before and after by a review probe (not committed; no
repository receipt pins them). The
dependency gate runs after each edge group; existing catalog-generation,
policy-seeding, monitor, delegation and provision-consent tests exercise
the affected behavior. This does not claim zero app-module dependencies,
zero repository-wide debt, a complete mutation campaign, or any migration
of stored policy rows. Still open on #1454: the `send_message` tool-body
`effect` pin in `script/check-effect-boundaries.ts` and the remaining 20
bundle-to-app pins.

## #1476 compaction purpose accounting, fallback reason, and fitting unchanged prefix (PR #1537, base `6deb863ad`)

On `feat/1476-compaction-accounting` (2026-10-14), following the app half
in #1427 / PR #1475 and part of #1421.

- Accounting: the metrics read model retains its byte-compatible flat `usage`
  list and adds `usageByPurpose`. Groups use each physical attempt's recorded
  nested `purpose`; absent purpose remains `null`. Grouping preserves attempt IDs,
  failed billed usage, provenance, unknown counts, and total usage without
  counting enclosing results. Paginated metrics reads recover each distinct
  attempt intent before the cursor once, so attribution survives a page boundary.
- Fallback: `reason: "fallback"` means the summarizer failed and a
  deterministic result replaced its summary. It is written on an executed
  compaction result exactly when `summarizerFailed: true`: the user-boundary
  snap-cut, an anchored cut that carries the previous anchor forward, or an
  elision-only reduction. The closed protocol enum accepts the reason; the
  request's `trigger` is unchanged. Typed summary failure and injected-clock
  expiry both complete the turn through the deterministic cut.
- Prefix (#1476 item 3): synchronous and speculative summaries receive the
  unchanged original leading cut span (user messages, prior anchor renders,
  pre-elision tool output bytes) only when its estimate plus the previous
  anchor plus the output reserve `min(32768, window/2)` fits the context
  window. Otherwise they receive the previous bounded input: no user messages
  or anchor renders, completed tool outputs elided, oldest messages dropped to
  half the window. In the unchanged prefix the previous anchor appears both as
  merge state and as its render; it is not deduped, because removing the render
  breaks prefix identity and removing the merge state breaks the incremental
  merge, and the fit test counts both. Thresholds, user preservation,
  user-only skip behavior and candidate fingerprint bytes are unchanged.
- Not claimed: provider prefix-cache hits or complete #1476 closure. The app
  still omits tools, blocks tool choice at the request, and changes reasoning
  settings; tool/thinking parity requires app-owned work. No app policy or
  provider configuration is changed here.
- Local evidence: `bun test packages/agent packages/protocol` 2141 pass /
  0 fail; six app compaction test files 18 pass / 0 fail; `check-types`,
  `check-core-end-state` (clone pins unchanged), `check-deps`,
  `check-dead-exports`, `check-import-cycles` and `lint:docs` exit 0. CI is
  the record for the remaining lanes.

## #1495 typing during channel-origin Resident turns (PR #1530, base `030d50500`)

On `feat/channels-typing-pulse` (2026-10-14). Mounted channel instances
register and revoke their optional `typingRoute` alongside delivery and
webhook routes. A Resident turn with a recorded external channel origin opens
the route's conversation once (a Discord DM channel is created once per turn),
pulses it immediately, then repeats on the route's own window (Telegram every
4 s against its ~5 s indicator, Discord every 8 s against ~10 s) until the
model run ends; the scope closes before the post-turn report is sent, so no
pulse lands after the reply. The fiber uses the injected runtime clock, is
interrupted on every exit path, and treats a refused pulse as a skipped beat
and a refused open as no pulse. Evidence-only turns start no pulse. The recorded origin's external id and
conversation select the same chat or thread the report answers. Channels
without a typing route, WebSocket owners, and child sessions start no pulse.

Tests: virtual-clock calls and cancellation with Telegram and Discord
fake-fetch routes (`packages/channels/test/typing-pulse.test.ts`), mounted route
cleanup (`apps/oni/test/boot-wiring.test.ts`), and an external Resident
turn with a refused typing receipt (`apps/oni/test/resident-reply-to-origin.test.ts`).
Not in this change: Slack typing (`assistant.threads.setStatus` needs the
`assistant:write` scope; Slack declares `typing: false` until that scope and
route land); outbound emoji reactions, already shipped in #1504; inbound
media normalization and automated reactions remain outside this lane.

## #1481 app port identifiers and durable keys (PR #1536, base `030d50500`)

On `refactor/1481-app-pins-seams` (2026-10-14). Item 2 is implemented:
`ToolCapabilitySeam` and `CompactionSummarizerSeam` become
`ToolCapabilityPort` and `CompactionSummarizerPort` in
`apps/oni/src/bundles/seams.ts` and every importer, without aliases.
Their persisted keys remain byte-identical:
`"@oni/oni/ToolCapabilitySeam"` and
`"@oni/oni/CompactionSummarizerSeam"`. The manifest test compares
both UTF-8 keys and the composed hash against the literal legacy preimage.
The dependency and end-state gates reject TypeScript identifiers containing
`Seam` throughout `apps/oni/src`, while preserving quoted keys, module
paths, and prose. This does not claim a repository-wide prose rename.

Item 1 remains open: the direct agent-core token pin is **1 before, 1
after**, and its exact `tools.add` write allow-list entry remains. Tracing
the real entity writer and exercising its RPC established that
`Deliver(kind: "session.configure")` returns `unknown_kind` with no new
facts; sending the same configuration as `action` appends an ordinary
action and leaves the generation unchanged. `DeliverBody` has only
content/control/delivery/cursor fields, and `SessionEntityPorts` has no
configure authority or generation-acquisition port. Safely removing the
write requires an explicit configure delivery contract that preserves
pinned policy authorization, durable replay identity, and candidate-layer
acquisition before commit with rollback on failure. This PR does not
claim that contract, a zero direct-token pin, or removal of app-owned
ledger writes.

## #1049 nightly mutation schedule removed (base `030d50500`)

On `ci/mutation-schedule-off` (2026-10-14). `quality-mutation.yml` is
manual-dispatch only: the `41 2 * * *` schedule ran every night from
2026-09-11 and completed 0 of 8 shards each time (about 760 of 7,953
candidates fit one 240-minute shard budget while main moved daily and the
inventory hash changed per run, so no night resumed another). Nothing else
in the workflow or `run-quality-mutations.ts` changed; the complete-campaign
receipt requirement, shard inputs and resume logic are as before. The
schedule returns once one dispatch completes a full campaign receipt; that
remains the open acceptance item under #945. Receipt: `docs/ci.md` and the
workflow trigger comment, PR #1529.

## #1505 inbound attachment references

On `feat/channels-inbound-attachments` (2026-10-14, base `030d50500`).
Telegram photo (largest size), document, voice, audio and static sticker,
Slack files, and Discord attachments now retain their platform download
reference and available kind, name, MIME type and byte count in
`Gateway.IngressFacts.attachments`. Telegram's poller hands off media-only
messages before advancing its offset. Direct-route prompts place each
attachment reference immediately below the sender header, preserving the
caption or text body. Protocol parsing, platform wire fixtures, Telegram
handoff and direct-route prompt rendering have regression tests.

No media bytes are copied into the ingress facts. Slack's private download
URLs require bot-token authentication when retrieved; Telegram file IDs
require platform resolution. Automation rules and conditions, animated/video
stickers, and inbound download/authentication tooling are not changed here.

## #1497 one outbound payload for every channel: parts, media, reactions (PR #1504, base `55ac51ecd`)

On `feat/channels-unified-outbound` (2026-10-14). The agent produces one
value for a person and every channel translates it from its declared
capabilities; platform vocabulary stays inside the provider band.

- `packages/protocol/src/gateway/outbound.ts` — `Outbound.Payload` is a
  `message` of ordered parts (`text`, `code{lang?}`, `image{ref, name?,
  caption?}`, `file{ref, name, mime?, caption?}`) or one `react{messageId,
  emoji}`; `Outbound.payload(text)` is the string sugar, `Outbound.text`
  the plain-text fold (a media part folds to its `[image: name] ref` line).
  `Gateway.SendMessage.content` and the gateway's delivery route carry the
  payload; the route returns `Outbound.Receipt{value: accepted | rejected |
  unknown, externalMessageId?}`, the id of the last posted message (the one
  a later reply quotes; a reaction reports the message it sits on).
- `packages/channels/src/support/translate.ts` — the one translation layer.
  A driver binds three primitives to its target (`text`, optional `media`
  upload, optional `react`); `translate(payload, render, sends, resolve?)`
  owns the folding: adjacent text/code parts join into one markdown text
  rendered through the surface dialect and split at its limit; an
  image/file part uploads where the provider declares `media` and the
  composition root supplied a `MediaResolver`, otherwise its reference line
  stays in the text; media bytes resolve before the first send so a bad
  reference refuses the whole letter with nothing posted; a part over the
  surface's declared `MediaLimits{imageBytes, fileBytes, captionLength}`
  (telegram 10 MB / 50 MB / 1024, discord 20 MiB / 20 MiB / 2000, slack
  1 GiB / 1 GiB / 4000, each in its `format.ts`), or a letter whose media
  totals over 64 MiB, is refused the same way (`media.limit`,
  `media.caption`); a `react` on a surface without reactions is
  `DeliveryNotSent` (receipt `rejected`), never posted as text. A platform
  failure after an accepted step is `PartialDeliveryError` → receipt
  `unknown` and nothing is resent. `support/send-text.ts` is deleted; every
  surface (telegram, discord, slack, github) delivers through `translate`.
  `ProviderCapabilities` gained `media: MediaLimits | false`, `react`,
  `typing` (telegram/discord all three; slack media and react, no typing;
  github and webhook none); the conformance suite pins `deliveryRoute` and
  `typingRoute` to `deliver`/`typing` and the media declaration's shape, and
  the fake-fetch suites `test/{slack,telegram,discord}-media.test.ts` pin
  each upload, reaction and typing call's URL, method and body.
- Platform calls: telegram `sendPhoto`/`sendDocument` multipart with a
  plain-text caption, `setMessageReaction`, `sendChatAction typing`;
  discord multipart `payload_json` + `files[0]`, `PUT …/reactions/{emoji}/@me`,
  `POST /channels/{id}/typing`; slack `files.getUploadURLExternal` →
  upload → `files.completeUploadExternal` (acknowledged without a message
  id), `reactions.add` with the short name from
  `provider/slack/emoji.ts` (a character outside the table is refused, never
  guessed). `ProviderTypingRoute` is one pulse the composition root may
  repeat; nothing in the app consumes it yet (#1495).
- `router/external-message.ts` — a direct-route prompt opens with one
  `[from <actor|external id> on <surface> · channel <id> · message <id>[ ·
  thread <id>]]` line, then the thread history and quoted message (#1490),
  then the rendered body; a request answer and the `ws` surface carry no
  header. `packages/channels/src/index.ts` exports `MediaBytes` and
  `MediaResolver`.
- `apps/oni/src/bundles/messaging/send-message/index.ts` — the tool
  takes `message` as a string or an array of parts, or `react` (one emoji on
  the contact's `conversation.replyToMessageId`), exactly one of the two
  (`.refine`, applied on the model path by the dispatcher's input parse). A
  channel contact rides the gateway ingest door; `CONTACT_KINDS` is `cli`
  only and the `ChannelEgressPort`/`HumanNotifyPort` connectors are deleted.
  The turn-end report (#1482/#1485/#1490) sent the result text through the
  string sugar until #1569 PR 4 moved it onto the reply door (an
  origin-targeted gateway send, no tool row). `apps/oni/src/composition/media.ts` is the app's
  `MediaResolver`: a ref with an authority is an `https` URL fetched with
  manual redirects (at most three hops, every hop re-admitted: https only,
  no loopback/link-local/private host), a 30 s timeout, and the body read in
  chunks that stop at `MEDIA_BYTE_CAP` (50 MiB) whether or not
  `content-length` was sent; anything else is a machine locus stat'd then
  read through the `read` tool's door (`FilePorts`, #1271), refused unread
  over the cap. The read is admitted by the `send_message` call's own policy
  gate and the daemon's export enforcement, not by the `read` tool's gate.
  `MediaRefused{code: scheme | host | fetch_failed | too_large}` is the
  typed refusal. The ws route pushes `Outbound.text(payload)` and answers a
  `react` with a `rejected` receipt. `router/messaging/admission.ts` signs a
  one-text-part letter as `body: <text>`, the form recorded before payloads
  existed, so an admission written then still matches on replay.

Tests: `packages/channels/test/translate.test.ts` (folding, media upload
and fallback, react refusal, partial delivery), provider golden/conformance
suites over payloads, router prompt pins (`ownerPrompt` fixture),
`apps/oni/test/media-resolver.test.ts` (machine stat-first cap,
streamed-body cap, hop-by-hop redirect admission, private hosts),
`apps/oni/test/send-message-contacts.test.ts` (string, four-part and
react letters through the gateway door; react without a conversation
refused; schema exactly-one rule), `test/router/messaging/send.test.ts`
(legacy `body` admission replays). Channels 838/0, app 870/0 at commit time.
Not in this PR: inbound photo/voice/file normalization, an app loop that
repeats the typing pulse (#1495), and bot emoji reactions on inbound
messages as an automation action.

## #1500 a content-filter stop with no output is a failed attempt (base `663471f19`)

On `fix/llm-refusal-stop` (2026-10-14). A completed provider stream whose last
step closed as `content-filter` (Anthropic `stop_reason: refusal`) or `error`
with nothing visible no longer leaves `run()` as `{ type: "stop" }` with empty
text: `packages/llm/src/run.ts` returns `{ type: "error" }` carrying an
`LlmRunFailure` with the new optional `contentFiltered` fact (`errors.ts`,
read structurally by `error.ts` `errorFacts`), and `classifyFailure`
(`classify.ts`) decides that fact `terminal / content_policy` after abort and
overflow and before the SDK-error vocabulary. The attempt loop already stops
on a terminal class, so a refused turn ends after one call as `kind: "error"`
with the content-policy text `classifyTurnFailure` already renders, instead of
the production trace this fixes: three identical calls (3.9s, 5.4s, 2.9s) judged
as empty stops and an `AgentStopError exact_repeat` terminal. A refusal that
already showed text stays a stop (the visible-stop rule the overflow path
uses). The processor exposes the raw last-step `finishReason` for the message.
Tests: `packages/llm/test/run-outcome.test.ts` (refused stream fails; refusal
after visible text stays a stop) and `packages/llm/test/failure-classification.test.ts`
(declared `contentFiltered` is `content_policy` without an SDK error). No loop,
agent-port or app change.

## #1479 desktop shell baseline (PR #1480)

Landed on main as `63cc2e001` (2026-10-14) after #1472
`fix/protocol-crypto-builtin` landed as `3c27d4a95`. `packages/ui` owns the shell geometry as
tokens, utilities, and frame components: tab strip 40px with a 252px window-controls zone,
28px tabs with an 8px radius, a 44px sidebar header, 28px nav rows at
13px/500, two-line session rows, a 42px footer row, and the panel at a
0.75rem radius with an 8px margin; `--spacing-new-column` (712px) bounds the
new-session column. `Console.Hero` renders the empty label and the same
`Composer` centered in that column while a sendable transcript has no nodes
and docks the composer to the bottom of `Console.Content` once the first node
exists; both branches share one `composerProps`. `src/names.ts` remains the
single `data-ui` owner (`Console.Hero` added).

`apps/desktop` composes the sidebar from those parts: brand header, the
New session / Sessions / Automations / Ingress ledger nav, attention-ordered
project groups with counts, `StatusGlyph` session rows, and a gateway footer
showing the configured endpoint from the one preload call. `ensureBootTab` opens
one new-session tab when the store has no tabs and is called once from the
shell lifecycle, so every boot lands on the hero. Shell hooks moved out of
`app.tsx` into `shell/`. No mock sessions: the sessions list is the client
store's session handles (`state/store.ts`, created by New session and the boot
tab) enriched per durable session by the gateway's session read pages
(`useSessionReadModels` in `state/queries.ts`: phase, ancestry, fork anchors,
last activity), and the transcript comes from the gateway transport.

Verified before landing: build, check-types, lint, lint:tools, topology,
deps, import cycles, dead exports, effect boundaries, journal writers,
tsconfig inheritance, patch coverage, and the hosted CI test lanes (every
lane green on the PR head and on the main run after the squash). The local root `bun test --timeout 15000`
run passed every `packages/ui`, `apps/desktop`, and `packages/protocol` test;
its remaining failures are host-environment classes (the Python mutation
worker fixture without `D945_PYTHON`, Playwright without Chromium) that the
hosted lanes do not share.
Screenshots at 1280x800 and 1000x700 in dark and light with a `data-ui`
geometry dump match the token values above within 1px.

## #1355 - terminal core gates (rebased verification)

`script/core-end-state-targets.ts` holds terminal acceptance values.
Verification on rebased `38e149bba` plus the #1355 follow-up, after #1473
merged as `d6974ebd5`, establishes the source and structural counts below.
Structural targets are met. Vocabulary is checked as substrings, with quoted
durable-byte exclusions listed below. Public aliases and public-contract
vocabulary pins are removed; inherited quality debt remains separately tracked.

| Command | Required terminal result |
| --- | --- |
| `bun run script/check-deps.ts` | Core root exactly `api.ts`, `index.ts`; eight named bands; schema declarations in exactly `store/catalog.ts`, `store/session-file/index.ts`, both nonempty; nine workspaces; four root namespaces; zero forbidden value edges and agent value cycles. |
| `bun run script/check-deps.ts` | Four inspection imports accounted for at `journal/compaction.ts`, `session/recovery.ts`, `session/run.ts`, `session/runtime.ts`; missing, renamed or changed owners fail. Pins cannot absorb plugin edges or another inspection target. The inherited app direct-token pin remains tight and shrink-only. |
| `bun run script/check-core-end-state.ts` | No unlisted retired substrings or forbidden source patterns; exact durable-literal pin counts; one alarm-chain fold, one plugin-owned alarm-purpose composer and none in core; no source file over 600 lines, no test file over 1,000 lines, no empty `toThrow()`. |
| `bun run script/check-comment-residue.ts` | Issue comments zero outside at most ten enumerated durable-byte notes; dividers and JSDoc blocks over six lines zero; comment ratio at most 8%, with the existing tighter ceiling retained. |
| `bun run quality:clones:production packages/agent`, `bun run quality:clones:test packages/agent` | Agent-only reports are consumed by `check-core-end-state.ts`. Production clones zero and duplicated test lines at most 0.5%; exact agent pins below require equality. Empty reports fail. |
| `bun run lint:tools` | Source, alarm, assertion and file-size targets enforced along with existing conformance checks. |
| `bun test packages/agent/test/structure-gates.test.ts` | Adversarial fixtures and a separate real-tree assertion; a failing real-tree target is not replaced by a stacked-base pin. |

Measured: two root files, eight bands, two nonempty schema owners, nine
workspaces, four namespaces, four accounted inspection imports, zero forbidden
core value edges and zero cycles. Unlisted retired substrings, forbidden
source patterns, source files over 600 lines, test files over 1,000 lines and
empty assertions are zero. One alarm-chain fold and one plugin-owned
alarm-purpose composer remain. The comment ratio is 704bp (1486/21106),
below the retained 710bp ceiling; issue comments, dividers, long JSDoc and
durable-byte exceptions are zero. The 19 former empty assertions were
negated success checks; they now assert returned values, compiled rows or
observed events. Compaction tests are split into independent `compact.test.ts`
and `run.test.ts` describe blocks.

Inherited pins authorized by the lead on 2026-10-14:

| Surface | Exact inherited pin | Closure owner |
| --- | --- | --- |
| `apps/oni/src/index.ts` direct agent-core tokens | 1, unchanged from main: the #1346 deferred `tools.add` configure commit | Apps/oni entity-seam ruling; follow-up issue to be filed by the lead |
| Agent production clones | 0 | Agent core gate |
| Agent duplicated test lines | 248 (about 0.4803% of the agent test census) | #945 agent test-quality debt |

All pins reject growth and slack. A removal requires lowering the pin in the
same change. Test clones use an absolute duplicated-line count, so adding
unrelated tests cannot dilute the allowance. The terminal clone goals remain
0 production clones and at most 0.5% duplicated test lines in the target table.
The earlier repository-wide observation was 11 production clones and 1006
duplicated test lines (about 0.6815%); those numbers are historical context,
not pins enforced by an agent-core gate.

The inspection owner is `journal/compaction.ts`, not the issue's historical
`journal/commit` wording. `session/runtime.ts` imports inspection types from
the inspection barrel; the other three owners import history. The source
scan rejects retired substrings, including `FooSeam`, `seams`,
`ModelPortService` and unquoted `seam_missing`. Internal names now use
`PortTag`, `CompactionPort`, `CompactionPortService`, `AlarmPort`, `ActionPort`,
`HookPort`, `ApprovalPolicyPort`, `pinThroughPort` and `portOwner`.

The five public tags, the capability factory/field and the run configuration
now use `Port`/`port`/`compactionPort` at declaration and every consumer, with
no compatibility aliases. `compactionSeam` is absent from the protocol journal
and `session.configure.settings` schemas and is not a stored field.
Mechanical app edits are limited to `src/bundles/alarms/{cron,monitor}/index.ts`,
`src/bundles/{approval-policy,compaction,delegation-policy,hooks-json,resident}/index.ts`,
`src/bundles/messaging/send-message/index.ts`, `src/bundles/seams.ts`,
`src/manifest.ts` and `test/alarm-bundles.test.ts` under `apps/oni`.
The #1343 app-token count remains 1; these names are not ledger/entity tokens.

Nine quoted
`seam_missing`/`compaction_seam_missing` occurrences remain across
`core/composition/{approval-policy,compose}.ts`, `core/journal/messages.ts`
and `core/session/{entity-delivery,recovery,runtime}.ts`; these are durable
rejection codes and comments quoting those codes. Eight quoted `'worker'`
literals in `core/store/catalog.ts` preserve legacy role migration.
One quoted `"seam"` key remains in `core/composition/compose.ts`'s
`hashProjection`: it is part of the canonical preimage of persisted
`SessionGeneration.Snapshot.manifestHash`
(`packages/protocol/src/ledger/l0.ts`). The API reads `capability.port`, but
changing this serialization key would change recorded manifest identities.
`compose-reject.test.ts` asserts the legacy preimage bytes independently.
`sea[m]` over packages/agent/src = 9 quoted rejection-code occurrences + 1 durable hash key, implementation/API matches 0.
`inboxId` has no exclusion because no retired pattern matches it.
Each exclusion has a fixture that turns red when it is removed.

Process checks cover property/element access and destructuring of
`Bun.spawn`/`spawnSync`, both child-process module spellings, and relative
model paths with file extensions or nested directories. Synthetic-tree tests
exercise empty censuses, both file-size limits and every aggregate count.
The comment gate has one enforcement layer, its existing exact per-file pins.

## #1354 — core split into eight responsibility directories (PR #1473, base `5d2de7484`)

- Layout: `packages/agent/src/core/` is exactly `api.ts`, `index.ts` and the eight directories `ports/ session/ loop/ journal/ composition/ observation/ gate/ store/`; no source file exceeds 600 lines; `store/catalog.ts` and `store/session-file/index.ts` remain the only two `CREATE TABLE` owners.
- Value edges: `script/check-deps.ts` enforces the importer table (session → composition/loop/journal/ports/observation/gate/store; loop → gate/journal/observation/ports/store; journal, gate → ports/store; store, observation → ports; ports → none) on value imports only, and rejects any importer outside the eight directories (`#1354 core layout`); type-only imports stay out of the edge and cycle graphs (`script/check-deps-agent-bands.test.ts`, `script/check-import-cycles.test.ts`).
- Splits: `run.ts` → `session/{runtime,generations,outbound,turn-open,run}.ts`; `entity.ts` → `session/entity-{activation,delivery,alarm}.ts` + `session/entity.ts`; `gate/decide.ts` + `turn.ts` → `loop/{executor,invocation,record,approval,attempts,retry,wave,state,turn}.ts` + `observation/turn-events.ts`; `commit.ts` → `journal/{compaction,turn-rows,delivery,commit}.ts`; `store/fence.ts` → `store/{fence,session-reads,configure}.ts`; `store/session-file/index.ts` → `store/session-file/{index,reads,actions,alarms,outputs,verify}.ts`; `store/json.ts` + `storage/timestamped-store.ts` → `storage/sqlite-l0-{rows,sessions}.ts`. Behavior, public export names, journal bytes and the protocol `Single writer:` owners are unchanged; older sections below cite the moved files by their new paths.

## #1426 — watch-sources reconcile cadence on the alarm plane (PR #1474, base `11061c992`)

- Cadence: `apps/oni/src/composition/watch-plane.ts` arms one `watch`-purpose cadence chain per native path source on the app alarm plane (one-second cadence as the issue specifies), re-armed from its own fired row while the path watch is live and superseded with `at: null` on close; restoring a source arms once and never restarts an existing handle; arm refusals surface the entity's typed reason. Empty ticks return the no-drain `exhausted` outcome so the session can passivate; they still write two durable rows per watch per second, which is the Owner decision in #1477.
- Lifecycle: `composition/watch-sources.ts` reports typed retire failures through `options.failure`; `closeAll()` awaits pending installs and in-flight retirements with `allSettled`, and installs after shutdown started refuse with `WatchRefused({ reason: "shutdown" })`. `index.ts` runs `watchSources.closeAll()` while the Effect runtime is live so retirement can complete.
- Capacity: a path watch holds two armed rows (three with a timeout) under the 64 armed-row cap — `2P + 3T + other ≤ 64`; an install past the cap is a typed `alarm_budget` refusal with complete cleanup.
- Clock: the CLI reconnect and termination delays (`cli/machine.ts`, `cli/main.ts`) run on the Effect clock; CLI readiness is signalled over the child's stdout pipe. `setInterval|setTimeout` under `apps/oni/src` is zero.
- Review r1: High 2 (close/closeAll rejections; missing real-wiring TestClock test → `test/app-watch-cadence.test.ts` proves one armed cadence row per live path watch, a dropped create recovered by the fired cadence, zero rows after cancel), Medium 5 (per-tick drain, capacity, install after shutdown, `fs.watch` readiness, docs) all fixed; Lows recorded on the PR.
- Verification (bun 1.4.1 pinned, behind the host gate lock): focused files after the r1 fix watch-sources 23 / app-watch-cadence 1 / cli-entry 28 pass; oniApp lane and patch coverage rerun after the rebase onto `11061c992` (recorded on the PR); check-types, lint, lint:tools, check-deps, check-effect-boundaries, check-dead-exports, check-journal-writers exit 0; PR CI green.
- Quiet ticks (#1477): an empty cadence tick returns `{outcome: "quiet", at}`; the core moves the same armed occurrence forward in `armed_alarms` and re-sends it keyed `occurrenceId@tick` with no `fired` or re-arm row, so a path watch costs the journal nothing while nothing happens (was 2 rows/watch/second). A real fire or retire settles the chain as before. Receipt: `test/app-watch-cadence.test.ts`.
- Command-watch follow-up (#1650): the PTY shell waits for a post-spawn release before executing the command, so a fast exit cannot overtake Bun's macOS process watch; the release line is excluded from monitor output and normal terminal echo is restored. PTY output drains before a bounded child-exit wait, a stalled exit reports `AlarmProcessExitTimeoutError`, and cancellation closes the PTY master before signalling the process group. Path creates missed by the native callback are recovered by stat reconciliation.

## #1427 — compaction summaries as session llm rows, no failed turn on summary failure (PR #1475, base `5d2de7484`, app half)

- Accounting: `apps/oni/src/bundles/compaction/summarizer.ts` runs the summary through the compacting session's own executor (`src/composition/completion.ts`), so the call lands as that session's `llm` row with `intent.purpose: "compaction"` and usage; no side session, no direct provider call. Grouping by purpose in the metrics read model is core work tracked in #1476.
- Failure shape: a thrown or timed-out summary yields the core's deterministic window cut (`summarizerFailed: true`) and a completed turn, never a failed turn. Each overflow attempt has its own deadline on the injected Clock, `summaryDeadline = 30 s + ceil(maxOutputTokens / 20) s` unless configured; the core speculative guard (`summarizerDeadlineMs`) wraps nine attempts plus 60 s. A timeout sets `summarizerFailed`, after which core policy disables speculative compaction for that session. A literal `fallback` compaction reason is #1476.
- Request shape: [turn system prompt as instructions, the messages the core hands over in order, instruction last]. Not yet prefix-cache equivalent: the request sends no tools, `toolChoice: "none"` and different reasoning options, so sessions with tools get no provider cache hit; parity and the unfiltered leading prefix are #1476.
- Unchanged: compaction policy thresholds and the four core ports; `git diff --stat 5d2de7484..HEAD -- packages apps/desktop script` is empty.
- Review r1: High 0, Medium 3 — M1 whole-loop 60 s deadline → per-attempt, derived, configurable; M2 acceptance criteria over-claimed → marked partial with the deferred halves on #1476; M3 missing stamp and this row. Lows recorded on the PR.
- Verification (bun 1.4.1 pinned, behind the host gate lock): apps/oni 849 pass / 1 hang-class failure in the full lane (a 989 s stall under host load; the four compaction files pass isolated 14/14, then 15 focused after the r1 fix), patch coverage all changed executable lines covered; check-types, lint, lint:tools, check-deps, check-effect-boundaries, check-dead-exports, check-journal-writers exit 0; PR CI green.

## #1353 — compaction four core ports with a plugin-owned policy (PR #1470, base `91eb15949`)

- Port: `packages/agent/src/core/ports/compaction-ports.ts` declares the four operations the turn loop needs and nothing else (132 formatter-canonical lines, 172 before; the issue's ~70-100 guide is noted as a follow-up). `core/loop/turn.ts` reaches compaction through exactly one `maybeCompact(` call; the old tokens (`applyCompaction`, `prepareCompactionAfterContinue`, `createCompactionSession`, `geometry`, `shouldCompact`, `createSession`, `thresholdTokens`) go 11 → 0 in turn.ts.
- Policy: compaction policy, speculation and tool-output elision defaults move into `packages/agent/src/plugins/compaction/policy.ts`. `CompactionReason = prepare | threshold | yield | overflow` (`prepare` only starts speculation after a tool-call continuation and never executes); `overflow` is recorded as the existing `trigger: "yield"` row value, so no recorded journal byte changes (goldens and conformance snapshots untouched). The plugin imports only `core/api.ts`; `Bun.spawn` in the plugin stays 0.
- Deletions: `packages/agent/src/core/compaction.ts` (144 lines) and `apps/oni/src/compaction/strategy.ts` (30) are gone; core and `testing/registry.ts` imports of `plugins/compaction` 1 → 0; app `configuredCompaction` 3 → 0. The app `compactionBundle` only makes composition refuse when no summarizer is composed.
- Regression caught by the full agent suite: speculative preparation was torn down before the settle-abort finalizer could grant its start tick; fixed by forking a child scope in `bindCompactionRun` before registering the finalizer (finalizer order unchanged: abort still runs before the child's fibers are torn down).
- Review r1: High 1 — the tool-call continue path called `compact("threshold")` and could execute a compaction where main only prepared; prepare-only semantics restored through the port with a test proving a continue step above threshold writes zero `compaction` rows while end-of-turn still compacts. Medium 5 — M1 the speculative-grace deferral applies to `yield` again (a window yield with a speculative summary in flight defers instead of launching a second summarizer), M2 the yield point is armed from the model window only, M3 `compaction-off.test.ts` now fails the second call as a real context overflow and asserts zero compaction rows: the first turn stops normally and the second settles with the original typed provider failure (a successful second turn is impossible under the no-retry contract with compaction off), M4 `DEFAULT_TOOL_OUTPUT_ELISION` is no longer exported and elision is tested by behavior, M5 this stamp and this section replace the stale `applyCompaction` description. Lows carried as PR comments.
- Verification: packages/agent 1441 pass / 0 fail (217 files), apps/oni 846 / 0 (117 files); check-types, lint, lint:tools, check-deps, check-import-cycles, check-dead-exports, check-journal-writers, check-written-types and check-comment-residue exit 0; the full local gate (`gate-1353.log`) exits 0 on the reviewed head. Four app bundle-list pins gained the shipped `compaction-summarizer` / `compaction-strategy` bundles (test-only).

## #1457 verified driver facts match automation triggers (epic #1337 follow-up)

On `fix1337/1457-driver-trigger-contract` (2026-10-13, base `e7677bbad`, PR #1461).
Webhook deliveries now emit `event: "webhook"` and the stored `secretRef`
that verified their HMAC. GitHub deliveries emit `event: "github"` and a
`githubEvent` key such as `pull_request.opened`. Both optional facts are
additive protocol fields, preserved by the unified input builder and selected
by the corresponding automation trigger. `Gateway.IngressFacts.event` is now
the same six-value enum as `Ingress.Input.event` (a widening of the wire
domain from message|reaction|mention); the channels-local `automation/facts.ts`
copy of that enum is deleted and the router consumes `Gateway.IngressFacts`
directly. `channelId` still identifies the webhook credential or GitHub
issue/PR, so channel conditions and grouping keep their meaning. Drivers
report facts only; the matcher does not accept `message` as a specialized
event.

Matching is still gated by the perimeter: a verified webhook or GitHub
delivery matches its trigger and produces an action only when the sender
passes `GatewayRouter.ingest`, that is when the kernel route is `route` or the
sender resolves to an identified actor with a trust tier (the
`automationActor` arm; the matched automation then grants the inbound). An
unidentified webhook or GitHub sender is still blocked at the channel ceiling
(`message.external.grant_tier`) with no automation row, and a GitHub bot
author is filtered by `rule/bot-author` before matching.

`packages/channels/test/automation-driver.test.ts` proves both branches
through the real signed drivers and the real router fixture: with an
identified observer endpoint, the webhook (valid HMAC) and GitHub (signed
`pull_request.opened`, `User` sender) deliveries execute with target
`worker`, one `action` commit whose origin is `automation/selected`, a
`route`/`surface_default` routing decision carrying `automation:selected`,
and one router-recorded `matched` ledger row; without the endpoint the same
deliveries return `blocked_pre message.external.grant_tier`, a
`channel_ceiling` block, zero commits and zero automation rows. Both positive
cases fail on the pre-fix matcher or pre-fix drivers.

## #1350 — alarm registry single owner and one chain fold (PR #1467, base `c99bb6d5c`)

- Registry owner: `composeAlarmPurposes` is defined once, in
  `packages/agent/src/plugins/alarm/index.ts`, and reaches the app only through
  `Bundle`; the core `ComposePurposesVerb` definition, its `core/api.ts` and
  `core/index.ts` exports and the compose-time injection are deleted (token
  count 2 → 0 across `packages/agent/src` and `apps/oni/src`). `plugins/alarm/**`
  imports only `core/api`; core imports nothing from `plugins/`.
- One chain fold: `packages/agent/src/core/session/alarm-read.ts` `foldAlarmChains`
  walks `historyPage` in 256-row pages over `(afterRevision, throughRevision]`
  and `openAlarmIds` drops reserved purposes and `at: null` retirements. It
  replaces the loop fold inside `core/session/run.ts` (`sessionStopEvidence`, now typed
  over `Pick<SessionKernel, "row" | "actionById" | "historyPage">`) and the app
  fold in `apps/oni/src/composition/alarm-plane.ts` (which aliases
  `Core.foldAlarmChains`). Equivalence was reviewer-compared against both
  deleted folds on revision bounds, reserved purposes, `at: null` retirement,
  matching versus superseded stale firings and occurrence identity;
  `packages/agent/test/alarm-read.test.ts` (4 cases) and
  `test/alarm-stop-evidence.test.ts` pin the divergence cases with stub kernels
  built through `SessionHistory.Page.parse` / `LedgerSession.Row.parse`.
- The former manual watch-retirement check is
  `apps/oni/test/monitor-retire-restart.test.ts` over the real WS/monitor
  path. `script/check-comment-residue.ts` pins lowered for `run.ts` and
  `plugins/alarm/index.ts`; the new `alarm-read.ts` is pinned at 0.
- Review r1: H2 (branch not rebased onto #1349; residue pins stale) and M2
  (comment churn outside moved code; type-erasing test casts) fixed on the
  rebased tip; 6 Lows recorded as PR comments. Stamp:
  `docs/agents-stamps/1350-alarm-registry-owner.md`.

## #1349 — three-line comment rule across packages/agent (PR #1449, base `2c3efdb0a`)

- Scope: `packages/agent/src`, `packages/agent/test`, `packages/agent/bench` plus `script/check-comment-residue.ts` and its test; nothing else (`git diff --name-only 2c3efdb0a..HEAD | grep -vE '^packages/agent/|^script/check-comment-residue'` is empty — this stamp is the lead's tail commit). The rung lands alone, after #1348, because every agent file it touches is also a rebase hazard for the other rungs.
- Rule applied: a comment survives only where it states a non-obvious invariant, a law reference or a why, in at most a few lines; narration of what the next statement does, restated signatures, `#NNNN` issue trails, `─` divider lines and JSDoc blocks over six lines are deleted or rewritten as ≤ 6 why-only lines. Every retained src comment line is ≤ 100 columns (biome `lineWidth`; r1 M3 found 140 over-width lines introduced by the rewrite and they were rewrapped).
- Zero behavior change is verified, not asserted: every edit went through a scratch line-range applier that refuses to write unless the file's TypeScript token stream (comments stripped) is byte-identical afterwards, and the whole-lane acceptance check re-verified all 236 touched agent files token-identical to the base. The src diff has zero non-comment lines (`git diff 2c3efdb0a..HEAD -- packages/agent/src` filtered to code lines = 0). Changed test files ran green behind the shared lock (792 pass / 0 fail across four batches), and the full local gate ran green on the pre-rebase tree (`gate-1349.log`, 13 steps / 11 lanes / patch coverage exit 0); the two rebases were comment-only merges whose CI run is the verification.
- Measured (src, `check-comment-residue --measure`): comment ratio 1426bp (3589 comment / 25168 non-blank lines) → 710bp (1659/23364); issue-number comment lines 156 → 0; `─` dividers 64 → 0; JSDoc blocks over six lines → 0 (core/session/entity.ts alone went 261 → 83 comment lines, 14 oversized JSDocs → 0). Test tree after: 2523 comment lines / 53606 non-blank (4.71%), issue-number lines 0, dividers 0, JSDoc>6 0.
- Gate: `script/check-comment-residue.ts` now carries a per-file `[issueNumberLines, dividerLines]` pin table over every agent src file, a package comment-ratio ceiling and a JSDoc>6 ceiling of 0, all equal to HEAD actuals (a pin above its actual is itself a violation: shrink only, never grow). The blanket `structuralHeaders` divider exemption is replaced by `durableByteNotes`: an enumerated list of (file, exact marker, reason) entries with a budget of 10, exempt only from the issue count and never from the ratio.
- Rebases: onto `ce36b8296` (#1347 added comments that broke the pins — trimmed to policy, not re-pinned upward: `05bf79c98`) and onto `2c3efdb0a` (#1348 split/moved eight test files — main's code taken verbatim, policy re-applied to the surviving comments), each followed by a shrink-only re-pin commit.
- Review: r1 High 0, Medium 3 — M1 (10 issue-ref/divider lines left in test + bench) removed, M2 (`writerLoop` lost its invariant note: RPC-only enqueue, arrival order, loss-free shutdown redelivery) restored as a 5-line note, M3 (over-width lines) rewrapped; Lows carried as PR comments.

## #1458 desktop ingress ledger winning-prompt link (PR #1460, base `b3d62bbc3`)

The ledger explorer links a `superseded` decision to the winning prompt using
that stored automation row's `target: "session:<id>"`. The automation ledger
returns only automation and group-close decisions; no separate routing row is
required or displayed. A row without a winning session has no prompt link.
The desktop fixture reflects those producer rows; the channels router test pins
that a real ingest stores the superseded row with the winning session target,
and the desktop test renders that row shape through production `LedgerRows`.

## #1456 Owner bootstrap for the shipped desktop connection (epic #1337 follow-up)

On `fix1337/1456-desktop-owner-bootstrap` (PR #1463, 2026-10-13, base `2c3efdb0a`).

- The desktop connects with URL + token and no actor declaration; the upgrade
  mints `connection:<uuid>`. Chat already admits that sender as the Owner from
  one fact (`admitWebSocketOwner`: no registered endpoint and the stored `ws`
  bootstrap grant's `defaultTier` is `owner`). The gateway's automation
  callback used to grant Owner only to tokenless sockets or an already
  registered Owner endpoint, so `automation_add`/`automation_enable` returned
  `require_approval` until chat registered the address, and every reconnect
  minted a new one.
- `packages/channels` exports `webSocketSenderTier(stores, externalId)` (the
  registered identity's tier, else the ws grant's `defaultTier`); chat's
  `admitWebSocketOwner` and the app's automation callback both read it, so one
  rule names the Owner's own connection. The old tokenless branch is gone: the
  same grant covers a tokenless loopback socket, and removing the grant
  (`oni-resident-ws`) makes both chat and automation fail closed.
- A declared socket keeps whatever its registered identity says (a registered
  collaborator still gets `require_approval`); an unregistered declaration on
  a token-authenticated socket resolves exactly as chat resolves it (the token
  is the Owner credential). Session callers are unchanged.
- Tests (`apps/oni/test/automation-wire.test.ts`): the fresh token socket
  on plain `/ws` with no pre-registered Owner runs add -> enable -> list twice
  across a reconnect with `createdBy: "owner"` results; the same socket without
  the bootstrap grant is refused `require_approval`.

## #1348 — agent test dedup and bare-throw narrowing (PR #1448, base `18ca03806`)

- Every positive bare `toThrow()` in `packages/agent/test` is narrowed to the class the code actually throws: 41 sites in 19 files → 0 (`rg --pcre2 -n '(?<!not\.)toThrow\(\)' -g '*.ts' packages/agent/test`). Each site was classified by running a scratch probe copy once (deleted afterwards, never committed) rather than guessed; the classification receipt is `lane-1348-throw-probe.txt` under the campaign evidence directory.
- Copied setup is replaced by scoped per-test fixtures under `packages/agent/test/helpers/` (seeded session, alarm budget/recovery, bus, hook, request port, fork seed, store fork, gate builders, request seeds, compaction evidence, disk stores, kernel rows, verdict/authority/model-message clones, tool wave, silent runtime, refused deliver) with teardown on every exit. `helpers/fixtures.test.ts` pins fixture isolation (fresh collectors per test), release on a failing body, child kill → `ESRCH`, and — after r1 M1 — that a released session handle refuses reads, so a leaked release makes the teardown pin fail instead of passing vacuously.
- The two oversized suites are split by responsibility behind shared harness helpers: `session-handle.test.ts` (2155 lines) → `session-handle.test.ts` (admission and turn sealing, 800), `session-handle-ownership.test.ts` (ownership and generations, 708), `session-handle-recovery.test.ts` (crash recovery and observation, 317); `session-lifecycle-conformance.test.ts` (1588) → 764 lines over `helpers/lifecycle-conformance.ts` (886). The largest agent test file is now `executor-recovery.test.ts` at 932 lines; none is over 1,000.
- Measured before/after on the same options (`jscpd --min-lines 5 --min-tokens 50`, agent test tree): 344 files / 140 clones / 1357 duplicated lines (2.38%) → 360 files / 33 clones / 213 duplicated lines (0.374%). Agent lcov line coverage 90.22% (LH 26231 / LF 29074, 281 src files) → 90.79% (LH 28059 / LF 30904, 294 src files): no drop. `.skip`/`.todo`/`.only`: 0. `sleep(`: 1 hit, `helpers/time.ts:19`, the test Clock's own `sleep` implementation present at the base — no new sleep.
- Scope: `packages/agent/test` only, 88 files, +4971/−5309 over 13 commits; test LOC 57733 → 57394; `git diff --name-only 18ca03806..HEAD | grep -v '^packages/agent/test/'` is empty (production code, `packages/channels` and docs untouched; this stamp is the lead's tail commit). One pre-existing failure was observed and left alone: `test/core/execution/tool-output-projection.test.ts` 1 MiB bounded-row case on the pre-#1347 tree (fixed by #1347's row byte cap, not by this PR).
- Review: r1 High 0, Medium 2 — M1 (teardown pin could not fail) fixed in `ab7028617`, M2 (PR body facts) re-measured and re-posted; 12 Lows carried as PR comments. Gate: the local gate ran the package, app and script lanes plus the patch-coverage step with exit 0 (`gate-1348.log`).

## #1428 nine-bundle app layout

The app has eleven bundle directories under `apps/oni/src/bundles/`: alarms, approval-policy, compaction, core-policy, delegation-policy, hooks-json, messaging, prompt, provision, resident, and tools. These are the nine from the #1428 proposal plus approval-policy and hooks-json, which #1346/#1256 had already landed as bundles; imports, test paths, and tool globs relocated without behavior changes. `script/check-deps.ts` pins the existing sibling-bundle and direct bundle-to-app-module findings by exact import identity; new edges and pin slack fail closed, and #1454 tracks removal of those edges. `script/lint-tools.ts` accepts the nested `bundles/tools/<tool>/index.ts` form while checking the directory against the catalog tool name.

## #1341 app wiring for rule-based ingress automation (epic #1337, rung 4)

On `epic1337/1341-app-wiring` (2026-10-13, base `033258aae`, PR #1446).

- `provision` gains `automation_add`, `automation_remove`, `automation_enable`,
  `automation_disable`, `automation_list` (`src/bundles/provision/automation.ts`,
  schema in `automation-schema.ts`); the gateway exposes the same five as
  one-to-one methods plus read-only `automation_ledger`, the contract #1342's
  desktop editor consumes. Authority is owner-only, derived from the socket
  actor's trust tier, never from the request (#1446 r1 H2).
- `src/composition/automation-wire.ts` answers every request with a typed value
  (refusals included, no throw); `automation-judge.ts` binds the optional fast
  model (`ONI_FAST_MODEL_ID`) to the channels judge port;
  `automation-alarm.ts` registers the alarm sender once per session and types
  malformed payloads as `AlarmWakeError`; `automation-delivery.ts` lands
  `prompt|action` rows — target `new` composes the #1346 create-session
  RPCs, a missing `session:<id>` target records `refused target_not_found`.
- Channels fixes landed with the wiring: missing-channel routes are granted only
  after a matched record (r1 H1); schedule triggers match `cron:<expr>` ticks
  only, never a `monitor:` alarm channel (r1 M4); `AutomationConfigurationError`
  and `scheduleTickChannel` join the package barrel.
- Snapshot baselines (`script/conformance/tool-schema-snapshot.json`,
  `schema-snapshot.json`) grew by the five provision ops; additive, recorded for
  Owner sign-off in `[ino]` issue #1450.
- Verification: review r1 H1-H2/M2-M7 fixed and lead-verified from the diff
  without r2; post-rebase CI reds were three stale test expectations; CI green
  at merge. Receipt names #1434.


## #1347 — restore budget, persisted step budget, strikes, row byte cap (PR #1445, base `c99bb6d5c`)

- `fold.checkpoint` rows carry `budgetState`; the checkpoint policy (`everyActions`, `maxTailBytes`) lives in `session.configure` settings. A crash-open reactivation resumes its step/budget counters from the checkpoint through `createSessionChatRunner` and stops with the existing `AgentStopError{reason: "budget"}` before any model call (the reactivation test drives `createController(...).reconcile()` over reopened SQLite files and fails when the `budgetState` hand-off in `run.ts` is removed).
- The writer keeps the restore tail under `maxTailBytes` (`commitFoldBatch` checkpoints by count or bytes); the activation restore (`restoreSessionHistory`) refuses a longer tail with a typed `RestoreRefused`; restore telemetry is logged from `core/session/recovery.ts` and never reaches model context. A folded state past the row cap degrades explicitly: the store's typed `row_bytes` refusal of the writer's own checkpoint is logged with `sessionId`/`checkpointId`/`checkpointBytes` and the caller's rows commit without it.
- `armed_alarms` gains a strike counter: `strikeArmedAlarm` increments in its own transaction (no journal row) and the entity settles an occurrence unexecuted at `MAX_OCCURRENCE_STRIKES = 3`; session-file schema is `SESSION_FILE_SCHEMA_VERSION = 2` with a probe-side v1 upgrade, and a file written by a newer build refuses to open with `CatalogVersionRefused{operation: "openSessionStore"}` (no read-only `query_only` fallback remains).
- Every journal row is capped at `DEFAULT_ROW_BYTE_CAP = 1024 * 1024` bytes of payload at the `sqlite-l0-write.ts` append boundary (typed `SchemaRefused{reason: "row_bytes"}`, zero rows written); the `tool.post` decision row records the projected (bounded) result so it fits; the boundary test pins literal bytes (`1_048_576` commits, `1_048_577` refuses) rather than mirroring the constant.
- The process-session child provides `Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)])` through the new `AppRuntimeOptions.logger` (provided under the whole runtime layer so cluster-host fibers inherit it): the child's stdout is the parent's JSON-lines wire, and the restore log would otherwise fail the parent's `JSON.parse` and restart the entity on every activation (CI `oniApp` lane; `process-session-e2e` 9/1 → 11/0).
- Scope: `packages/agent` (27 files), `packages/protocol` (4: `ledger/l0.ts`, `journal/core/session-configure.ts`, `journal/index.ts`, `storage/index.ts`), `script` (2: `check-comment-residue.ts`, `conformance/schema-snapshot.json`), `apps/oni` (2: `src/runtime.ts`, `src/process-entry.ts`); 35 files over 16 commits; zero edits under `packages/channels`.
- Review: r1 H1–H3 and M1–M5 fixed in 8 follow-up commits (one per finding plus one H3 band follow-up keeping `entity.ts` under its `check-deps` pin); Lows carried as PR comments. CI round: comment residue trimmed to the 1424bp ratio pin, written `unknown` test locals replaced by typed narrowing, child stderr logger. Gate: the codemode lane was rerun alone after a Chromium launch timeout under host load (47 pass / 0 fail).

## #1342 desktop automation editor and ingress ledger explorer (epic #1337, rung 5)

- `apps/desktop/src/renderer/gateway/` transport gained six typed methods over the
  existing WebSocket: `automation_add`, `automation_remove`, `automation_enable`,
  `automation_disable`, `automation_list`, `automation_ledger`; replies are
  `*_added/removed/enabled/disabled/listed` and `automation_ledger_read` or the
  shared `*_refused`
  frame. Every request has a bounded wait; a missing or malformed reply resolves
  to a typed refusal and re-enables the list (#1447 r1 M2).
- `renderer/automation/{editor,triggers,conditions,view}.tsx`: record editor for
  the `Ingress.Automation` contract; `invalid_record` issues (local and server)
  render next to their field; `require_approval` and refusals are shown, never
  retried.
- `renderer/ingress-ledger/{rows,view}.tsx`: ledger explorer over
  `automation_ledger` requests / `automation_ledger_read` replies (range/page
  bounded); a grouped row links to the
  `matched` row sharing its `group:<id>` fact, the shape `packages/channels`
  `router/automation/groups.ts` writes (#1447 r1 H1).
- Fixture preview lives only in `apps/desktop/test/automation-preview.{tsx,html}`
  and helpers; no mock data in the renderer; `sqlite` appears 0 times in
  `apps/desktop/src`.
- Verification: 113 desktop tests at delivery, 40 changed-file tests and six root
  gates after the review fixes, eight light/dark × desktop/narrow captures with
  no horizontal overflow; live-gateway integration is covered by #1341's wire
  tests, not by desktop tests.


## #1352 model-call layer extracted to `@oni/llm` (epic #1356, rung 5)

On `epic1356/1352-llm-package` (2026-10-13, base `c99bb6d5c`).

`packages/agent/src/model/` (provider resolution and adapters, the stream-event processor, usage accounting, credential storage, the `ai@7.0.93` pin and the provider majors) and its tests moved by `git mv` into the new `packages/llm` workspace (`@oni/llm`, depends on `@oni/protocol` only; `Provider` is package-internal, `Model` survives only as protocol `Model.Ref`). The dependency is reversed from the pre-#1246 package: the core declares the port in `packages/agent/src/core/ports/llm.ts` — the `Llm` tag keeps its `@oni/agent/Llm` key, `LlmPort { resolveModel(ref, now), run(input, sink), classifyFailure(facts) }`, `LlmSink`, `RunInput`, `ResolvedModel`, a `_tag`-identified `LlmRunFailure` and the closed `FailureClass` (`aborted | overflow | retryable{reason, afterMs?, directed, instant} | terminal{reason, code?}`) — and `packages/agent` never imports `@oni/llm`, `ai` or `@ai-sdk/*` (`script/check-deps.ts` workspace table and core band). `core/loop/retry.ts` keeps the retry decision: reason codes, the 60s directed and 30s ladder caps, the instant-failure streak, the 3-attempt cap and overflow -> compaction producer; `runAttempts` takes a `classify` callback and `turn.ts` asks the port about a successful stop that showed nothing, so a usage-proven overflow enters the same recovery; a stop that already showed output is the answer and is never replayed (the between-turn compaction trigger owns that window, as before). An error result whose payload is not a typed failure settles as a terminal `AgentFailure`, not a retry input. `makeLlmService(authFilePath)` in `packages/llm/src/services.ts` is the port value; `apps/oni/src/runtime.ts` binds it to `Core.Llm` (`LlmLive`), `composition/completion.ts` classifies through the bound port, and `observation/llm-failure.ts` maps the class to a `ProviderReason`. `classifyFailure` is pure: overflow for a declared or text-matched overflow, a normal stop whose input + cacheRead exceeds the window, or a length stop with zero output at >= `NEAR_WINDOW_RATIO` (0.99, named once) of the window; missing usage never reclassifies. The agent test suite runs against the port-only fake (`packages/agent/test/helpers/fake-llm.ts`, whose classifier mirrors the real one: no provider cause is terminal); the shared seven-signature `ai` mock lives in `packages/llm/test/helpers/retry.ts` only. New tests: `packages/agent/test/core/llm-port.test.ts` (facts, directed delay, terminal, overflow routing, the silent and the visible stop), `packages/llm/test/failure-classification.test.ts`, `packages/llm/test/run.test.ts` (one attempt per invocation); `packages/llm/test/retry/retry.test.ts` relocated; `packages/agent/test/core/provider-retry-ownership.test.ts` kept. Topology: `script/topology.ts` adds the `llm` workspace (nine workspaces; `apps/oni` may depend on it), `check-deps.ts` drops the model band, the `Model` namespace and the moved-file pins, `check-comment-residue.ts` drops the moved pins (the residue gate covers `packages/agent/src` only) and lowers the JSDoc ceiling 126 -> 109, `knip.json` and `.github/workflows/ci.yml` gain the lane, the AGENTS topology table is regenerated, and `script/effect-error-contract.test.ts`, `gate-discovery.test.ts`, `lint-side-effects.ts` and `generate-models-snapshot.ts` follow the moved paths.

Verification: `check-types`, `lint`, `script/check-deps.ts`, `script/check-topology.ts`, `script/check-comment-residue.ts`, `script/check-dead-exports.ts` and `lint:tools` on the branch; the changed test files of `packages/llm`, `packages/agent` and `apps/oni` run per file under the shared flock lock (never the whole suite); the issue's zero-hit searches (`from "ai"`/`@ai-sdk` and `../model`/`@oni/llm` under `packages/agent/src`, `from "ai"`/`@ai-sdk` under `packages/agent/test`, `@oni/agent` under `packages/llm/src`, the model band and `Model` namespace in `check-deps.ts`) return nothing. The full gate is lead-owned.

## #1346 one-call session creation and the four entity RPCs (epic #1356, rung 4)

On `epic1356/1346-create-session-four-rpcs` (2026-10-13, base `89b90b793`, PR #1444).

Session creation is one core call: `Core.createSession` (`packages/agent/src/core/session/create.ts`, `SessionStore.create`) commits the session-file genesis inside the catalog transaction, so the durable genesis and its catalog index row exist together or not at all, refusing typed `CreateRefused{duplicate | orphan_index | write}`; fork indexing is core-owned through `ForkPorts.catalog`. The app reaches a session only through the four entity RPCs: ingress and outbound commits ride the core execution ledgers (typed `CorruptRecord` on a missing receipt), `materializeDeliveryTarget` calls `Core.createSession`, interrupt is `Deliver{kind: "signal", control: "interrupt"}` (the app CAS/retry loop is deleted), and the process child forwards deliveries as `request_deliver` frames the parent commits through the entity. The `Core` barrel exposes `SessionHandleStore` as the curated read-only face only; `script/check-deps.ts` `validateAppsSessionWrites` bans session-store write receivers in `apps/**` except the exact `index.ts:1219 kernel.commit` (`tools.add` configure) line and the pinned `ingress-executor.ts` `Core.adoptedExecutor` perimeter exception. Verification tokens in `apps/oni/src`: `kernel.commit(`/`source.commit(`/`kernel.materialize(`/`plane.catalog.indexSession(` 2/1/1/3 → 0/0/0/0; scoped `.commit(` 5 → 1 and `.materialize(` 3 → 1.

Verification: lead gate `gate-1346.sh` on the PR head after the rebase onto `89b90b793` (log `.omo/evidence/ulw/01a11a6f-1bd5-7df9-b6af-92414dece7bb/core1356/gate-1346.log`); adversarial review r1 (`review-1346-r1.md`) and r2 (`review-1346-r2.md`): Gate (local, 2aa690c6c): 14 STEP/LANE/PATCH exits 0 in gate-1346.log; the packages/agent lane wedged under load 23 on 18 cores (114/114 timeouts, 0 assertion failures, no output after 15:40) and was killed, then rerun alone (hub 15:51 ruling, no full-gate rerun): LANE_EXIT packages/agent 0,  1787 pass  0 fail - logs gate-1346.log + gate-1346.agent.log under core1356/..

## #1345 core-owned ledger host (epic #1356, rung 3)

On `epic1356/1345-core-host-layer` (2026-10-12, base `25584f2d7`, PR #1442).

The ledger host moved into `packages/agent`: `core/session/host.ts` opens the catalog, per-session stores, the `effect/cluster` `SingleRunner` layer and the session entity behind `Core.openLedger` (a scoped Layer; one store-opening function carries the typed `OpenRefused`, and the plane finalizer is the catalog's only release). The plain plane constructor exists only as `Testing.openLedgerPlane` for test fixtures and is banned in `apps/**/src` by `script/check-deps.ts`; the `Core` barrel no longer exposes `openCatalogStore`/`openSessionStore`. `apps/oni/src/composition/cluster-runtime.ts` keeps configuration and consumes the Layer: retired tokens `openCatalogStore|openSessionStore|createSessionEntityLayer|createSessionEntityRunTurn|SqliteClient` in `apps/oni/src` 2/3/2/6/2 → 0/0/0/0/0; `@effect/sql-sqlite-bun` imports in app + channels src 1 → 0 and `effect/cluster` imports in app src 1 → 0. The one channels touch is the Owner-approved test helper `packages/channels/test/helpers/ledger.ts` (+18/−10: import switched to `Testing.openLedgerPlane`, a `close` and the session-file key mapping; no `packages/channels/src` change). `packages/agent/test/core/host.test.ts` covers file and memory modes, late port binding, open refusal, single catalog release, reopen over the same catalog/session files, and memory-mode passivation on the injected clock.

Verification: lead gate `gate-1345.sh` on the PR head after the rebase onto `25584f2d7` (log `.omo/evidence/ulw/01a11a6f-1bd5-7df9-b6af-92414dece7bb/core1356/gate-1345.log`); adversarial review r1 (`review-1345-r1.md`, H1 M4 L6) fixed in full by the r1 fix lane, r2 (`review-1345-r2.md`) r2 REQUEST_CHANGES H3 fixed in f65ba02ca..eb0e7d732 + 171b9371e; gate-verified GATE_EXIT 0 on 171b9371e, no r3 per rule 3.

## #1344 unified parallel core implementations (epic #1356, rung 2)

On `epic1356/1344-parallel-impls` (2026-10-12, base `7e05bb8d1`, PR #1408).

Five parallel implementations inside `packages/agent` collapsed to one owner each. Journal-visible text changes are confined to failure rendering and each is pinned by a test (review r1 M1/M2/L1/L4): tool and gate evidence carries `thrownAsError(cause).message` instead of `String(cause)` and `renderBodyCause` renders an empty-message Error as its name; `parsePlainJson` refuses `SchemaRefused{reason: "json", detail: <SyntaxError.message>}` instead of fabricating a row; `LlmRunFailure` evidence sets `providerErrorName` only for provider SDK errors (transport throws stay `null`); `model/run.ts` renders an empty-message error as its `_tag`. No journal kind, schema or row shape changes:

- Revision CAS: `core/session/entity.ts` `retryRevision` is the only bounded retry (three conflicting attempts, then the typed `AdmissionFailure{code: revision}`); `testing/controller.ts` calls it through the internal core import, and `AdmissionFailure` is a member of `SessionError` (pinned by `script/effect-error-contract.test.ts`).
- JSON: `core/store/storage/sqlite-l0-rows.ts` owns `parsePlainJson` (throwing — malformed text is `SchemaRefused{reason: "json"}`, schema failures stay typed) and `readPlainJson` (the degraded companion used by session-file and alarm-watch reads); `rg -n 'JSON\.parse' packages/agent/src` = 2 (the decoder and the module-private `core/loop/executor.ts` `clonePlainValue`, which must copy, not alias — pinned through an exported consumer).
- Causes: `rg -n 'String\((cause|error|err|e)\)' packages/agent/src` = 2 call sites (`thrownAsError` in `core/ports/failure.ts` beside `renderBodyCause`, and `model/model/loader.ts`, which wraps a non-Error catalog throw into the typed `ModelCatalogError.cause`); every other cause is typed `string | Error` (model causes, `RunFields.cause`, `HookSpawnError.cause`) with no new `Failure.fromCause` use, and AI SDK failures still wrap `APICallError` inside `APIError`. `model/auth/storage.ts` decodes the auth file with protocol `parseJson` inside a `safeParse` transform — a third decode owner, kept because `model/` may not import the core store (review r1 L6).
- Test-only options: `trackWave` and `extensionKinds` are gone from `core/loop/tool.ts`, `core/session/run.ts`, `plugins/tool/dispatch.ts` and `core/loop/executor.ts` (0 hits in src and test); `turn-dispatcher-coverage.test.ts` and `execution-verdicts-model.test.ts` observe real wave settlement and registered execution kinds.
- Clones: jscpd over `packages/agent/src` at the 50-token threshold reports 0 clones, down from 9 at the base (nine production pairs consolidated at their existing owners: shared turn ports, capability hooks, prepare-args tuple, `decisionOf`, `rewriteDoHow`, `unknownRef`, `GenerationSeed`, `openDeliveryRow`, `weightedMessageChars`, `sqliteNumeric`); dead-export ratchet unchanged.
- Cost: the always-zero required `cost` field is deleted from `Message.StepFinishPart` and `Message.AssistantMessage` (`packages/protocol/src/message/index.ts`), the step-finish stream producer, agent projections, fixtures and `script/conformance/schema-snapshot.json`; parts persisted with `cost: 0` still parse (field stripped, `packages/protocol/test/message.test.ts`). No rate table and no new journal row.
- Residue: the #1343 comment-ratio ceiling lowers 1425→1424bp in the same PR; `Bun.spawn|node:child_process` under `core/` stays 0.

Verification: lead gate `gate-1344-r1.sh` on the PR head after the rebase onto `7e05bb8d1` (log `.omo/evidence/ulw/01a11a6f-1bd5-7df9-b6af-92414dece7bb/core1356/gate-1344-r1.log`): build, check-types, lint, lint:tools, check-topology, check-deps, check-import-cycles, check-dead-exports, check-journal-writers, check-written-types, verify-tsconfig-inheritance, lint:docs, check-quality-python, the eight workspace test lanes, the three script lanes and patch coverage all exit 0; jscpd `packages/agent/src` 9 → 0; `check-comment-residue` OK at 1424bp. Review r1 (`review-1344-r1.md`, H0 M6 L6) fixed in full; r2 (`review-1344-r2.md`, H0 M1 L5) confirmed them and found one new Medium — a second `thrownAsError` copy in `model/model/loader.ts` — fixed by the lead before merge (loader on `core/failure`'s `thrownAsError`/`renderBodyCause`).

## #1340 automation matcher, judge port, grouping and perimeter store tables (epic #1337, rung 3)

On `epic1337/1340-matcher-judge-store` (2026-10-13, base `182a9fc27`, PR #1411).

- `packages/channels/src/automation/` is pure (no router imports): `rules.ts`
  and `matcher.ts` turn a matching `Ingress.Input` into a prompt or action
  route; `judge.ts` resolves `runWhen` conditions as `yes | no | unknown`
  before the final match (`unknown` never matches); `regex.ts` validates
  patterns at `store.add` (typed refusal, 512-character cap) and caches them.
- The router owns integration under `src/router/automation/`: one
  `input.ts` builder serves filtering and matching; `ledger.ts` records
  exactly one automation decision (`matched`, `filtered`, `refused`,
  `deduped`, `grouped`) per external event and emits one observation per
  new row; replay of any recorded kind writes no new row and returns the
  original decision; blocked routes and request answers never enter
  automation or groups.
- Grouped events are durable rows (`store/automation/`, SQLite adapter in
  `store/sqlite/`) that survive a store reopen; quiet windows close from
  the injected clock, which `apps/oni/src/index.ts` mounts via
  `composition/automation-clock.ts`. Prompt and action deliveries go
  through the ordinary dispatch path (policy gate, egress budget, event-id
  checks, `message.admitted`).
- `router/automation-rules.ts` replaces #1339's `router/ingress-filter.ts`;
  bot filtering writes only the automation ledger.
- Rule editing (`provision{automation_*}`) and the desktop editor are rungs
  4/5 (#1341, #1342). A non-firing automation never suppresses ordinary delivery;
  a failing group close is isolated to its group and recorded. Tests:
  channels 770 pass / 0 fail; apps/oni 782 pass / 0 fail.

## #1339 channel drivers report facts only and emit the unified ingress input (epic #1337, rung 2)

On `epic1337/1339-facts-only-drivers` (2026-10-13, base `6f9503ef1`, PR #1410).

- Slack, Discord, Telegram and GitHub normalizers emit `Ingress.Input` with
  `IngressFacts` author/event (bot flag, reactions, edits, pull-request events);
  Slack `message_changed` edits by the bot itself are dropped as self-echo.
- Fifth provider: signed webhook (`packages/channels/src/provider/webhook/`),
  composed in `apps/oni` with its own credential reader; webhook rows boot
  with their own schema.
- `router/ingress-filter.ts` records bot and reaction ignores as ledger rows
  before routing; `router/inbound-id.ts` is the single inbound-id helper; GitHub
  refused connections classify `not_sent` through the shared `isNotSent` rule.
- No automation policy or matcher yet (rung 3, #1340). Tests: channels 709 pass /
  0 fail; apps/oni green.

## #1338 protocol contracts for the unified ingress input, automation records and automation ledger decisions (epic #1337, rung 1)

On `epic1337/1338-protocol-schemas` (2026-10-12, base `d9800ad74`, PR #1409).

- Four Zod contracts under `packages/protocol/src/ingress/`, exported through
  the existing `Ingress` namespace, Effect-free and I/O-free
  (`rg -c -i effect packages/protocol/src/ingress/` prints nothing):
  - `Ingress.Input` (`ingress/input.ts`): the one normalized event every
    source produces — `eventId`, `surface`, `event` in
    `message | reaction | mention | webhook | github | schedule`, optional
    `channelId`/`threadId`/`workspaceId`, `author{externalId, isBot}`, `dm`,
    `mentionsBot`, `body`, `receivedAt`; strict object.
  - `Ingress.Automation` (`ingress/automation.ts`): the managed rule record —
    `createdBy` is `owner` or `session:<id>`, at least one `Trigger`
    (`schedule{cron, tz} | message{surface, event} | webhook{secretRef} |
    github{event} | on_demand`), optional `Conditions` whose list fields are
    non-empty (`channels`, `users`, `threads`, `contains`, `excludes`,
    `regex`) plus `includeBots`/`dm`/`mentionOnly`, optional `runWhen` prose,
    optional `grouping{windowSeconds in 0|5|10|20|30|60, by
    thread|channel|author}`, the delivery record `target` (`new` or
    `session:<id>`) × `kind` (`prompt | action`, default `action`), optional
    `instructions` for a new session, optional `limits.maxRunsPerDay`.
  - `Ingress.TriggerContext`: what a matched automation hands the session —
    `automationId`, the firing `trigger`, `matched{conditions, runWhen?{verdict
    yes|no|unknown, reason}}`, and the bounded event group (1..64 messages of
    `{eventId, body, receivedAt}` with surface/channel/thread/author).
  - Six automation ledger variants on `RoutingDecisionPayload`
    (`event/ingress.ts`): `matched | filtered | refused | deduped | grouped |
    superseded`, each strict with `stage: "automation"`, `outcome:
    "record"`, `by` matching `automation/… | rule/… | blacklist/…`,
    `factsDigest` (never a message body), optional `runWhen` and `actionSeq`;
    `recordedRoutingDecision` keeps upcasting persisted rows (regression test
    `persisted routing rows still upcast historical fields`).
- `Gateway.IngressFacts` (`gateway/message.ts`) gains optional `event`
  (`message | reaction | mention`) and `author{externalId, isBot}` so
  drivers can report the facts rung 2 normalizes from; existing facts parse
  unchanged.
- No consumer yet: channels normalizers (#1339), the matcher and judge port
  (#1340), the app provisioning and deliver plug-in (#1341) and the desktop
  editor (#1342) are the following rungs. No journal kind, gate point, tool,
  wire method or app/desktop file changes in this rung.
- Tests (`bun test packages/protocol`, 592 pass / 0 fail across 52 files):
  `ingress-input.test.ts` 8, `automation-record.test.ts` 22,
  `ingress-ledger.test.ts` 16, `ingress-facts.test.ts` 5; the routing suite
  under `test/ingress` is 76 pass.

## #1422 one delegation depth cap owner (lane D, umbrella #1421)

Merged `e8481ef66` (PR #1432). The message-policy depth row and the admission constant share one value: `ADMISSION_DEPTH_MAX = DEFAULT_DELEGATION_CAPS.maxDepth` (3) in the delegation-policy bundle; admission previously allowed one level deeper than the caps declared. The depth row lives in the catalog policy plane, where `seedKernelPolicyRows` (`apps/oni/src/bundles/core-policy/index.ts`) lets every stored row overwrite the default by id, so a catalog seeded before this change keeps admitting at its stored `max: 4`; only catalogs without the row (fresh installs) receive the shared value. Migrating stored rows is a follow-up on #1422. The tests assert the admission constant equals the caps' `maxDepth`.

## #1424 desktop journal-kind audit (lane D, umbrella #1421)

Merged `e86ae5eb0` (PR #1431). The 12-kind coverage table and the confirmed audit live on issue #1424 (https://github.com/INONONO66/oni/issues/1424#issuecomment-6128854787); the unreachable desktop `data-epoch` path is deleted and no renderer was added: every kind arrives as a payload-free page row, the live message frame carries no revision, and pages are not joined to chat messages, so no per-kind marker can be placed today. Which kinds to render, and how, stays a product decision listed on the issue with a recommendation.

## #1423 the app's Promise band is a declared three-module band (lane D, umbrella #1421)

On `app/1423-promise-band` (2026-10-12, base `c85607df7`, PR #1430).

The three `apps/oni` modules forced onto Promises or callbacks by an
external runtime API are declared as one band; each carries a head comment
naming the forcing API, the single Effect entry call, and what must never be
added there. Comment-only; zero behavior change; no lint or script added.

| module | forcing API | Effect entry call | verdict |
| --- | --- | --- | --- |
| `composition/watch-sources.ts` | `node:fs` `watch` listener callbacks, `Bun.spawn` PTY streams / `child.exited`, machines `pty.read` long-poll, daemon fs reads for child sources (#1511); the reconcile cadence is a `watch`-purpose alarm chain on the app alarm plane (#1426) | the one injected `WatchSenders` door — `deliver` for native hits, `admit` for child rows (both bound to `runAppEffect` in `index.ts`); the module never commits an arm row | keep |
| `composition/process-session.ts` | `Bun.spawn` stdin/stdout byte streams (`ReadableStream` reader, `child.exited`) | injected `answer` (`runAppEffect(runtime, requests.answer(...))`) | keep |
| `provisioning/supervisor.ts` | channels driver `surface.start` Promise contract (`stop` is synchronous; channels is the #1248 Promise band with its own injected `EffectRunner`) | the driver runner (`ChannelRuntimeDeps.run` = `runAppEffect`) that `deps.desired()` passes into each built surface; `.then(() => undefined, ThrownError.parse)` narrows the rejection to a typed Error that `mountRow` re-throws and `startRow` records as breaker status, never a swallow | keep |

Considered and excluded: `composition/alarm-plane.ts`, `composition/process-replies.ts`,
`composition/cluster-crypto.ts`, `gateway.ts` and the other `composition/*` layers use
`async`/`.then` only at the `runAppEffect` edge or inside Effect programs; `cli/*` is
the process-entry band that never touches session state; `tools/*` bodies are
Effect-free by the boundary law (`script/check-effect-boundaries.ts`) and speak the
machines IPC Promise API, which is the declared machines boundary.

## #1314 benchmarks measure the consolidated bus and store paths (epic #1303, rung 16)

On `stab/16-measure-bus-consolidations` (2026-10-08, base `4b36d0f73`, PR #1335).

- Production bus measured: `bench/bus-fanout` and the memory guard
  (`test/store/bench/memory-regression.bench.ts`) run on `makeObservationBus`
  (the real Effect PubSub inside a Scope), not the retired
  `helpers/observation` stand-in (`rg 'helpers/observation'
  packages/agent/bench packages/agent/test/store/bench` -> 0). Fanout acquires
  N subscriptions via `yield* bus.stream` before any publish, asserts the new
  read-only `bus.subscriberCount()` equals N before measuring, and settles
  each iteration on the exact N-th delivery; a short fanout throws the typed
  `FanoutShortfall` (watchdog outside the measured body), never hangs.
- One existence + one parent query per committed action: both checks live
  solely in `validActionBatch`; the commit loop and the single-append path
  write through module-private `appendValidatedAction` (query-spy test: a
  3-action batch runs exactly 3 existence queries and 1 parent query —
  in-batch parents resolve from the batch id set with zero queries). The
  single-append path keeps the #1252 fail-closed order: `refuseSchemaMismatch`
  runs BEFORE the existence/parent checks, so a duplicate-id +
  schema-mismatched action throws the typed `SchemaRefused`, never a silent
  `undefined` (regression test in `test/store/session/kernel.test.ts`).
- Linear summarizer trimming: the quadratic
  `estimateMessagesTokens(elided.slice...)` probe became a running
  weighted-char suffix total with one ceiling per probe — byte-identical
  rounding proven by equivalence tests against an inline quadratic oracle
  (500 over-budget messages, mid-list stop, exact-budget boundary, zero
  inputs) in `test/compaction/compact.test.ts`.
- Measured ns/op (`bench-16-before.json` -> `bench-16-after.json`, host runs
  on Darwin arm64 Apple M5 Pro, Bun 1.4.2, load recorded; not CI):
  bus-fanout/10-subscribers 619 -> 7641, bus-fanout/50-subscribers
  819 -> 42145, bus-fanout/100-subscribers 1093 -> 89022 (the measured
  surface changed from a stub to the real PubSub — the honest baseline the
  issue asked for); session-commit/action 123463 -> 70138;
  compaction/500-messages 3007810 -> 3086723 (+2.6%, host noise).

## #1319 legacy gate rows cut over to a versioned writer (epic #1303, rung 12)

On `stab/12-legacy-rows-cutover` (2026-10-08, base `2dc31be78`).

- Writer: `packages/agent/src/core/ports/gate-rows.ts` owns gate-row identity
  minting — `GATE_ROW_WRITER_VERSION = 1` and `gateRowId(row, point, ordinal)`
  returning `<name token>/<point>#<ordinal>`, where the name token is the
  row's free-form name projected onto the protocol `GateRowId` grammar
  (runs outside `[a-z0-9]` collapse to `-`, non-letter starts gain `row-`),
  so bundle-seeded names (`hooks-json/tool.pre#3`) and dotted message names
  mint schema-valid ids. `project.ts` mints every projected row id through
  it; the ordinal is the row's index in the priority-sorted projection
  order, so same-name (and same-token) rows on one point stay distinct.
- Snapshot version: protocol `SessionGeneration.Snapshot` gains the optional
  `rowsVersion`; `fence.ts` `generationSnapshot` (the one snapshot
  constructor) records `rowsVersion: 1` on every new materialization.
  Pre-cutover snapshots parse with the field absent — never defaulted.
  Measured: `rg -n 'rowsVersion' packages apps -g '*.ts' | rg -v
  'fence.ts|rows.ts|protocol/src|test/'` → no output (one writer).
- History: decision facts recorded under pre-cutover ids keep their bytes —
  they decode (`SessionHistory.PolicyDecision`) and replay (`GateDecision`
  by recorded `inputHash`) without rewriting `matchedRuleIds`/`rowIds`.
  A pre-existing session file read after the cutover is byte-identical
  (sha256-verified); a freshly materialized generation records
  `rowsVersion: 1`.
  A pre-cutover record that applied a CONTEXT-MATCHER row does not replay
  (the live entry's current id is absent from the recorded legacy rowIds):
  the gate decides fresh; in `recoverAdmission` an approval pending across
  the upgrade refuses fail-closed (`stale_approval`) — accepted, recorded
  deviation (#1319 review M1).
- Rename: `legacy-rows.ts` → `row-parse.ts` (`git mv`; the parser was never
  legacy), imports rewritten in `compile.ts`, `evaluate.ts`, `project.ts`;
  no re-export alias. Measured greps: `rg -c 'legacy/' -g '*.ts' packages
  apps` 1 → no output; `rg -c 'legacy-rows' -g '*.ts' packages apps` 5 → no
  output.
- Tests: `packages/agent/test/core/gate-row-writer.test.ts` (4 pass:
  schema-valid identities + same-name ordinals, production-shaped names
  (bundle id, dotted) parse and re-admit, pre-cutover decode/replay with a
  matcher-row fixture, snapshot version); `generation-policy.test.ts`,
  `permission-row-migration.test.ts`,
  `apps/oni/test/policy-seed-rows.test.ts` pass unchanged.

## #1311 delegation lifecycle contract — typed cap refusals + once-only child settlement (epic #1303, rung 14)

On `stab/14-delegation-lifecycle-contract` (2026-10-08, base `2dc31be78`).

- Envelope: `Gateway.DelegationResult` in `packages/protocol/src/gateway/message.ts`
  (strict: `status: completed|failed`, `preview` max 4096 characters, `pointer: {session, action}`),
  exported through `MessageContract`; 3 parse-failure tests
  (`packages/protocol/test/send-message.test.ts` 16 pass). Protocol stays Effect-free.
- Typed refusal: `DelegationRefusal` zod in `apps/oni/src/bundles/delegation-policy`;
  `capVerdict` deny payloads carry `reason: JSON.stringify(refusal)` as the single carrier so the
  canonical `delegation_refused` JSON reaches the model through the consulted-guard seam
  (`gate/evaluate.ts` → `ToolRefused`) with zero core gate/dispatch edits.
- Settlement: `parentReply` → `settleChild` (`rg -c parentReply packages apps` 19 → 0);
  waiting AND interrupted seals return undefined (interrupted leaves the parent's
  commission request OPEN — the deadline path bounds a silent child), `result`/`error`
  build the `DelegationResult` envelope (preview sliced to 4096 characters) and send it
  `delivery: "followUp"` (`SessionTransition.OutboundMessage` optional field, forwarded by
  `composition/message-session.ts`); `core/session/run.ts` guards once-only settlement (existing
  outbound rows targeting the parent → skip), so interrupt-then-resume settles exactly once.
- Tests: `delegation-policy.test.ts` 12 pass (typed refusal parse, settleChild arms,
  truncation), `send-message-e2e.test.ts` 6 pass (exact-event trace: parent turn seals →
  followUp delivery → settlement turn; interrupt-resume single settlement; composed cap
  denial parses `DelegationRefusal` off the ToolRefused content; 0 setTimeout),
  `message-terminal-boundaries.test.ts` 4 pass. Base repair: `approval-policy.test.ts`
  missing required `alarms` manifest field (pre-existing type error on the synthetic base).

## #1305 bounded tool output projection (epic #1303, rung 15)

On `stab/15-bounded-tool-output-projection` (2026-10-08, base `2dc31be78`).

- Protocol: `ToolOutputRef`/`toolOutputRefSchema()` + `TOOL_OUTPUT_PREVIEW_MAX_BYTES`
  in `packages/protocol/src/tool/result.ts` (Effect-free: `rg -c 'from "effect"'
  packages/protocol/src/tool/result.ts` -> no output); `Settings` gains optional
  `toolOutputBudgetBytes`.
- Store: `tool_outputs` table (output_id PK, bytes, media_type) in the session
  file; `SessionStore.toolOutputs.put` is INSERT OR IGNORE (identical bytes
  store once); fork copies only referenced outputs inside the same child
  transaction and counts their bytes against `forkCopyByteCap`.
- Core: `projectToolOutput`/`projectResultValue` in `core/ports/tool-output.ts`
  replace the deleted `truncate`/`MODEL_OUTPUT_MAX_CHARS`
  (`rg -c 'MODEL_OUTPUT_MAX_CHARS|bytes dropped|function truncate' -g '*.ts'
  packages apps` -> no output; base counts 4/6/1); the gate projects the
  committed `result` to `{outputRef}` while `resultHash` stays the full-value
  digest and `revert` survives beside the ref; the dispatcher renders
  preview + `[output <id>: <n> bytes; read with tool_output("<id>")]`.
- Readers: `Inspect.toolOutput` (typed `unknown_output`), optional `outputRef`
  on `session_read` page action rows, and the codemode prelude
  `tool_output(output_id)` over a host op (`CodemodeOptions.toolOutput`) - the
  12-factory catalog stays sealed, no new journal kind.
- Bus: `publish` skips `publishUnsafe` when no subscriber holds matching
  interest for the event name (interest counted per event name; the wildcard
  `observations` surface counts for every name; publish-time `match`
  predicate evaluation is deliberately omitted - the stream still filters by
  `match` on the consumer side, recorded deviation from #1305 solution 6);
  `onPublish(eventName, delivered)` seam for rung 16 measurement
  (`packages/agent/test/core/bus.test.ts` zero-publication and
  non-matching-name cases).
- Config: `ONI_TOOL_OUTPUT_BUDGET_BYTES` -> `resolveToolOutput` ->
  genesis `session.configure{settings.toolOutputBudgetBytes}`
  (`apps/oni/test/tool-output-budget.test.ts` through the shipped
  composition).
- Measured (1 MiB fixture, `packages/agent/test/core/execution/tool-output-projection.test.ts`):
  row bytes before projection 1048770, after 16617; read-plane / row-event
  proxy (the serialized history-page action node - size-faithful to the
  committed-row `ActionCommittedEvent` payload, not a captured bus event)
  before 1049184, after 17030; the stored bytes read back whole through
  `Inspect.toolOutput` and the codemode `tool_output` (1048576 bytes).
- Kept reader: `rg -c 'toolResultText' -g '*.ts' packages apps` sums to 23.

## #1315 retire the input-queue and job-title vocabulary (epic #1303, rung 11)

On `stab/11-retire-inbox-worker-vocabulary` (2026-10-08, base `4b36d0f73`).

- Rename (no alias exports): protocol `Inbox` namespace -> `Delivery`,
  `inboxId`/`inboxIds`/`inboxKind` -> `deliveryId`/`deliveryIds`/`deliveryKind`,
  `LedgerSession.Role` `worker`-byte -> `child`; agent core/plugins/tests,
  channels router/store, codemode/machines Python prelude (`max_concurrency`
  kwarg), apps/oni composition/tools/policy-seed/message-policy
  (`message.child.*` ids, tool visibility `child`) and the desktop `inbox`
  route -> `automations` all follow (231 files). Ingress drops the retired
  string/object subordinate target with a typed parse refusal
  (`packages/protocol/test/ingress/target.test.ts`).
- Versioned reads (#1315, read-side folds deleted by #1351): prompt/signal/turn
  declarations stay at version 2 and stored bytes stay frozen, but
  `foldDeliveryPayload`, `LedgerSession.foldLegacyRole`, `V1_DELIVERY_FIELDS`,
  `LEGACY_CHILD_ROLE` and `LEGACY_INGRESS_POLICY_KIND` grep to zero; the
  session-file pending/input SQL reads only `deliveryId`/`deliveryIds`/
  `deliveryKind`. The real-data gate that makes the deletion safe (every Owner
  session file carries zero version-1 delivery fields) is the Owner receipt
  tracked in #1466.
- Catalog v3 -> v4 (#1351, `CATALOG_SCHEMA_VERSION` 4): one `immediate`
  transaction rewrites exactly the retired bytes — `session_index.role` and the
  `policy.match` paths `$.role`, `$.message.senderRole`, `$.message.targetRole`
  `worker` -> `child`, pre-phase `policy.kind` `inbox.deliver` -> `ingress` —
  then copies rows into tables whose CHECK constraints exclude the retired
  values; any other off-vocabulary byte or key collision fails the whole
  transaction with the typed `CatalogUpgradeRefused` and leaves the file at
  `user_version` 3 byte-identical (`packages/agent/test/store/catalog-upgrade.test.ts`,
  `packages/agent/test/alarm-recovery.test.ts`). The Owner catalog backup
  before the first v4 boot is also #1466.
- Legacy bytes now appear only inside the v4 upgrade literals in
  `packages/agent/src/core/store/catalog.ts` and the tests that prove each is
  rewritten or refused; `rg '\["in", ?"box"\]'` and `rg '\["wor", ?"ker"\]'`
  stay 0.
- Deliberately kept wire-frozen vocabulary: `Actor.Kind internal_worker`,
  `TrustTier assigned_worker`; third-party names untouched: Playwright
  `workers: 1`, Python stdlib `ThreadPoolExecutor(max_workers=…)`.
- Conformance snapshots (`script/conformance/*.json`) and `crash-matrix.json`
  crash points refreshed to the renamed enum; `bun run lint:tools` passes.
- Follow-ups (not in this rung): a pre-merge session-file fixture e2e over the
  version-1 fold (the fold is unit-tested and the v2->v3 catalog rebuild is
  integration-tested) — recorded in the epic receipt.

## #1309 executable product policy moved into app bundles behind seams (epic #1303, rung 9)

On `stab/9-core-policy-to-bundles` (2026-10-08, base `c11ae7148`).

- Seam: `packages/agent/src/core/composition/approval-policy.ts` declares `ApprovalPolicy`
  (plain data: `responders`, `recentOpen{limit, windowMs}`, `defaultExpiryMs`,
  `defaultBudget`) plus `ApprovalPolicySeam`, exported through the root `Core`
  namespace (`core/index.ts`; no plugin consumes it, so it never reaches the
  `core/api.ts` plugin surface). No callbacks, no defaults in core.
- Core purge (measured): `rg -n '\["owner"\]|count >= 8|3_600_000|86_400_000|BUDGET_DEFAULTS'
  packages/agent/src/core` → no output; `rg -c 'BUDGET_DEFAULTS' -g '*.ts'
  packages apps` (7 before) → no output; `rg -n '86_400_000'
  packages/agent/src/core` (1 before) → no output; `rg -n
  'expectedResponders: \["owner"\]' packages/agent/src` (1 before) → no
  output. `exceedsApprovalBudget`/`sessionOpenApprovalCount` take `limit`/`windowMs`
  as parameters from the command's resolved policy; the count is per session
  file, not global.
- Threading: `createApprovalRequest` takes `responders`; the gate expiry chain
  is `binding.timeoutMs ?? options.approvalTimeoutMs ?? policy.defaultExpiryMs`;
  `budget.ts` lost `BUDGET_DEFAULTS` — the loop resolves
  `resolveAgentBudget(policy.defaultBudget, budget)` once at entry and
  `ChatAgentConfig.defaultBudget` is required. The policy rides required
  ports: `SessionRuntime.approvalPolicy`, `SessionEntityPorts.approvalPolicy`,
  `ExecutorOptions.approvalPolicy` (no optional fallbacks).
- Product bundle: `apps/oni/src/bundles/approval-policy/index.ts` owns the
  shipped literals (`["owner"]`, 8 per 3,600,000 ms, 86,400,000 ms, 24 turns /
  40 tool calls / 5 min wall / 2 min tool wall) and provides the seam;
  `appManifest` lists it (six bundles). `send-message` requires the seam, so a
  manifest without the provider refuses typed `seam_missing` at compose — no
  silent in-core fallback.
- Tests: `packages/agent/test/approval-policy.test.ts` (4 pass: quota
  injection limit 2 vs 3, responders land verbatim with the injected expiry,
  default-budget resolution with per-field explicit wins, `seam_missing`
  compose refusal) and `apps/oni/test/approval-policy.test.ts` (3 pass:
  shipped values through the bundle's `index.ts`, default compose includes the
  provider, stripped manifest refuses `seam_missing` naming `send-message`).
  `delegation-policy.test.ts` unchanged and green; durable request bytes
  unchanged (`packages/protocol/test/request-schema.test.ts` 2 pass, zero
  snapshot churn).

## #1308 one composition root: sealed boot options, single monitor declaration, entity-drained process child (epic #1303, rung 10)

On `stab/10-composition-root-dedupe` (2026-10-08, base `0373ed38c`). Boot
options carry no tool list: `StartOptions`/`ResidentOptions` lost
`toolDefinitions` (`rg -c 'toolDefinitions' -g '*.ts' apps/oni` prints
nothing) and app tests that need an extra tool declare it through a test
manifest bundle (`appFixture`'s `bundles` option / `testToolsBundle`), so the
12-factory catalog is the manifest's tool projection and nothing else.
`monitor` is declared once, by `monitorBundle`: `createMonitorTool` appears
under `apps/oni/src` only in `bundles/monitor/index.ts`,
`catalogDefinitions` returns 11 factories, and the generation-construction
name-collision keep rule is replaced by the typed `duplicate` compose refusal
(`manifest.test.ts` pins a two-`monitor` manifest refusing closed). The dead
`monitorSeedRows` export is deleted (`rg -c 'monitorSeedRows' -g '*.ts'
packages apps` prints nothing); tests seed the composed wake-budget row via
`gateRowPolicySeeds` over the monitor bundle's rows.

The process child is a transport into the same root: `ProcessSessionRequest`
grew `hooksPath`/`off` (the #1306 name), the child rebuilds `config -> manifest ->
compose` and boots `gatewayRuntime` with the composed holder (its generation
lists the five shipped bundles), and `process-entry.ts` holds no admission
loop — it binds `SessionEntityBinding` (inline detach: the child owns the
whole turn's lifetime, a typed turn failure is recorded and surfaced as the
child's non-zero exit, and a failure that left the journal unmoved dies as a
wiring defect) and wakes the session entity once through the entity client's
entity-internal `rescan` Alarm, so fence rotation, consume folds and
passivation arming belong to the entity alone (`rg -c
'decideSessionAdmission' apps/oni/src/process-entry.ts` prints nothing).
`emptyComposition` is deleted and `AppRuntimeOptions.composed` is required;
`cli/main.ts` hands `startOni` the config only, and
`test/helpers/generation-services.ts` composes its own empty manifest.
`packages/agent/test/helpers/composition-fixtures.ts` and
`apps/oni/test/composition-drift.test.ts` are deleted; the five
shipped-behavior suites moved to `apps/oni/test`.

Ruled deviations: the send-message bundle also declares its tool on the base
catalog, so the duplicate-name compose refusal exempts `send_message`
(folding it is its own issue); `app-surface.test.ts` was a seventh
`toolDefinitions` site; `packages/agent/test/helpers/session-services.ts` was
the seventh composition-fixtures consumer and now rides a reply-seam stub.
Implementation deviation: the child surfaces the first typed turn failure
after the entity wake instead of deferring consume decisions to the parent
(the old `process drain deferred consume` path is gone — the entity fold owns
them), pinned by `process-session-e2e.test.ts`.

## #1313 typed idempotency_conflict and seam_missing deliver refusals (epic #1303, rung 13)

On `stab/13-typed-admission-idempotency` (2026-10-08, base `c11ae7148`).
The session entity's `deliver` door no longer reports success for a replayed
idempotency key whose payload differs and no longer falls back to the core
input table when the composed `inputRegistrations` port is unbound. A replayed
key's candidate and recorded action are serialized by the journal writer
(`packages/agent/src/core/store/action-row.ts`) and compared byte-for-byte over
the payload columns: equal returns `{seq, existed: true}` with zero new
facts; different fails typed `DeliverRefused{code: "idempotency_conflict"}`
before `decideSessionAdmission`, so nothing is appended and the loop is not
woken. The inner `appendReceived` dedupe branch applies the same comparison,
so any caller reaching the writer gets the same answer. An unbound
`inputRegistrations` port fails typed `DeliverRefused{code: "seam_missing"}`;
the `?? CORE_INPUT_REGISTRATIONS` fallback is deleted together with the const
(no remaining reader). `DeliverRefused.code` is exactly `unknown_kind |
missing_key | closed | denied | idempotency_conflict | seam_missing`.

Measured greps at head: `rg -c '\?\? CORE_INPUT_REGISTRATIONS' packages apps`
0 (was 1); `rg -c 'CORE_INPUT_REGISTRATIONS' packages apps` 0; `existed: true`
in production exactly 1 (`entity.ts`, identical-replay path; was 1) plus test
hits only; `setTimeout` in `deliver-idempotency.test.ts` 0; `Bun.spawn|
node:child_process` in `packages/agent/src/core` 0. Test helpers and app
fixtures bind `inputRegistrations` explicitly, so no production default
remains. `bun test packages/agent/test/deliver-idempotency.test.ts` 5 pass /
0 fail; `rpc-surface.test.ts` + `session/entity-admission-refusal.test.ts`
11 pass / 0 fail. No new journal kind, tool, gate point or wire method;
durable bytes of existing rows unchanged.

## #1312 unused helpers and silent fallbacks replaced by typed outcomes (epic #1303, rung 5)

On `stab/5-delete-fallbacks-dead-helpers` (2026-10-07, base `350612bff`, merged
with main `c68c9de5a`). Three lane branches (bands A/B/C) merged into one PR.

- Band A — protocol, machines, codemode, app tool bridge:
  `JsonShapedValueSchema` validates values at runtime (the unconditional
  `acceptJsonShapedValue` is gone) and the four `EvaluationRequest` record
  fields are JSON-shaped; host and daemon share one `isContained` export
  predicate (the trailing-slash disagreement is gone); a PTY command that times
  out removes its FIFO entry on the injected clock, so a late reply is dropped
  and the next command gets its own reply (TestClock test); `peekCode` with
  no runner refuses `kernel_not_available` beside `runCode`; the IPC callback
  dispatcher takes a required injected bound and refuses with a typed
  `IpcQueueFullError` (test helper bound 256, matching the app composition);
  host `callTool` is required and its absence is `host_tool_missing`;
  computer-use failures carry `spawn_failed | read_failed | probe_timeout`
  instead of `undefined`; the Python `_shutdown`/`_stop_chromium` paths
  return failure lists that `kernel.ts` decodes to `browser_cleanup_failed`.
- Band B — channels, desktop, ui: the telegram poller adopts
  `listenForAbort` (a pre-aborted poll makes zero requests); an invalid
  `ONI_WS_PORT` is a typed `DesktopConfigError` and main refuses to
  boot (unset still means 3000; `ONI_WS_URL` wins); `TranscriptMarkdown`
  is a required-payload paragraph union and the blank-element render branches
  are deleted.
- Band C — agent, app gateway: `replaceFileAtomically` and its test, eight
  single-file exports and `Inspect.forkAsideTransformer` are deleted;
  model-catalog source failures are typed
  `ModelCatalogError{cache | remote | cache_write}` (no `{}` cache
  fallback, remote not fetched on a corrupt cache); `createResidentGateway`
  requires its `requests`/`stores`/`messaging` ports and the error-contract
  fixture lists `ModelCatalogError`.

Measured on the branch: `grep -rl` over `packages/*/src apps/*/src` returns
no file for `replaceFileAtomically`, `forkAsideTransformer`,
`acceptJsonShapedValue`; 92 files, +1267/-696 against main.

## #1310 mailbox admission split, typed admission/origin refusals, required stop evidence (epic #1303, rung 8)

On `stab/8-mailbox-admission-split` (2026-10-07, base `03cd0c274`).
`packages/agent/src/core/mailbox.ts` is deleted and its five jobs now have one
owner each: `core/session/admission.ts` (entity admission over the composed
generation's registered capability kinds), `core/session/recovery.ts` (restoration)
and `core/session/request.ts` (request authority); `rg 'core/mailbox' packages apps`
prints nothing. Two permissive defaults closed with typed refusals: an
admission snapshot that registers no capability kinds is refused
`missing_capability_kinds` (the `BUILTIN_CAPABILITY_KINDS` fallback is
deleted, grep 0 → was 2), and a prompt whose action row records no origin
fails its turn typed via `InboundAuthorityViolation("missing_origin")`
instead of running with `act` authority (`origin === undefined` grep 0 → was
1). Deviation from the issue plan: the refusal reason unions live in
`packages/agent/src/core/ports/failure.ts` (`unknown_origin | undeclared_treatment
| missing_origin`) and `core/session/admission.ts` (`unknown_kind |
missing_capability_kinds`) with a zod enum in `core/session/run.ts` — not in
`packages/protocol`, which has no such enum today. `stopEvidence` is now
REQUIRED on `ChatAgentConfig` (`core/ports/types.ts`) and on the durable runner
input: `turn.ts` reads `config.stopEvidence()` with no empty-evidence
fallback, the prepared loop config is `Omit<ChatAgentConfig, "stopEvidence">`
and the durable runner always injects `input.stopEvidence`
(`rg 'stopEvidence\?' packages apps` prints nothing → was 3; test fixtures
pass an explicit `fixtureStopEvidence`). Tests:
`packages/agent/test/admission-kinds-refusal.test.ts`,
`packages/agent/test/stop-evidence-required.test.ts` (a config without the
port is a `// @ts-expect-error` compile probe; a wired port is consulted),
`inbound-authority`/`session-turn-authority`/`session-chat-runner`/
`request-authority` updated. `bun test packages/agent/test` 1740 pass /
0 fail. No new journal kind, tool or gate point; durable bytes unchanged.

## #1306 full-app boot tests for every capability off (epic #1303, rung 7)

On `stab/7-capability-off-boot-tests` (2026-10-07, base `03cd0c274` = rung 2
head merged with rung 1 head). The five removable capabilities now boot the
WHOLE app off through the product manifest, and the off list is one config
key:

- `apps/oni/src/config.ts`: `bundlesOff` renamed `off` — the same
  `ONI_BUNDLES_OFF` JSON tuple now carries bundle and capability names
  alike; compose ignores names the manifest never declared. Measured:
  `rg -c 'bundlesOff' -g '*.ts' packages apps` 10 hits in 6 files before, no
  output after.
- `apps/oni/src/bundles/resident/index.ts`: a composition with a nonempty `disabled`
  cascade leaves session genesis unstamped (`manifestHash` absent), so the
  first turn's existing single-writer adoption appends the
  `session.configure{operation: "compose", disabled: [{name, because}]}` row;
  an empty cascade keeps the genesis stamp and appends nothing. A composed-off
  `tool` capability returns zero model tool faces (`toolChoice: "none"`), so
  `eval`/`bash`/`read` vanish with the dispatcher's capability.
- `packages/agent/src/core/composition/compose.ts` (#1487): the composed hash
  folds each bundle tool's projected `inputSchema`, so a schema-only tool
  change rotates the generation at each session's next turn start instead of
  stranding the session on a `captured catalog mismatch` at
  `dispatcher.acquire` (seen on oni after #1486 widened `send_message`).
- `packages/channels/src/router/message-execution.ts` (#1490): the prompt's
  external origin records the ingress conversation (`channelId`, `threadId`,
  `messageId`, `dm`); `Gateway.Conversation` on a message target makes
  `messaging/authorize.ts` carry it onto the delivery target (surface pin
  required, else `target_stale`) and the provider delivery route post there:
  Slack threads under `threadId ?? replyToMessageId` instead of opening a
  DM, Telegram sets `reply_to_message_id` / `message_thread_id`, Discord
  and GitHub refuse the hint with `DeliveryNotSent`. A Slack top-level
  mention keys its thread session on its own `ts`.
- `packages/channels/src/router/external-message.ts` (#1490): a thread
  message reaches the model with what the person can see.
  `Gateway.IngressFacts.context` carries the thread's earlier messages and
  the quoted message; `promptContent` prepends the thread once, when the
  thread's session starts, and the quote every time, on direct routes only
  (an automation keeps its trigger body). Slack reads the thread with
  `conversations.replies` (`THREAD_HISTORY_LIMIT` 20, the bot's own
  messages as `assistant`) and delivers without it when the call fails;
  Telegram carries `reply_to_message` text as the quote.
- `packages/channels/src/router/automation/mention-only.ts` (#1494): an
  opt-in mention-only posture per surface. `Actor.ChannelGrant.mentionOnly`
  rides the surface's mount grant (`ONI_CHANNEL_MENTION_ONLY`, a JSON
  array of surface ids, `config.channelMentionOnly`); the perimeter rule
  table (`automation/rules.ts`) filters a channel message that does not
  address the Resident as `mention_only` (`by: rule/mention-only`, one
  `filtered` decision, no route, no delivery). Addressed = DM, a mention,
  a reply quoting the Resident (`context.quoted.author === "assistant"`),
  or a thread whose label the surface map already knows; a channel label
  alone never counts. Absent flag = every admitted message routes, as before.
- `apps/oni/test/capability-off-boot.test.ts` (8 pass / 0 fail): one
  boot per row through `suite.boot` with injected clock and entropy. Measured
  cascades on this base: alarm → alarm, monitor, cron, delegation-policy;
  action → action, hook, hooks-json, delegation-policy; hook → hook,
  hooks-json; compaction → compaction; tool → tool, monitor, send-message,
  delegation-policy (the issue text predates delegation-policy's alarm seam
  and send-message's tool seam). Each row asserts the compose row's
  `disabled` with `toEqual`, the absent surface (points, handlers,
  capabilities, inputs, tool faces) and a typed `unknown_kind` refusal with
  the journal length unchanged; extra rows cover `["monitor", "hook"]` (each
  cascade keeps its own root), an unknown off name (empty cascade, no
  adoption row) and a two-boot byte-golden check on the alarm row.
- App tests reach plugins only through the `Bundle` barrel:
  `createWatchVerb` is re-exported from `plugins/alarm` and
  `alarm-plane.test.ts` drops the deep import —
  `rg -c 'src/plugins/' -g '*.ts' apps/oni/test` returns no output.

No new journal kind, point, tool or verb; the five-plugin layout table and
`plugins-layout.test.ts` are untouched.

## #1318 gate-escape closure and timing-test removal (epic #1303, rung 4)

On `stab/4-gate-escape-closure` (2026-10-07, base `c73bc03b3`). Three gates that
could report green without checking now fail closed, with the planted escapes
kept as regression tests, and no test in `packages`, `apps` or `script` passes
by timing luck.

- Patch coverage: `GATED` in `script/check-patch-coverage.ts` gates nested
  script paths (`script/quality-metrics/`, `script/quality-mutation/`) and
  excludes `script/fixtures/`; a planted uncovered nested-script line exits 1
  (`script/check-patch-coverage.test.ts`).
- Written types: `script/check-written-types.ts` scans `packages/*/test/**`,
  `apps/*/test/**` and `script/*.test.ts`; every test-source written
  `unknown`/`any` was rewritten (gate reports 0 on the real tree); a planted
  test-file `unknown` exits 1 (`script/check-written-types.test.ts`).
- Mutation campaign: an incomplete join exits 1
  (`script/quality-mutation-join.ts`), an incomplete shard with no errors
  exits 1 and errors still win with exit 2
  (`script/run-quality-mutations.ts`), and all three
  `.github/workflows/quality-mutation.yml` artifact uploads use
  `if-no-files-found: error` (regressions in
  `script/quality-mutation-shard.test.ts` and
  `script/quality-mutation-workflow.test.ts`).
- Timing tests: `entity-crash.test.ts` asserts not-before delivery from the
  recorded stale alarm fact's commit clock time (`fired_at >= armed_at +
  1500`, no upper bound; the child subscribes via `observationSink` and never
  reads `Date.now()`); the four `hook-plugin.test.ts` polling loops are
  `startImmediately` forks settled by one `TestClock.adjust` + `Fiber.join`;
  the `new Promise((resolve) => setTimeout(resolve` sleeps in test helpers are
  gone (`waitUntil`/`awaitGone` are interval observations of third-party
  state with timeout-as-failure-guard; `fixedClock.sleep` rides `Bun.sleep`);
  the duplicate `preserves the provided name` bus test is deleted.
- The four script gates (`check-topology`, `check-deps`,
  `check-import-cycles`, `check-dead-exports`) are unchanged in what they
  check; each names its invariant in a header comment.
  `knip-baseline.json` still reads `"grandfathered": []`.

## #1307 and #1353 compaction capability behind four core ports

The composed `CompactionSeam` in `packages/agent/src/core/ports/compaction-ports.ts`
binds one run-scoped `CompactionPort` with exactly four operations:
`maybeCompact`, `window`, `pinAction`, and `prepareRestore`.
`maybeCompact(state, reason)` owns threshold checks, prepare-only continuation,
speculative candidate lifetime and execution in `plugins/compaction/policy.ts`;
`window(state)` reads the model window for yield admission without executing.
`core/loop/turn.ts` calls `maybeCompact` at one site, with `"prepare"` on tool-loop
continuation, `"threshold"` at turn end, and `"yield"`/`"overflow"` at the
respective recovery boundaries. An in-flight speculative cut below grace
defers execution. `plugins/compaction/successor.ts` reads history through
injected `CompactionHistoryPorts`, wired by `packages/agent/src/bundle.ts`.
`appManifest` lists the capability; composing it off skips compaction without
writing a `compaction` row, while an unpinnable compaction append fails closed.
`core/compaction.ts` and the app strategy wrapper are deleted; the plugin owns
the default 4000-character tool-output elision with a 500-character head.
No new journal kind, schema version, tool, or gate point. Tests:
`packages/agent/test/compaction/{compact,capability}.test.ts`,
`packages/agent/test/core/execution/{compaction-deferral,compaction-off,overflow-recovery}.test.ts`,
and `apps/oni/test/compaction-composition.test.ts`.

## #1316 tool plugin owns tool dispatch, monitor requires the tool seam (epic #1303)

On `stab/2-tool-dispatcher-plugin` (2026-10-06, base `c73bc03b3`). The tool
plugin directory holds the dispatcher source instead of a README scaffold:
`packages/agent/src/plugins/tool/dispatch.ts` carries `createDispatcher`
(catalog-wide dispatcher over an explicit or ambient executor; wave, single
and cell doors; result finishing, truncation, output validation) and
`createTurnDispatcher` (per-turn durable executor + dispatcher composition,
captured-catalog pinning, guarded-wave recovery paging), moved verbatim from
`core/loop/tool.ts` and reaching the core only through `core/api.ts`, which grew
re-exports for the gate seams (`activeInvocation`, `createExecutor`,
`immutableInput`, `requireExecutor`, executor/ledger types), the ports
(`GenerationOwnership`, `SessionLayer`, `ToolCatalog`, `ProcessServices`) and
the tool-body seams (`executeToolBody`, `projectTools`, `ToolBodyOutcome`,
`ToolRefused`, the `Dispatcher` types). The agent `Bundle` barrel re-exports
the plugin; `core/index.ts` exports no dispatcher
(`rg -c 'createTurnDispatcher' -g '*.ts' packages/agent/src/core` → nothing)
and `apps/oni/src/bundles/resident/index.ts` composes `Bundle.createTurnDispatcher`
(`rg -c 'Core.createTurnDispatcher' -g '*.ts' apps packages` → nothing).
Capability declaration: the `monitor` bundle (wake-budget row on `tool.pre`)
and the `delegation-policy` bundle (three consulted cap rows on `tool.pre`)
declare `requires: ToolCapabilitySeam`, so `off: ["tool"]` composes with a
typed cascade — `session.configure{disabled: [{name: "monitor"|"send-message"|
"delegation-policy", because: "tool"}]}` and zero surviving `tool.pre`/
`tool.post` rows — instead of rejecting the rows `unknown_point`
(`apps/oni/test/manifest.test.ts`). A row on `tool.pre` from a bundle
that does not require the tool seam still rejects `unknown_point`. New
`packages/agent/test/plugins/tool-plugin.test.ts` pins the plugin door, the
two invalid-output edges and the guarded-page recovery cursor walk. Durable
bytes, the kind schemas, the point set and the 12-tool catalog are untouched.

## #1317 channel-facing persistence moved to the channels store (epic #1303)

On `stab/6-store-channel-split` (2026-10-07, base `c73bc03b3`). The channels
package owns the channel-facing SQLite plane:
`packages/channels/src/store/sqlite/schema.ts` carries the `CREATE TABLE IF
NOT EXISTS` statements moved verbatim from the agent catalog
(`actor_identity`, `actor_endpoint`, `channel_grant`, `reply_grant`,
`egress_debit`, `blacklist`, `surface_key`, plus `person`, `secret` and
`channel_instance` — the provisioning adapter that owns those three joins the
same module per the issue's plan), and `openChannelStore(db, now)`
(`store/sqlite/index.ts`) applies the schema and binds the seven adapters
(`git mv` from `packages/agent/src/core/store/storage/`) plus the handle-bound
write `transaction` to one database handle. The agent catalog
(`packages/agent/src/core/store/catalog.ts`) declares no channel-facing table
and constructs no channel-facing adapter; it exposes its raw `database`
handle, and the app composition
(`apps/oni/src/composition/cluster-runtime.ts`) attaches
`openChannelStore(catalog.database, now)` once per boot as
`AppLedgerPlane.channel`. `apps/oni/src/gateway.ts` builds
`ChannelStoreSource` from `plane.channel.*` plus the ingress session's
`decisionFacts`/`transaction`. Channels tests run on their own fixture
(`packages/channels/test/store/helpers/sqlite.ts`);
`packages/channels/test/store/sqlite/schema-roundtrip.test.ts` is the
round-trip guard proving `sqlite_master` DDL text and one row per table
byte-identical between a catalog opened by the agent opener and
`openChannelStore` on the same file (a pre-#1317 catalog file opens as an
`IF NOT EXISTS` no-op over its existing tables). `StoredIdentity` /
`StoredEndpoint` export from the channels barrel and left the agent barrel;
the check-deps channels→agent named-import pin shrank by
`createSurfaceKeyStore` (now channels-internal). Verification greps all at 0:
`createSqlite*Adapter` under `packages/agent`+`apps` (22 → 0), `plane.catalog.*`
channel fields under `apps` (6 → 0), agent test fixtures in channels tests
(4 → 0), channel-facing `CREATE TABLE` under `packages/agent` (7 → 0).

## #1304 action plugin owns its implementation source (epic #1303)

On `stab/3-action-plugin-source` (2026-10-06, base `c73bc03b3`). The fifth
capability plugin directory holds source instead of a README scaffold:
`packages/agent/src/plugins/action/index.ts` exports `actionCapability()` —
the `action` journal kind (schema and version read from the protocol's
`Journal.CAPABILITY_DECLARATIONS`, identity reducer), the `action` deliver
input and the `action.pre` gate point — plus `ActionSeam`
(`@oni/action/Action`), both public through the agent `Bundle` namespace
(`packages/agent/src/bundle.ts` re-exports the plugin beside `plugins/hook`).
`apps/oni/src/manifest.ts` now composes `Bundle.actionCapability()`
instead of calling `Bundle.Capability.define` locally; the app-owned
`ActionCapabilitySeam` is deleted from `apps/oni/src/bundles/seams.ts`
(`rg -c 'ActionCapabilitySeam' -g '*.ts' packages apps` returns nothing) and
`bundles/delegation-policy` requires `Bundle.ActionSeam`. The cascade is
unchanged because compose resolves `requires` by name: `off: ["action"]`
still disables `action`, `hook`, `hooks-json` and `delegation-policy` with
`because: "action"` (`apps/oni/test/hooks-json.test.ts`), and the new
`packages/agent/test/action-plugin.test.ts` proves the plugin-owned cascade
over a minimal `actionCapability()` + `hookCapability()` manifest. Durable
bytes, the kind schema, the point set and the 12-tool catalog are untouched.

## #1258 one send_message tool for every contact, delegation-policy caps (epic #1260)

On `epic1260/1258-send-message-contacts` (2026-10-05, base `ab62ca98`). The
agent owns one session; every other party is a contact behind the single
`send_message` tool. The tool face moved (git mv) from
`apps/oni/src/bundles/tools/send-message.ts` to
`apps/oni/src/bundles/messaging/send-message/index.ts` (`Bundle.define`, requires
tool; the sealed 12-tool catalog is unchanged — the bundle face shares the
catalog definition name). Contact registry: `telegram:<id>` / `discord:<id>` /
`human:<id>` / `cli:claude-code|codex|omp`; one Effect connector per kind over
injected ports (`ChannelEgressPort`, `HumanNotifyPort`, `CliRunnerPort`,
`ContactReplyPort`; the channel and human connectors were deleted by #1497 —
channel contacts ride the gateway ingest door); a connector never throws — failure is the journaled
`{contact, status: not_sent, reason}` fact, and captured CLI stdout returns as
the sender's prompt. Session/new-session sends keep riding the gateway ingest
door; a `to.new` send with `deadline_ms` arms the `delegation.deadline`
purpose for the created child.

`apps/oni/src/bundles/delegation-policy/` (`Bundle.define`, requires
action + alarm — composing `action` off cascades the bundle off) owns the
delegation policy as generation data: three consulted gate rows at `tool.pre`
(`spawn_depth` limit 3 from catalog parent links, `spawn_children` limit 4
from the parent's ACTIVE children — a child counts while it has an open turn
or an undelivered inbox message, so a finished child frees the slot —
spend-cap refusal when `spend_cap` is unset —
`DEFAULT_DELEGATION_CAPS`, row params, never code constants), the
`delegation.deadline` alarm purpose (its wake cancels the silent child through
the injected entity door — the new `cancel` control riding the `signal`
journal kind — and prompts the parent), and the child-reply prompt wording
(`composition/parent-reply/` deleted; `parent-reply` greps zero in app src).
Core resolves `consult` rows to synchronous `NamedGuard` handlers (one
consulted-row vocabulary shared with #1256: a `consult` row's ref names an
async consultant or a sync guard) with the `when` context
(`op`/`role`/`sessionId`) at the point; guard reads bind in
`composition/generation-layers.ts` to the live catalog plane and register
unconditionally so persisted consult rows compile under any composition (the
process child boots the empty composition). Tests:
`apps/oni/test/send-message-contacts.test.ts` (routing per kind, scripted
CLI stdout -> parent prompt, boot-bind of both bundles, idempotent first-prompt
replay `{seq, existed: true}`, action-off cascade) and
`apps/oni/test/delegation-policy.test.ts` (cap matrix fail-closed,
deadline wake cancel + parent prompt, typed wake failures).

## #1256 hook capability and hooks-json bundle (epic #1260, draft PR #1292)

Branch `epic1260/1256-hook-capability`, base `5362b3bd` (#1255). Shipped: the removable hook capability `packages/agent/src/plugins/hook` — `hookCapability()` is `Capability.define({name: "hook", requires: ["action"], seam: "@oni/hook/Hook"})` with the single handler `hook/process` (`HOOK_PROCESS_REF`), and `process.ts` owns the one external hook surface: `acquireHookProcess` spawns one JSON-lines child process per acquisition Scope (one PID per distinct command per generation — the pool key is the command argv, so two rows with the same command share one child while `timeoutMs`/`maxLineBytes` ride each call; the Scope finalizer drains in-flight calls, stops the reader fiber, then kills the PID), multiplexes concurrent calls by request id, bounds every call with `Effect.timeoutOption` on the injected Clock, and returns the closed `HookOutcome` union `gate{verdict: allow | deny | require_approval} | rewrite{args} | observe | failure{code: "hook_timeout", cause: timeout | framing | exit}`; one malformed stdout line is a framing failure that poisons the process fail-closed — every in-flight call fails, the PID is marked dead and killed, later calls refuse (garbage cannot be attributed to one request or trusted afterwards); spawn refusal is the typed `HookSpawnError`; the plugin imports only `core/api.ts` and `Bun\.spawn|node:child_process` greps 0 under `packages/agent/src/core`. App side: `apps/oni/src/bundles/hooks-json` compiles the Owner's hooks JSON file (config `hooksPath`, env `ONI_HOOKS_PATH`, read once in `index.ts` before any listener exists) into gate rows over the hook handler at the four mapped events — `PreToolUse→tool.pre`, `PostToolUse→tool.post`, `UserPromptSubmit→prompt.pre`, `SessionStart→session.open` — with row ids `hooks-json/<point>#<n>` at order 500+; an unmapped event key, unreadable bytes or an invalid shape refuse boot with the typed app invariant failure (no seventh compose code: the file is validated before compose; a missing hook capability still rejects `seam_missing` inside the closed set); the in-process `hooks-json/secrets-guard` rewrite transformer masks secret-shaped tokens and guard rows declare their rewritable `fields` (`UserPromptSubmit` defaults to `["body"]`, tool events declare explicitly, a `SessionStart` guard refuses at compile); a command entry may declare `do: "rewrite"` with its `fields`, compiling to a consult row with the protocol `rewrite` flag whose PREPARED consultant response the fold applies as a contained rewrite (a reply that is not a plain record within the declared fields folds to deny with one `incompatible_response` fact), and the live policy seed discriminates consultant refs from synchronous transformers so an external rewrite row seeds `consult{rewrite}`; command entries otherwise compile to consulted gate rows served LIVE through the hook consultant at all four points: the fold is fail-closed (a hook response incompatible with its row — e.g. a rewrite answering a gate — folds to deny with one recorded `incompatible_response` fact), a reply that lands after its call's deadline re-enters the session through the entity deliver door as a `hook.late` action row carrying its stale cursor (bounded late window, default 256), prompt-policy refusals fire at BOTH doors (turn start and the mid-turn run boundary draining steer deliveries), refusal errors are typed `AppInvariantError`s carrying machine-consumed codes — `AppInvariantError.code` is an OPTIONAL string field, so the code set is NOT closed at the type level; the hooks-json reader emits exactly `unmapped_event | not_json | unreadable_path | invalid_config | missing_rewrite_fields | session_start_rewrite`, and a gate row naming a synchronous kernel service as its consultant refuses at seed time. The manifest (`apps/oni/src/manifest.ts`) grows the non-exported `action` capability (identity reduce over the protocol `action` declaration) as the hook capability's `requires` root: `off: ["action"]` cascades `hook` and `hooks-json`, `off: ["hook"]` cascades `hooks-json`, and a mid-session recompose journals `session.configure{operation: "compose", disabled: [{name: "hook", because: "hook"}, {name: "hooks-json", because: "hook"}]}` at the next turn start. Tests: `packages/agent/test/hook-plugin.test.ts` (scripted echo child, TestClock timeout, PID rotation proving child receipt via an ordered ack round-trip, death mid-call, split frames via an injected fake child with an exact chunk boundary, framing poison, spawn refusal, late rewrite/observe routing and late-window eviction; no sleeps) and `apps/oni/test/hooks-json.test.ts` (row compilation incl. consult/observe seeds, typed refusal codes, secrets guard, off cascades, `seam_missing`, catalog policy seeding through real boot, the capability-removed one-turn gate with the journal chain byte-identical across two pinned runs, and the real-boot e2e set: prompt gate deny/allow decision rows, mid-turn steer deny at the run boundary, body and `bash.command` rewrites reaching model/executor, incompatible-response deny fold, the late `hook.late` row, and the one-PID-per-command pool with teardown kills). Measured at the r4 head: root and app check-types 0; root lint green; check-deps band ratchet 25 unchanged; check-dead-exports 0 new; check-written-types 0; check-journal-writers 12; check-effect-boundaries green; suites stable 5x each — hook-plugin 19/0, hooks-json 21/0, policy-seed-rows 3/0, stale-action-backlog 6/0, retryable-once 2/0; a manual real-run tool.pre denial (journaled deny decision + refused tool slot) is recorded in the lane evidence.

## #1257 fork sessions into independent histories (epic #1260, draft PR #1291)

On `epic1260/1257-fork-chains` (2026-10-05, base `3ccafed1`). `Core.forkSession`
(`packages/agent/src/core/session/fork.ts`) forks a parent session at an action-id
boundary — exactly a `turn{terminal}` row, a `prompt` row, or a `compaction`
row (`signal` rows are NOT boundaries); any other anchor refuses
`anchor_not_boundary`, an unknown action id `anchor_not_found` — into a NEW session
file with independent history. The
child genesis is `session.configure{operation: "fork", forkedFrom: {session,
anchor, parentSeq, parentHead, copied}}` (schema in
`packages/protocol/src/journal/core/session-configure.ts`), pinning the parent
latest action id at fork time; a later parent append never changes the copied
child rows. Forks copy rows without a separate history verification pass.
Copied rows keep their original ids except input rows and their
`<inboxId>:delivery` rows, which rename to `fork:<parentSessionId>:<id>` with
`inboxId`/`turnId` payload references remapped: consumed inputs stay consumed,
and replaying a pre-fork idempotency key against the child admits fresh. Exclusions: `alarm{arm}` rows and
`fold.checkpoint` are never copied — the child re-registers zero alarms while
the parent occurrence still runs, and a copied orphan `alarm{fired}` folds to
#1254's `skip{unknown}` (occurrence ids are minted from the parent session id,
so a child re-arm can never collide). The parent file's schema stamp
(`SESSION_FILE_SCHEMA_VERSION` via `PRAGMA user_version`,
`packages/agent/src/core/store/session-file/`) is probed read-only first; a
mismatch refuses `schema_version` with zero child writes. The copy cap is generation
configuration per the issue's "cap copied bytes in generation configuration":
`session.configure{settings.forkCopyByteCap}` is folded off the parent
generation like the consumption widths (`DEFAULT_FORK_COPY_BYTE_CAP` 4 MiB when
unset), and the app's resolved startup value (env `ONI_FORK_COPY_BYTE_CAP`)
is the input written into each new session's genesis settings.
`SessionStore.fork` appends genesis plus copies in one transaction; an existing
child id refuses `child_exists` leaving the first chain intact.

Ancestry and the aside are inspect projections only.
`packages/agent/src/inspect/tree.ts` exposes `forkAncestryOf` (reads the child
genesis pin), `forkAside` (the "Forked from session …" text), and `inspectTree`
(depth-3/limit-64 bounded tree over catalog `parentId` edges with continuation
cursors). `session_read` pages carry optional `ancestry {parentId, forkedFrom,
aside}` plus the optional fork `children` list (id + anchor + title where
known) the desktop renders as a clickable Forks list opening each child as a
bound local session, the `session_fork` gateway method + websocket frame land in
`packages/protocol/src/gateway/session-read.ts` / `packages/channels` /
`apps/oni/src/composition/session-fork.ts`, and the desktop session header
renders the aside. `foldSessionHistory` never reads `session.configure`
intents, so the aside cannot reach model context or compaction; the only
promotion path is `forkAsideTransformer`, an opt-in `prompt.pre` gate handler
registered nowhere by default.

`receivedMessages` and its fold state (`foldReceivedAction`, `ReceivedEntry`,
`DeliverIntent`) are deleted — `rg -c 'receivedMessages' packages/agent/src`
returns nothing. The kernel reads inputs by SQL (`inputMessages` on
`Storage.ActionSubAdapter` and `SessionKernel`), and `run.ts` resolves a
prompt's origin by `actionById` point read. No new journal kind exists:
`rg -c 'kind: "session\.fork"' packages apps` returns nothing. Tests:
`packages/agent/test/store/session/{session-fork,fork-exclusions,inspect-tree,inspect-aside}.test.ts`
and the wire roundtrip `apps/oni/test/session-fork.test.ts`.

## #1255 declarative capabilities and bundles (epic #1260, PR #1289, merged `5362b3bd`)

Branch `epic1260/1255-declarative-bundles`, base `77e1375b` (#1254). Shipped: the three declaration contracts `Capability.define` / `Bundle.define` (the `Bundle` namespace barrel's `define` = `defineBundle`) / `Manifest.define` in `packages/agent/src/core/ports/capability.ts`, surfaced through `core/api.ts` and the root `Bundle` namespace (`packages/agent/src/bundle.ts` is now a 19-line re-export barrel); `compose(manifest) → Generation` in `packages/agent/src/core/composition/compose.ts` is the one loader path and rejects exactly the closed six codes `requires_cycle | duplicate | product_declares_kind | seam_missing | unknown_handler | unknown_point` (the former `BundleError.namespace` refusal moved to define time); the `off` cascade (`requires` fan-out) is recorded on the existing writer as `session.configure{disabled: [{name, because}]}` with `ConfigureIntent.operation: "compose"` and no new journal kind; generations are recomputed from empty state on every manifest change and adopted by each session at its next turn start (`manifestHash` stamped on the configure row); the handler table of a composed generation is built once at compose and provided as the `GenerationHandlers` Context tag (`HandlerTable`/`createHandlerTable` in `core/gate/`; the `NamedPolicyRegistry` name greps zero); the three tool projections (`Tool.Spec`, `SessionGeneration.Tool`, the dispatch table) are derived once from the composed generation and `sessionTool()`/`toolSpec()` are deleted from `packages/agent/src`. App side: `apps/oni/src/manifest.ts` declares the product manifest, `composition/composed.ts` holds the `ComposedGeneration` service the generation Layers read, boot composes the manifest and fails closed on a typed `ComposeRefused`, product bundles live under `apps/oni/src/bundles/{monitor,cron}` (replacing `tools/monitor.ts` and the composition bundles, both grep zero), `provision{bundle_enable | bundle_disable}` recomposes the manifest with the four consent rows pinned, and `apps/oni/test/monitor-bundle.test.ts` proves the monitor bundle end to end through `index.ts` wiring (restart fire, mid-turn disable, off at boot). D5: the tool-result split `content / details / structuredContent` lands as protocol owner fields in `packages/protocol/src/tool/result.ts` (`toolResultJsonSchema` bounded at 262,144 bytes, `toolResultText` the one fallback reader) and is consumed by eval and code mode (`composition/codemode.ts` maps `structuredContent` onto `ToolCallResult.value`; the cell door is typed-only). `script/check-deps.test.ts` ratchets the deletion tokens (`#1255 T5` records `@oni/llm` at 0, already met by #1246). Recorded deviations: adoption bypasses `authorizeConfigure` (the manifest change is the authorized act; the per-session append is mechanical); `Generation` carries `inputs/capabilities/bundles/disabled` beyond the body's seven fields (needed by rotation and admission); protocol `Disabled` is `.readonly()`; `compose.ts` helpers split under the lint complexity cap; desktop/ui rendering of `details` and the gate `ToolBodyOutcome.output` name are follow-ups, not D5 consumers. Sweeps on the merged head: `rg --files apps/oni/src | rg 'tools/monitor\.ts|composition/monitor-ports\.ts'` → empty; `sessionTool\(|toolSpec\(` in `packages/*/src` and `apps/*/src` → 0 (two app tests keep a local `toolSpec` helper); `BundlesLive|BundleDefinitions|bundlePolicyTag|NamedPolicyRegistry` → 0; `Bun\.cron\(` → 0; `Effect.succeed(true)` fail-open in `packages/agent/src` → 0; `approvalBindings` → 0. Lane-measured suites before the final gate: protocol 526/0, agent 1685/0, apps 658/0; the final gate chain is recorded in the PR.

## #1254 alarm split: core timer, removable alarm capability (epic #1260, PR #1285, merged `77e1375b`)

On `epic1260/1254-alarm-split` (2026-10-04, base `4ecb41f3`, merged with main
`c8ae79d4` at `277b3ce5`). The timer plane
is split in two. The core (`packages/agent/src/core/ports/alarm.ts`, the `alarm`
kind's single declared writer) keeps the cluster `DeliverAt` message, exactly
four loop-reserved purposes (`step_watchdog`, `retry`, `deadline`, `resume`;
`RESERVED_PURPOSES` in `packages/protocol/src/journal/core/ports/alarm.ts`), one
occurrence-id minter `Alarm.occurrenceId(sessionId, alarmId, armSeq, sourceKey)`
= `canonicalDigest(["alarm.occurrence", …])` minted from the arm row's own
journal sequence inside the committing transaction, and one chain guard
`alarmDisposition` (fresh iff the latest `arm` row still names the occurrence,
is not retired by `at: null`, and no `delivered|exhausted` firing settled it);
the per-purpose dispositions and `hasNewerAttempt` are deleted. The `alarm`
declaration is tightened to `arm{purpose, at, supersedes, alarmId, sourceKey,
payload} → effect{occurrenceId}` and `fired{occurrenceId, outcome:
delivered|stale|exhausted}`; an unregistered purpose folds to a recorded
`fired{stale}` fact with zero execution (`rpc-surface.test.ts`,
`alarm-chain-guard.test.ts`). The armed set is an index, not a second
truth: `armed_alarms(alarm_id PK, occurrence_id UNIQUE, fire_at)` lives in
the session-file schema and its delta is derived from the appended `alarm` row
inside the same `appendAction` transaction (an arm upserts, `at: null` and a
settling `fired` delete; a schema-refused row rolls the index back with the
row), read through the kernel ports `armedAlarms()`/`armedCount()`; the
catalog gains `session_index.has_armed` at `CATALOG_SCHEMA_VERSION` 2 (a v1
file upgrades in place in one immediate transaction; a newer file stays
read-only with `markArmed` in the refused set); activation re-sends every
armed row as its ORIGINAL occurrence id (the cluster dedupe key) and boot runs
`rescanOccurrences` over `has_armed ∪ idle ≥ idleDays` (`full` ⇒ all) as
`${sessionId}:rescan:${bootId}` (`alarm-recovery.test.ts`). The entity admits
through one queue writer (`Entity.toLayerQueue` + `Replier`): the revision CAS
is bounded at 3 attempts then fails typed `AdmissionFailure{code: revision}`,
queue close fails every queued envelope `AdmissionFailure{code: shutdown}`,
`Entity.keepAlive` holds the entity while a turn is open and `maxIdleTime` is
D3's `idleMs`, passivation with unconsumed input arms a `resume` alarm, the
fence is compared inside the session commit, and the four reserved purposes
are consumed by the loop (`retry`/`resume` wake the drain, `deadline` expires
its request iff still open, `step_watchdog` is reserved with no step budget —
nothing arms it; `admission-writer-fiber.test.ts`, `rpc-surface.test.ts`). The
removable capability `packages/agent/src/plugins/alarm/` imports only
`core/api.ts` (`AlarmCapability{purposes, wake → delivered|exhausted}`,
`AlarmWakeContext`, `ArmVerb`,
`ArmRefused{alarm_budget|unknown_purpose|reserved_purpose|not_live|stale_turn|stale_activation|revision}`,
`AlarmFired`,
`AlarmWakeOutcome`, `RESERVED_PURPOSES`) and owns the purpose registry
(`Core.composeAlarmPurposes` refuses the reserved four, the entity-internal
`rescan`, and duplicates with a typed `AlarmComposeError`), wake dispatch, the
`alarm.fired` point, the `watch(command|path)` handlers with budget and
exhaustion (a watch is an armed alarm `alarmId = watchId`, `sourceKey:
"monitor"`; re-arm = `supersedes`, cancel = `at: null`; timeout = a second
arm), and the `arm`/`watch` verbs. The app composes the capability in
`apps/oni/src/bundles/alarms/index.ts` (chain fold, chain-guard reads,
typed prompt port; the app never commits an arm row itself — tool-facing arms
delegate through the live-activation registry to the entity's one committing
verb, bound at creation to the authorizing activation (a turn token alone
cannot distinguish recovery) and carrying the calling turn's token, with typed
refusals: `not_live`, `stale_turn`, `stale_activation` when the authorizing
activation is no longer live (including a fence-stale zombie commit), and
`revision` when the entity's bounded commit retry exhausts) behind two
bundles `composition/bundles/{monitor,cron}.ts` (each documents its
`requires: alarm` edge; the manifest/compose mechanics that enforce the
capability-off cascade land with #1255); `composition/monitor-ports.ts` and
`tools/core/monitor-ports.ts` are deleted, `composition/watch-sources.ts` is
the native source adapter and `tools/core/watch.ts` is epoch-free; the
hibernation e2e pins a native hit landing as a recorded chain fact. The
merge with main `c8ae79d4` (`277b3ce5`; #1271 brain host as machine `self`,
#1273 tmux `pty.session`) joins the terminal watch source to the
`ArmedWatch`/occurrence shape, makes the native install part of the `watch`
verb (the plugin's `WatchInstallDeps.install` is awaited after the arms commit
and before the verb returns, so a terminal subscribe is never interrupted by
the tool's `waiting` commit; a refused install retires the armed chain and
its timeout with reason `install` and surfaces `WatchRefused`), returns
`armSeq` from `ArmVerb`, binds the composed capability into the entity ports
(`alarmCapability`; before the bind every `monitor.hit`/`cron.tick` wake
folded to a recorded `fired{stale}` fact), and exempts `monitor.hit`
occurrences from the entity's `sendAlarm` time delivery (the installed native
source resends them with the hit; `monitor-app.test.ts` pins the second turn,
the alarm prompt, the `<occurrenceId>:delivered` row and the re-armed chain).
The armed budget bounds the index, so only an arm that adds a chain (non-null
`at`, no armed row for its id) consults `maxArmed`; a retire or a re-arm of an
armed chain commits at a full budget and a retire frees its slot
(`alarm-budget.test.ts`). One forwarder per activation sends armed
occurrences (a queued re-arm replaces its predecessor unsent); a timed re-arm
of an occurrence already sent orphans that durable envelope, and orphans are
capped at `maxArmed` per activation (`alarm_budget`) until each folds
`stale`. Arms run under the activation gate the store-close finalizer takes:
the finalizer refuses new arms (`stale_activation`), waits up to
`armCloseWaitMs` (default 5000) for an in-flight one, then closes, so an arm
across passivation never dies (`arm-passivation.test.ts`). Two activation-order defects surfaced by the
restart e2e (`request-owner-e2e.test.ts`, red 3/3 before, green 3/3 after)
once activations resend their armed occurrences and hold `keepAlive`: the
cluster host redelivers a crashed process's persisted messages as soon as it
starts, so a session activated before the composition root bound the entity
ports and the late-bound slot died typed — the ports now carry an optional
`ready` gate an activation awaits before its first port call
(`createSessionEntityPortsSlot` settles it at `bind`; the entity activation
yields it first; `rpc-surface.test.ts` parks an activation at the gate and
observes no port entry until release, `cluster-runtime.test.ts` pins the
slot's settle-at-bind). And the entity `Resolve` path committed the answer
but woke nobody: the turn that activation had recovered was parked on the
still-open request, the drain deferred to that live turn, and the app's
direct answer route (`notifyLiveApprovals`) never saw a turn that was not
live when the answer was dispatched — `requestCommand` now rings the optional
`onRequestReady(sessionId)` port after each committed transition (resolve,
cancel, deadline expiry) and the app binds it to `notifyLiveApprovals`, the
same doorbell the direct path rings; a refused transition stays silent
(`rpc-surface.test.ts`, `resolve-stale.test.ts`).
`Protocol.Cron.next(expr, fromMs, tz)` / `Cron.occurrences(expr, afterMs,
untilMs, tz, limit)` is a dependency-free Vixie grid over `Intl.DateTimeFormat`
zone math (DST gap skipped, overlap fires once, 366-day `unreachable` bound,
typed `CronParseError{code}`; `packages/protocol/test/cron-next.test.ts`), and
`monitor({kind: "cron", expr, tz})` is the entry (derived tool snapshot
regenerated: one added source variant, one description line). Assumed (Owner
ruling D3): loop consumption defaults — alarms before prompt 4, armed-alarm cap
64, passivation idle 60 s, `sweep{full: false, idleDays: 7}` — typed once as
`Core.AlarmDrainConfig`, values from `apps/oni/src/config.ts`. Lead fixes
after the lane merge: `Protocol.canonicalJson` is the one canonical byte owner
for persisted text payloads (alarm payloads, message origins), so the stored
bytes and the digest minted from them agree; the live-wait fold `openAlarmIds`
(`core/session/run.ts`) folds by `alarmId` (latest arm wins, `at: null` retires, a
`fired` for the armed occurrence settles) and excludes the reserved purposes,
so a settled chain or a request deadline is not live-wait evidence;
`SessionHistory.Cause` drops its `{kind: "alarm", alarmId, epoch}` variant
(no producer after the per-purpose scheme left; a read-model DTO, never
persisted, so no ledger-fold upcast exists) and
`script/conformance/schema-snapshot.json` is regenerated — one removal
(`SessionHistory.Cause#alarm`) plus the additive drift main accumulated since
#1247, this PR being the `--update` review moment. Deviations: the timer
module keeps its file name `core/ports/alarm.ts` (it is the kind's declared writer;
the issue's `core/timer.ts` would rename the writer for no behavior); cron
enters through the sealed 12-tool catalog as `monitor({kind: "cron", expr,
tz})` instead of a new tool; only the `monitor` and `cron` bundles exist (the
issue's `reminder`/`compaction-timing` bundles have no consumer and would be
dead code; the seed `bundles/alarm.ts` was deleted as an unconsumed export);
the `armed_alarms` delta is derived inside the append transaction from the
appended row rather than supplied by the caller; the `alarm` declaration stays
`version: 1` (no deployed journals exist, a v2 with no v1 reader is dead
code); `step_watchdog` is reserved-and-refused only (no step budget exists in
the loop). Pre-existing flakes met and recorded: in a combined
`bun test packages/agent packages/protocol` process Bun 1.4.1 intermittently
materializes `new Error().stack` as `undefined` with `Error.stackTraceLimit`
intact, so `Failure.pretty` now renders `name: message` whenever `stack` is
not a string (`failure-of.test.ts` reproduces it with `Error.stackTraceLimit =
0`); the `watch-sources` native path-create signal timed out once (15 s)
inside a full app run and passes alone — test and `pathSource` logic are
identical on main (an `fs.watch` create race, not changed here); the
`durable-reconstruction` fresh-process tests fail with `Cannot find module
'@oni/protocol'` when root `check-types` emits `protocol/dist`
concurrently — gates run serially. Sweeps at HEAD: `hasNewerAttempt` 0,
alarm-scoped `epoch` 0, `Bun\.cron\(|alarm\.cancel` 0,
`monitor-ports|watchOccurrenceKey|watchTimeoutKey|:occ:` 0; one writer for
`alarm` (`script/check-journal-writers.ts`). Deferrals: capability manifest /
`requires` cascade mechanics with recorded reason and the `action` writer land
with #1255.

## #1053 machine plane epic landed (six children, 2026-10-03/04)

The machine plane moved from a localhost Unix-socket endpoint frozen at 2026-08-24 to a network-attachable WHERE with persistent terminals, computer use and browser use, all reached through the existing twelve-tool catalog and code-mode handles; no new model tool was added. Children, in merge order: #1272 code mode extracted into `packages/codemode` (`3e36a657`, PR #1280); #1274 `screen.read`/`input.write` via macOS shell-out (`a004bdb0`, PR #1282); #1270 TCP transport with host-certificate chain validation + SPKI pin and automatic reattach (`76598609`, PR #1281); #1271 brain host attaches as machine `self`, local execution path removed from the tools (`a66dc3a7`, PR #1284); #1273 persistent `pty.session` terminals over tmux with `bash{session}` (`a1a3de0f`, PR #1283); #1275 `browser()` over CDP inside a `pty.session` (`05bb44dd`, PR #1286). Each child merged after CI all-green and an independent line-level review with zero High/Medium findings; real-surface evidence (attach transcripts, restart/reattach logs, typed refusals, screenshot bytes) is attached to each child's closing comment. Not claimed: native computer use (#887), media streaming, sandbox/egress hardening (#950), cli contact (#1180), embedded desktop browser (#1023). Open design decision recorded on the epic: host-side chain validation of daemon certificates (today the listener judges the daemon key against enrollment at handshake).

## #1275 browser automation recipe: browser() over CDP in a pty.session

On `machines/1275-browser-recipe` (2026-10-03, draft PR #1286). The codemode
Python prelude gains `browser(machine_id, *, headless=True, profile_dir=None,
executable_path=None)` returning a thin `BrowserClient` around Playwright's
`connect_over_cdp`; Chromium runs persistently in a cell-owned tmux
`pty.session` (name `oni-browser-<sha256(profile)[:12]>`), with the CDP
port probe-bound from 9222 and port + pid retained in the session output.
Profile dirs are export-confined via the existing `openCwd` rule
(`path_escapes_export` before launch); loss at any client accessor raises the
typed `browser_lost` refusal with the captured tmux output; a missing
executable refuses typed naming the path and install command and tears the
launch session down. No new capability id, wire method, or model tool.
The Rust client interpreter closes with a bounded cleanup grace so the
driver's cleanup stops each client's browser process. Recipe documented in
`docs/machines-and-delegation.md` section 2.7; end-to-end tests in
`packages/codemode/test/codemode/browser.test.ts` run real tmux + Chromium.
Close-race fix (fix/1275-browser-close-race): `pty_close` removes the daemon
record when the session's shell already exited on its own (the launch line
exits once Chromium stops), and is fail-closed otherwise: a `kill-session` or
`kill-window` failure is re-checked against the server and propagates (record
kept) unless the session/window is confirmed absent. Interpreter `close()`
sends stdin EOF and waits on the driver's explicit `browser-cleanup-complete`
ack (bounded 2s) before cancelling any active cell, so an in-flight cell can
no longer bypass the witness through the cancellation discard path; an
unacknowledged teardown (idle or wedged-cell) fails typed instead of
resolving as success. Nothing writes to the driver after that EOF: a tool
answer or request racing close() becomes a typed refusal instead of a stream
write, and asynchronous stdin errors land in the typed driver-failure path,
so a normally resolving tool callback can no longer crash the process with
`ERR_STREAM_WRITE_AFTER_END`. Caveat: `BrowserClient.close()`
itself still swallows pty `ToolError`, so its successful return alone does not
prove the session record is gone on failure paths - the listing guarantee
belongs to `pty_close`'s `ok`. The interpreter-close test awaits the shell's
`chromium-exited` reap line instead of assuming the pid is unprobeable the
instant `close()` resolves.

## #1273 persistent terminals: pty.session over tmux

- #1510 (epic #1508) structural screen snapshot: `machine.pty_read` uses the `source`-discriminated `Machine.PtyReadParams` union; `{name, source: "screen"}` answers `Machine.PtyScreenResult` with `rows`, `cursor {x, y}`, `occupant {pid, command} | null` and `observedAt`. The Rust client runs `capture-pane -p -e` and `display-message -p` for the rows and pane facts; `pid` names the pane's initial process while `command` names its current foreground command, so the two need not name the same process. `observedAt` comes from the client's system clock. The host budgets two control-command deadlines plus a call margin for screen reads and resize. The byte-stream read remains separate from the structural snapshot. Receipts: `clients/machine-client/src/pty/ops.rs`, `packages/machines/src/pty-host.ts`.

On `machines/1273-pty-session` (2026-10-03, base `a004bdb0`, draft PR #1283).
The machine protocol gains the `pty.session` capability and six wire methods
`machine.pty_open/pty_write/pty_read/pty_resize/pty_close/pty_list` with
strict bounds (`PTY_READ_MAX_BYTES` 256 KiB, `PTY_WRITE_MAX_BYTES` 16 KiB,
`PTY_LIST_MAX_SESSIONS` 1000, cols/rows <= 1000, read `waitMs` <= 30 s long
poll) and typed refusals `pty_not_found`/`pty_not_available`/
`path_escapes_export`; `machine.pty_output` is a reserved wake-up
notification, never output authority. The daemon adapter
(`clients/machine-client/src/pty/`)
runs one `tmux -C` control client, decodes octal-escaped `%output` into
per-session cursor streams (opaque `p1:<generation>:<offset>` tokens, replay
= `capture-pane -S -` snapshot then live bytes, no duplicates, over-cap reads
return the bounded suffix with `truncated: true` and advance past all
observed output, 1 MiB live retention), confines `pty_open` cwd under the
exec `openCwd` rule before any session exists, reattaches same-name opens,
links session windows into the reserved `omo-pty-control` session, and
rediscovers sessions by name after a daemon restart (the tmux server owns
session lifetime). Server death marks sessions `lost`, settles pending reads
`pty_not_available`, and withdraws the capability until the next attach
probe. Host handles gain `pty` (`src/pty-host.ts`, one routed-call seam);
code mode exposes `m.pty(name).open/write/read/resize/close` and
`m.ptyList()`; the sealed `bash` tool gains optional `session` (per-session
cursor state inside the tool, empty command = read-only drain) and `monitor`
watches a named terminal without closing it. Tests: protocol machine suite,
real-tmux adapter suite on a private socket (`packages/machines/test/pty.test.ts`),
attach offer gating + enrollment withhold + export refusals, and app-door
e2e including a daemon restart over a live tmux server.

## #1253 four session entity RPCs (epic #1260, merged as `4ecb41f3`, PR #1279)

On `epic1260/1253-four-entity-rpcs` (2026-10-03, base `58b7f18d`). The session
entity's outside surface is exactly four RPCs in
`packages/agent/src/core/journal/messages.ts` — `deliver`, `resolve`, `alarm`, `read`
— handled in `core/session/entity.ts`. `deliver{kind, body, source, idempotencyKey}`
is the one input door: the kind is checked against the activation's input
registration table (core registers `prompt` and `signal`; `action` arrives
with its capability, #1255), a blank key is a typed `missing_key`, a replayed
key resolves to the original seq as success (`{seq, existed: true}`) with zero
new facts (`deliver-idempotency.test.ts`), and a refused admission is a typed
`denied` rejection that appends nothing — never a success ack
(`entity-admission-refusal.test.ts`). `resolve{requestId, outcome, payload,
inputId}` settles one request: a missing request is `unknown_request`, a
settled one `already_resolved`, both with zero new facts, and a redelivered
`inputId` replays the recorded resolution through the pure request authority's
dedup (`resolve-stale.test.ts`). `alarm` carries one `AlarmOccurrence`
(cluster PrimaryKey = `occurrenceId`, DeliverAt = `fireAt`): an applied
occurrence drives the chain-guarded fold and wakes the loop; a superseded one
is recorded as an `alarm{fired, outcome: stale}` fact — a fact, not a
rejection (`rpc-surface.test.ts`). `read{model, cursor}` is the fourth RPC and
deliberately not cluster-persisted: nine models (`history`, `decisions`,
`requests`, `alarms`, `generations`, `tree`, `metrics`, `control`, `outbound`,
`packages/agent/src/core/session/read.ts`) are pure paged projections over the
journal fold covering all 12 public kinds with `fold.checkpoint` excluded by
construction (`inspect-renderers.test.ts`); the app `session_read` surface
stays thin and `attemptUsage` is byte-equal to the fold DTO
(`gateway-frame.test.ts`). Consumers switched: the gateway inbox commits
through `deliver` (interrupt/resume as `signal` + control op,
`apps/oni/src/composition/message-session.ts`), out-of-turn answers
through `resolve`, and watch fires, watch timeouts and request deadlines
through `alarm` occurrences (`apps/oni/src/index.ts`). The nine legacy
RPCs (`Prompt`/`Interrupt`/`Resume`/`RequestResolve`/`RequestCancel`/
`RetryScheduled`/`Deadline`/`WatchFired`/`WatchTimeout`), the `receive` and
`timerWake` handler bodies and the `driveInbox` name are deleted; the four
issue sweeps (`RetryScheduledRpc|DeadlineRpc|WatchFiredRpc|WatchTimeoutRpc`,
`timerWake`, `cluster/timers`, `driveInbox`) grep to zero. The cluster host
takes `SqlClient` and `Crypto.Crypto` as injected layers
(`apps/oni/src/composition/cluster-runtime.ts`); a deterministic Crypto
layer hosts the full deliver round-trip (`deterministic-crypto.test.ts`).
Boundary consumption (C2): inputs are consumed at loop boundaries only —
`steer` at `after_tools` and turn end, `followUp` at turn end — with widths
from the latest `session.configure` settings and consumed seqs recorded on the
turn checkpoint (`boundary-consumption.test.ts`). Deviations: the queue
table/drain were already fold-based since #1252; the keyless-frame
`missing_key` refusal shipped with #1245; the kernel timer imports were
relocated by #1276 (only two comment tokens remained to sweep); dedup is
two-layer (cluster envelope replay is byte-identical for the same envelope,
the handler returns `{seq, existed: true}` for keys already on the journal).
Deferrals: the `action` writer and `turn.consumed.stale` land with #1255;
alarm purpose registration/occurrence ownership with #1254.

## #1274 macOS computer use: screen.read / input.write

On `machines/1274-screen-input` (2026-10-03, base `3e36a657`, draft PR #1282).
The machine protocol gains `screen.read`/`input.write` capabilities with wire
methods `machine.screen_read`/`machine.input_write` and bounded schemas
(`SCREEN_PNG_MAX_BYTES` 4 MiB, `SCREEN_AX_MAX_BYTES` 256 KiB,
`INPUT_MAX_ACTIONS` 32, `INPUT_MAX_TEXT_CHARS` 10k; the accessibility tree is
bounded JSON, not `unknown`). The Rust client owns the screen and input
handlers, attach-time availability probes, bounds checks and capture-id
validation; `clients/machine-client/tests/handlers.rs` covers their wire
gates. Host handles route `screen`/`input` through IPC and code mode exposes
machine screen and input handles. The older TypeScript computer adapter and
its fake-runner tests were deleted in P6.

## #1272 code mode extracted into packages/codemode (reverses part of #1246)

On `machines/1272-codemode-package` (2026-10-03, base `58b7f18d`). The
repository has six packages: `packages/codemode` (`@oni/codemode`, deps
`@oni/protocol` + `@oni/machines`) now owns the reusable
cell-routing facade shared by the application host and machine clients —
`createCodemode`, machine object handles, and `cell.run/peek/stop`. The Rust
client owns the lazy per-tenant Python processes and prelude helpers
(`parallel`, `completion`, `tool.<name>()` proxies). The facade retains
`listMachines`/`getMachine`/`findMachine`, `CodemodeError` and
`decodeCodeFailure`. The original extraction preserved the public shape of
`createCodemode` is unchanged and no configuration keys, capability ids, wire
methods, or refusal reasons. `packages/machines` now keeps host transport,
handles and the structural contracts code mode consumes
(`MachineHost`/`MachineHandle`/`MachineInfo` and `MachinesFailure`).
App composition
(`src/composition/codemode.ts`), eval tool and all code-mode tests import
`@oni/codemode` directly; application policy, completion budget, ledger
and model rendering stay in the app. `script/topology.ts` carries the
`codemode` row (own CI test + coverage lane, knip workspace, tsconfig
verification); the app allowlist gained `@oni/codemode`.

## #1252 twelve journal kinds (epic #1260, merged as `58b7f18d`, PR #1278)

On `epic1260/1252-journal-kinds-12` (2026-10-04, base `6a9063d7`). The journal
kind set is closed at 12 — nine core (`prompt`, `signal`, `turn`, `llm`,
`message`, `session.configure`, `policy.decision`, `request`, `alarm`) plus
three capability (`tool`, `compaction`, `action`) — each declared
`{kind, version, schema}` with one writer in
`packages/protocol/src/journal/{core,capability}/` and fixed by
`packages/protocol/test/kind-census.test.ts`. Retired kinds and their readers:
`reply` → `request{phase: answered}` (lifecycle phases
`open|answered|resolved|expired` via `lifecyclePhase`, answered-request SQL and
inspect read phases; channels' reply decision is `answer` over the same rows —
the reply-grant store keeps only claim/listLive, no answer lookup);
`attempt` → `llm` rows pinning their ordinal in the intent (`attempt: n`),
with metrics/model-pin SQL/crash tests discriminating on the ordinal or durable
`usageProvenance`; `inbox.deliver` → `prompt`/`signal` delivery rows
(`effect.phase: "delivery"`; control admissions interrupt/resume are `signal`);
`outbound` → `message{op: open|ack}`; `alarm.arm`/`alarm.fired`/`alarm.paused`
→ one `alarm` kind (`op: arm|fired`, fired outcome
`delivered|stale|exhausted` with `via` provenance for cancel/paused/timeout).
Writes are fail-closed: `appendAction` validates every row body against its
kind's declaration schema (`Journal.declarationFor`) and refuses the whole
commit with the typed `SchemaRefused` — nothing partial lands
(`journal-fail-closed.test.ts` pins row count and hash head) — and entity
admission runs `Journal.admitInputKind`, rejecting capability-off input kinds
as `unknown_kind` (`packages/agent/src/core/mailbox.ts`). One writer module
per kind is enforced by `script/check-journal-writers.ts` (registered in CI
next to `check-written-types`; a planted second append site for a kind fails
the script). Reads degrade on every read port: a row that fails decode emits
exactly one `journal.corrupt{seq, kind, reason}` observation; the fold
(`range`) keeps it as opaque while the projection ports
(`decodeOne`/`decodeRows`: requestById, turnTailPage, outboundsPage, lastChat,
pendingMessages, messagesFor and the rest) skip it and still answer — one bad
row never blocks session load or an inspect read
(`journal-corrupt-degrade.test.ts`). The catalog stamps a schemaVersion into
`PRAGMA user_version` at create; a catalog whose marker is greater than the
build's version opens read-only — reads work, Deliver (fence rotation) and
fork (session indexing) are refused with the typed `CatalogVersionRefused`,
and the file bytes stay identical (`old-session-readonly.test.ts`). `prompt`
and `action` declare `delivery: steer|followUp` (default `followUp`,
`input-admission.test.ts`); the gate emit set is
`message | alarm{arm} | compaction`. The six retired-kind searches in the
issue grep to zero across packages and apps. Deviations: only
`delivery: "followUp"` is produced in this PR — the `action` kind's writer,
`steer` production, `action.after` consumption and the `turn.consumed.stale`
closure (acceptance test `stale-action.test.ts`) are declared and
census-tested here and land with #1255, which builds the action capability
plugin (#1253 owns the `deliver` RPC that refuses unregistered `action` rows
`unknown_kind`); the catalog policy-table CHECK keeps
`inbox.deliver`/`alarm.fired` tokens because the #1251 legacy point mapping
still converts those historical rows; policy point ids (e.g. the
`alarm.fired` hook point) are point names, not journal kinds, and stay
unchanged.

## #1276 one core, five plugins (epic #1260, merged as `6a9063d7`, PR #1277)

On `epic1260/1276-core-plugins-move` (2026-10-03, base `66d56edb`).
`packages/agent/src/{kernel,session,store}/` merged into one `src/core/` by
`git mv` (store under `core/store/`; 61/63 moves detected as renames at
R095-R100, the two directory barrels merged into `core/index.ts`); changes
beyond import lines are the composition seams below. Exactly five plugin
directories under `src/plugins/` — `alarm`, `action`, `hook`, `compaction`,
`tool` — and `plugins/compaction` imports only `src/core/api.ts` (the one
plugin-facing core surface) plus `@oni/protocol`. The product
compositions `parent-reply/` and `model-selection.ts` moved to
`apps/oni/src/composition/` and enter through new optional core seams
(`ChatAgentConfig.restoreModelSelection`, `SessionChatRunnerOptions.pinnedModel`,
`SessionRuntime.parentReply`) wired in `resident.ts`/`index.ts`/
`process-entry.ts`; `attemptRouteChange` stays private inside
`core/loop/executor.ts` (gate evidence, not a product choice). The root barrel
exports five namespaces (`Core`, `Bundle`, `Model`, `Inspect`, `Testing`) and
the unchanged pinned S8 named-export perimeter. `script/check-deps.ts` gates
the five-band table with three new edge checks — core→plugin banned,
plugin→sibling or non-api core banned, apps→agent internals banned
(`appsAgentInternalViolations`) — each with fail-before tests in
`script/check-deps-agent-bands.test.ts`; the band ratchet is re-keyed to the
new paths with TIGHT pins (review r3: every pin equals the file's HEAD actual
count, a pin above the actual fails closed) — band ratchet 25 at HEAD with
tight per-file pins; the pre-move tree measures 45 under the same classifier,
of which 16 were plugins/compaction imports now routed through core/api and 4
were product-choice edges the move removed (see the reconciliation receipt);
the gate prints the computed total.
Deviation from the issue body: the app did NOT already compose
parent-reply/model-selection — core called them directly at four sites — so
the seams above were added (~10 lines) beyond import-line-only.

## #1251 fourteen-point gate registry (epic #1260, merged as `66d56edb`, PR #1269)

On `epic1260/1251-point-registry` (2026-10-03, base `d34218c6`). Unknown hooks
no longer pass: `packages/protocol/src/policy/point.ts` defines fourteen
`{id, owner, allowedDo, rewritableFields, whenFields}` point records — eight
core (`ingress.pre`, `session.open`, `prompt.pre`, `turn.pre`, `turn.post`,
`llm.pre`, `llm.post`, `message.pre`) and six capability points present only
while their owning builtin is composed (`tool.pre/post`, `compaction.pre/post`,
`alarm.fired`, `action.pre`) — plus the emit allowed set
`message | alarm.arm | compaction`. `row.ts` is the single gate-row contract
(`{id, on, when, do, how, order, generation}`), the decision/consulted/fact
records, the `emittedRowKey` idempotency digest, and the #1255 compose
rejection codes. `packages/agent/src/kernel/points.ts` composes the merged
core+capability table (`composePointTable`; duplicate registration and core
removal are typed `GateComposeError`s) and `executionPoint` is the one lookup
executor and monitor consult — the issue's `core/…` paths map to the #1247
kernel shape (`core/gate/points.ts` → `kernel/points.ts`, `core/gate/compile.ts` →
`kernel/gate/compose.ts` beside the existing row compiler). `compose.ts`
compiles rows fail-closed (`unknown_point` including off-capability points,
`unknown_handler`, `duplicate`, `bad_action`/`bad_field`, `post_end_emit`),
folds deny > require_approval > allow recording every matched row id, applies
rewrites only through declared fields in row order, guards handler service
requirements (an escape records a `requirement_escape` fact and denies), keeps
unrecorded responses observe-only, and replays an identical decision from a
recorded inputHash. Boot derives the latest catalog generation once
(`assertPointGenerationRows` inside the policy-seed derive): historical bytes
are untouched and an unmappable row rejects boot transactionally. The
executor fails closed (`unknown_point`) on unregistered points, prompt and
message have no post consultation, compaction consults `compaction.pre/post`
(the seeded mandatory row moved there), and `policyPoint(`/`row-compiler`
grep to zero; the kernel ledger/llm/timers import baseline shrank from
20 lines/11 files to 1 comment line (#1255 deletes it). Suites:
point-registry, gate-fold, requirement-guard, builtin-seal, decision-replay,
permission-row-migration (byte-preservation over a real SQLite catalog), plus
the apps boot-rejection test.

## #1249 observation bus on Effect PubSub/Stream (epic #1260, merged as `4978236b`, PR #1268)

On `epic1260/1249-bus-pubsub` (2026-10-02, base `d34218c6`, #1248's merge).
The manual-subscriber observation bus is replaced by an app-owned Effect
PubSub: `packages/agent/src/session/bus.ts` builds one unbounded `PubSub` per
owning Scope (`makeObservationBus`), publication is synchronous, nonblocking
and lossy (`PubSub.publishUnsafe`; observations are never journal-durable),
and subscribers are Streams (`bus.observations` / `bus.stream(event, match)`)
or callback drains forked on a bus-scoped `FiberSet` — closing the owning
Scope shuts the PubSub down and interrupts every drain, so overlapping
generations unsubscribe independently at Scope closure. The kernel
`ObservationSink` port is unchanged; `observationBusLayer` provides it as a
Layer. The app mounts the root bus in the runtime's own Scope
(`apps/oni/src/runtime.ts`; injected fixture sinks mount as
`Layer.succeed`) and builds one bus per generation inside the generation
Layer's Scope with a finalizer that gates publishes off before shutdown
(`apps/oni/src/composition/generation-layers.ts`); root fan-out and
`active` gating semantics are preserved. A throwing callback subscriber is
caught per element, logged on the subscriber's own fiber as a typed
`ObservationSubscriberFailure` via `Effect.logError`, and never blocks the
publisher or ends the subscription; scoped-sink delivery failures keep the
#1244 failure-as-data contract (`observation.delivery_failed`). No new Effect
runner sites: the bus publishes with `publishUnsafe` and forks through
`FiberSet.makeRuntime` inside its own Scope; test fixtures (agent `testBus`,
app `Bus`, channels `Bus`) are PubSub-backed and constructed through each
package's named runner owner. `createObservationBus`, `withIsolation`, the
two `queueMicrotask` fan-outs and the `AsyncLocalStorage` isolation store are
deleted to grep zero; `newTraceId` already rode injected entropy
(`packages/channels/src/support/trace.ts`), unchanged. The deleted manual-bus
suite (`packages/agent/test/observation/bus.test.ts`, 7 tests) is superseded
by four Deferred/state-signal suites under `packages/agent/test/session/`
(8 tests: PubSub delivery + Scope closure, Layer-provided sink, generation
rotation, typed subscriber failure). Found en route: dropping the microtask
hop makes interrupt commits durable one boundary earlier, so
`session-wave-e2e` pins the `after_tools` drain boundary.

## #1248 channel timers on Effect Schedule/Fiber/Deferred (epic #1260, merged as `d34218c6`, PR #1267)

On `epic1260/1248-channels-effect` (2026-10-02, base `0ebef4b0`, rebased onto
#1250's merge `9b4e4b8c`). Every channel-driver timer is an Effect program on
an injected runtime: drivers compose Effect values and the app supplies the
one runner port (`EffectRunner` in `packages/channels/src/types.ts`, bound to
`runAppEffect` in `apps/oni/src/index.ts`). `setTimeout(`/`setInterval(`/
`new Promise(`/`calculateBackoff` grep to zero in `packages/channels/src`.
One shared reconnect policy (`src/support/schedule.ts`): exponential from 1s
capped at 60s via `Schedule.min` (this pin has no either combinator), ±20%
jitter, and a 10-attempt supervisor bound. One close starts ONE retry streak
(`src/support/socket-shell.ts`): `Effect.retry` raced (`Effect.raceFirst`)
against a halt `Deferred`, so `stop()` interrupts mid-backoff; exhaustion is a
typed dead shell that publishes `reconnectFailed` and drops sends — generation
counters are deleted, custody is fiber interruption and AbortController
identity (Telegram poller). `fetchWithRetry` is `Effect.retry` with at most
three attempts honoring 429 retry-after; the Discord heartbeat is an
`Effect.delay`/`Effect.forever` loop whose missed-ACK watchdog closes with the
resume-safe code; the process reply wait is `Effect.timeoutOrElse` on the app
runtime clock (`apps/oni/src/composition/process-replies.ts`). Uncertain
deliveries stay `unknown`, are never resent, and now publish one Owner-visible
Warn per physical attempt (`src/support/deliver.ts`). Tests drive the fake
clock through per-test `ManagedRuntime(TestClock.layer())` helpers (the named
runner owners); new suites: backoff-schedule, socket-shell-interrupt,
heartbeat-watchdog, poller-interrupt, process-replies-timeout,
supervisor-bounce, unknown-no-resend. Found en route: Effect v4 `Effect.race`
resolves with the first SUCCESS, so racing a failable wait against a halt
Deferred hangs on failure — every such race uses `Effect.raceFirst`.

## #1247 agent package reorganized by responsibility (epic #1260 P5, merged as `a5ee6c4d` (PR #1266))

Superseded by #1276 (receipt at the top of this file): the seven directories
below merged into one `core/` (store under `core/store/`), the namespaces are
now five, and `parent-reply`/`model-selection` live in
`apps/oni/src/composition/`. Paths in this receipt are the #1247 state.

On `epic1260/1247-agent-dirs` (2026-10-02, base `9b4e4b8c`, merged as `a5ee6c4d`, PR #1266). `packages/agent/src`
had exactly seven directories plus `index.ts`: `kernel/` (turn loop, gate,
tool dispatch, ports, failures), `session/` (entity, run, mailbox, request,
bus, commit, alarm), `store/` (fence, session-file, storage adapters),
`model/`, `plugins/` (compaction, model-selection, parent-reply), `inspect/`
(history, index) and `testing/` (registry, controller — the session registry
and `requireCommit` are test-only). `index.ts` exports seven namespaces (`Kernel`,
`Session`, `Bundle`, `Journal`, `Model`, `Inspect`, `Testing`) plus the pinned
nine-name S8 perimeter consumed by `packages/channels` (legal channels -> agent
band edges; no lane owns retiring it); `script/check-deps.ts` fails if the pin grows or changes. The legacy
timer and lease vocabularies are renamed to the alarm and fence names on TS
surfaces only — the durable SQLite columns stay `lease_owner`/`lease_fence`
byte-identical. The old flat controller module and `core/settled.ts` are
deleted; the issue's retired token families (the timer-port pair, the
camel-case lease trio, the flat controller module name, and the registry
symbol outside `testing/`) grep to zero across packages/apps/script/docs
(see the lane report for the literal commands). Intra-agent imports are banded
(kernel→session→store…) with a shrink-only ratchet in `script/check-deps.ts`.

Measured deviations, accepted by the Owner
([PR #1266 comment](https://github.com/INONONO66/oni/pull/1266#issuecomment-5951852779)):
`kernel/` measures 6,090 LOC against the issue's ≤4,200 target — the issue's
own routing table places `gate/decide.ts` in `kernel/`, and the size shrink is
deferred to #1251/#1255, not re-planned in this lane. The band-ratchet
baseline is 36 violations across 15 files against the issue's 20/11 estimate —
20/11 was measured at `f7e36984`, before #1246 folded policy/ledger/llm into
`packages/agent`, so those edges were cross-package imports there and are
intra-package band edges now; the baseline is pinned shrink-only, every surviving
entry is a pre-existing edge (one scanner hit on a lane-written comment was
reworded away in review r1), and the provenance table is in the lane evidence.

## #1259 slop cleanup band b1: protocol core and gateway tests (epic #1260)

Band b1 of the #1259 cleanup ladder landed on `epic1260/1259-b1-protocol`: thirteen protocol items fixed (dead `NamedError.Unknown`, `Tool.Events.PermissionDenied` and `Operational.envelope` deleted with their tests, four stale/false doc comments rewritten, zod-4 `code: "custom"` spelling unified, redundant `EpochMs.nonnegative()` dropped, hand-rolled test try/catch patterns replaced with `.toThrow()`, `const it = test` aliases removed, the author's personal path replaced in the `SurfaceKey` fixture and doc example), three kept with rationale, two deferred (154 to the channels band, 145 `Inbox.Port` to #1258's `ledger/l0.ts`); receipts in the `docs/SLOP.md` §L row.

## #1250 model and desktop unified on AI SDK 7 (epic #1260, merged as `9b4e4b8c` (PR #1265))

On `epic1260/1250-ai-7` (2026-10-02, base `0ebef4b0`). `packages/agent` and
`apps/oni` pin `ai@7.0.93` (the exact desktop version) with provider
majors 4 (`@ai-sdk/anthropic@4.0.49`, `@ai-sdk/openai@4.0.60`, both resolving
against the same `@ai-sdk/provider@4.0.10`); no ai 6 or provider-utils 4
resolution remains in `bun.lock`, whose diff is the ai dependency closure (the
`ai`/`@ai-sdk` entries plus the transitive keys they drop or re-resolve). The model plane uses `isStepCount`, passes
the system prompt as `instructions` (a `SystemModelMessage` carrying the
Anthropic cache breakpoint), and reads the nested
`inputTokenDetails`/`outputTokenDetails` accounting; the v6-only flat
cached-input usage alias is gone. One shared 7-signature ai test mock
(`packages/agent/test/model/helpers/ai-mock.ts`) replaces the three copies;
`model-stream-v7`, `usage-v7`, and `max-retries-zero` pin stream-event order,
nested token totals, and the `run()` boundary around retries: one `streamText`
call per attempt, handed `maxRetries: 0`, with the failed attempt surfacing as
a typed failure (the mock replaces `streamText`, so in-SDK retry suppression
itself is the SDK's `maxRetries` contract, not re-proved here). SDK retries,
tool approval, runtime contexts, and default AI Gateway routing stay off. Desktop pins (`ai@7.0.93`, `@ai-sdk/react@4.0.96`) are
untouched; the desktop boundaries recompile and their transport/session tests
pass unchanged.

## #1246 ten packages merged into five (epic #1260 P4 after #1245, merged as `0ebef4b0` (PR #1264))

(Historical receipt; #1272 later re-extracted code mode into `packages/codemode`, making six packages.)

On `epic1260/1246-packages-10-5` (2026-10-02). The repository has exactly five
packages plus two apps; the retired directories and their package names grep to
zero everywhere, including scripts, CI, and docs.

- **Package list.** `packages/protocol` (schemas and pure folds, no deps),
  `packages/agent` (durable-session kernel; absorbs the former policy engine at
  `src/kernel/gate/{compile,match}.ts`, the durable store plane at `src/store/`
  with SQLite adapters under `src/store/storage/`, and the model plane at
  `src/model/`; depends on protocol), `packages/machines` (raw machine
  endpoints; absorbs the ipc transport at `src/ipc/` and the code facade at
  `src/codemode/`; depends on protocol), `packages/channels` (drivers +
  perimeter router; absorbs the channel-facing stores — actor, blacklist,
  channel-grant, reply-grant, egress, provisioning/vault — at `src/store/`;
  depends on protocol + agent), and `packages/ui` (data-blind design system,
  no deps). `apps/oni` composes protocol/agent/machines/channels;
  `apps/desktop` sits on protocol + ui.
- **Wiring.** Everything external imports through each package's one root
  barrel; no re-export file exists at any old package path. `AgentFailure` and
  `MachinesFailure` are the surviving untyped-cause carriers
  (`LedgerFailure`/`LlmFailure`/`IpcFailure`/`CodemodeFailure` deleted).
- **Gates.** `script/topology.ts` is the five-package inventory consumed by the
  dependency, cycle, knip, CI-lane, and tsconfig gates; `script/check-deps.ts`
  S8 pins the only two channels→agent surface bands (judgment band
  `src/router/` + `src/authn/`: `evaluatePermission`, `decisionFromEvaluation`,
  `PolicyEvaluationInput`, `createDecisionFactPort`, `createSurfaceKeyStore`;
  store band `src/store/`: `requireSubAdapter`, `withStoreTimestamps`,
  `StoredIdentity`, `StoredEndpoint`); drivers stay on `{protocol}`.
- **Verification.** `ls packages` prints the five directories;
  the five retired package names, the ORM name, and the gate-hook token grep
  to zero across `packages apps script docs .github`. Historical receipts
  below this section may still name pre-#1246 paths; path claims in them are
  historical, and this section plus `AGENTS.md` are authoritative for current
  wiring.

## #1245 injected configuration, clock and entropy (epic #1260 P3 after #1244, merged as `c1d5ebd2` (PR #1263))

On `epic1260/1245-inject-clock-entropy` (2026-10-01, base `a4478b0e`). Ambient
time, entropy and environment reads are replaced by injection; seven
permissive defaults become explicit typed outcomes.

- **Three environment owners.** `process.env` is read only by
  `apps/oni/src/config.ts` (vault key resolved once into
  `OniConfig.kek` via `resolveKek(env, home)` and injected into declared
  provisioning), `apps/oni/src/cli/env-file.ts` (`processEnvironment()`
  for cli/main and watch-sources spawn env), and
  `packages/llm/src/model/loader.ts` (`resolveAuthFilePath(env)`, called
  once when `LlmLive` is constructed; the Layer closes over the path and
  `Auth.all/get/set/resolve` and raw `run`/`Provider.resolveModel` take
  `authFilePath` explicitly, so `auth/storage.ts` has no env read and no
  resolver call). The desktop reads env only
  through `bootstrap(process)` → `resolveDesktopConfig(env)` in the new
  `apps/desktop/src/main/config.ts` (`gateway-endpoint.ts` deleted); the
  config is pinned once at module load.
- **Effect Clock and agent Entropy.** The custom agent Clock service is
  deleted from `packages/agent/src/services.ts`; Effect code uses the
  built-in `Clock` (`Clock.currentTimeMillis`, TestClock-replaceable).
  `packages/agent/src/core/entropy.ts` (since #1247 `packages/agent/src/kernel/ports.ts`) owns the temporary `Entropy` service
  (`EntropySource { id(): string; random(): number }`, `Entropy.layer`);
  the executor derives plain `clock`/`entropy`/`random` functions from both
  services and threads them through execution. #1247 places Entropy finally.
- **Promise-side injection.** channels, llm, ledger, ipc, codemode and the
  desktop renderer take required plain function options — `now: () =>
  number`, `id: () => string`, `random: () => number` — with inline types and
  no fallback defaults (`?? Date.now` deleted everywhere). Representative
  owners: `ChannelProvider.create(credentials, config, publish, { now, id,
  random })`, `GatewayRouterPorts.now/id`, llm `RunInput.now/id` and
  `Retry.decide(..., { now, random })`, `openCatalogStore`/`openSessionStore`
  `{ now }`, ipc `PeerRequestTable` required `idSource`, `createCodemode({
  id })`, renderer `createPlatform({ clock, ids })` bound once in `main.tsx`
  (`RendererPlatform { now(): number; id(): string }`; minting before
  `bindStorePlatform` throws `RendererInvariantError`). Composition roots
  supply sources: `apps/oni/src/composition/platform.ts`
  `platformEntropy()` holds the tree's only `node:crypto` randomUUID import,
  and protocol `traceIdFromUuid` alone formats trace IDs.
- **Seven defaults replaced.** (1) Unknown-provenance external mail runs
  with `evidence_only` authority plus a typed `InboundAuthorityViolation`
  fact (`session.inbound_authority.violation`), never `act`; (2) a missing
  failure reason becomes typed `reason: "unclassified"`; (3) a missing llm
  sink snapshot is `Effect.die(AgentInvariantViolation)`, not an empty
  assistant; (4) the tool wave bills injected-clock elapsed time instead of
  0ms; (5) absent runner output returns typed `RunnerOutputMissing`, not a
  policy `invalid_output` refusal; (6) `drain()` refusal is a typed
  `SessionDrainOutcome` and the append receipt carries required
  `admission: "stop" | "refused" | "turn"`; (7) a websocket frame without
  `eventId` returns `{ admitted: false, reason: "missing_key" }` — the
  perimeter never mints a deduplication key. Anonymous-session admission in
  `external-message.ts` is kept; only its minter is injected.
- **Verification.** `rg -n 'Date\.now\('`, `rg -n 'Math\.random\('` and
  `rg -n 'crypto\.randomUUID\('` over `packages/*/src apps/*/src` print zero
  lines (122, 2 and 42 sites removed); `rg -l 'process\.env'` over the same
  scope prints exactly the three owner files. Tests advance time with
  `TestClock.adjust` or fixed `now`/`id`/`random` stubs — no sleeps, no
  `Date.now`/`Math.random` spies. Mutation campaign and full CI are not
  claimed complete.
- **Receipts:** `.omo/evidence/ulw/01a0f656-c9f6-795d-9bfb-786c6699559b/1245/`
  holds the issue body, lane briefs and the eight lane reports with
  per-lane searches and test counts.

## #1244 package-owned typed failures (epic #1260 P2, merged as `a4478b0e`, PR #1262)

On `epic1260/1244-typed-failures` (2026-10-01, base `fb709568`). The shared
`ForeignFailure` tag is gone; every runtime package owns its failure
identity, and no production module throws a bare `Error`.

- **Seven package-owned failures.** `AgentFailure`, `LedgerFailure`,
  `LlmFailure`, `IpcFailure`, `MachinesFailure`, `CodemodeFailure` and
  `ChannelsFailure` (each a `Data.TaggedError` with `operation`/`cause`)
  replace `ForeignFailure`; `Failure.of` synthesizes `AgentFailure`. The
  ledger/llm/ipc/codemode ones are temporary until #1246 folds those packages.
- **Refusals are values, failures are typed, invariants are defects.**
  Policy refusals are plain result data returned to the caller
  (`SessionPolicyRefusal`). Expected Effect failures are the typed
  `Data.TaggedError` classes in each package union (the package `*Failure`s,
  `ContextRestoreError`, `CompactionExecutionError`, ...). Broken invariants
  are defects — thrown Errors or `Effect.die` (`AgentInvariantViolation`,
  `LedgerInvariant`). Two synchronous surfaces throw caller-handleable
  refusals instead of failing an Effect: `requireCommit` throws
  `SessionCommitError` and the actor registry throws `ActorRegistryRefused`.
  Pure tool bodies and protocol/ui/desktop throw
  named error classes (`CliError`, `AppInvariantError`,
  `ConfigurationError`, `TranscriptRecordingDefect`, ...).
  `rg 'throw new Error\\(' packages/*/src apps/*/src` is zero.
- **Deleted, not replaced.** `AlarmRefused`, `InboxCommitRefused` and the
  never-built `inbox`/`alarms` capability values; the five
  `executor-context` guards fold into `requireExecutor()`;
  `SessionCommitError` and `ReplyGrantProjectionError` move into their
  packages' errors modules; `DataPaymentRequired` (no producer puts a status
  under `.data`).
- **llm keeps the SDK error.** `APIError` is a thin tagged identity over the
  AI SDK's own `APICallError` (`cause`); provider facts (status, headers,
  body, retryability) are read from the SDK error and never copied, detection
  is `APICallError.isInstance`, and `LlmRunFailure.cause` carries the SDK
  error for classification. `ai` becomes a devDependency of agent and app so
  fixtures construct real `APICallError`s.
- **Logging without runners.** ipc/ledger/agent `console.*` calls are gone.
  ledger returns publish failures to an injected `ObservationFailurePort`;
  the agent observation bus reports a subscriber or sink failure through an
  injected reporter, else as an `observation.delivery_failed` fact on the
  same sink (a throwing reporter yields both failures in that fact; a failing
  failure report is dropped). Effect code logs through `Effect.log*`, asserted
  with a captured `Logger` through each package's one test-runner owner. No
  new runner site: `effect-runner-sites.json` stays `[]`.
- **Receipts:** `.omo/evidence/ulw/01a0f656-c9f6-795d-9bfb-786c6699559b/1244/` holds
  `gate-1244.log` (static gates + 15 CI lanes), `verify-1244.txt` (the
  issue's four searches), `patch-coverage-1244.txt`, `dod-1244.txt`,
  `checks-1244.txt`, the lane briefs/reports and review rounds.

## #1243 shared JSON/failure/interrupt helpers (epic #1260 P1, merged as `fb709568`, PR #1261)

On `epic1260/1243-shared-helpers` (2026-10-01, base `5641cff8`). Three
behaviours that were repeated across packages now have one owner each;
every consumer keeps its drop/warn/default and abort-once semantics.

- **One JSON wire parser.** `parseJson(schema, text)` in
  `packages/protocol/src/json.ts` returns the schema-typed value or
  `undefined` for text that is not JSON, a value that fails the schema, or a
  validation that throws. Consumers: discord gateway frames, slack socket
  envelopes (each now emits one warn string per dropped frame), ipc
  `LineDecoder` malformed reporting, llm retry payloads, the desktop renderer
  transport frame and saved window bounds (`?? WINDOW_DEFAULT`).
- **One Cause-to-failure fold.** `packages/agent/src/failure.ts` (since
  #1247 `packages/agent/src/kernel/failure.ts`) exports
  `fromCause(cause, synthesize)` (typed error if the Cause carries one, else
  `synthesize(Cause.pretty(cause))`) and the agent profile `of(cause,
  operation)` that synthesizes `AgentFailure` (#1244; `ForeignFailure` until then). Consumers: executor tool and
  completion outcomes, `session-turn` results, and app boot (`Failure.fromCause`
  with the app-owned `AppLifecycleFailure`). The remaining
  `Cause.findErrorOption` sites are Option extractions, not synthesis.
- **One abort listener owner.** `listenForAbort(signal, listener)` in
  `packages/protocol/src/platform.ts` is the only `addEventListener("abort")`
  in `packages/*/src` and `apps/*/src`; an already aborted signal fires at once
  and registers nothing. Effect bridges are `onAbort`/`interruptOn` in
  `packages/agent/src/core/interrupt-on.ts` (since #1247 `packages/agent/src/kernel/ports.ts`) and the one-expression `onAbort`
  connector in `packages/machines/src/interrupt-on.ts` (agent and machines
  cannot import each other; protocol is their common dependency). Consumers:
  executor body fibers, `tool-body`, `session-turn`, retry timers, approval
  waits, invocation close, machines exec/host cancellation, codemode kernel
  cancellation and cell launch, the CLI follow signal, and the desktop
  transport. `packages/machines/src/abort.ts` and the desktop renderer copy are
  deleted.
- **Waiters and fan-out.** The `Set<() => void>` listener sets in
  `executor-raw.ts` and `compaction/speculate.ts` are `Deferred`s (per raw
  slot; per preparation generation). `concurrency: "unbounded"` is gone:
  `BOUNDED_CONCURRENCY = 16` (`packages/agent/src/core/concurrency.ts`; since #1247 `packages/agent/src/kernel/ports.ts`) for
  session close, tool waves and approval stages, `CLOSE_CONCURRENCY = 16` for
  codemode kernel close, and `2` for the two-element app shutdown join.
- **Kept, with reason.** The four `Promise.withResolvers` sites
  (`executor-raw.ts` retain settlement, `process-replies.ts` first/answer,
  `watch-sources.ts` eof) hand promises to promise-world callbacks; a
  `Deferred` there would need a `runPromise` runner site, which the
  `effect-runner-sites.json` `[]` law forbids. They are promise handles, not
  waiters, and stay.
- **Deviation from the issue text.** #1243 proposed three local
  `interrupt-on.ts` copies; two identical copies measured as one jscpd
  production clone (main is at 0), so `listenForAbort` lives in protocol and
  only the Effect wrappers are local.
- **Gates on the branch:** build, check-types, lint (including
  `noExcessiveCognitiveComplexity`; the desktop `sendMessages` optional-signal
  guard is the named `stopOnAbort` function), lint:tools, topology, deps,
  effect boundaries, written any/unknown 0, dead exports, import cycles,
  tsconfig inheritance, jscpd production clones 0, and
  `bun run ci test --lane <key>` over the 15 CI lanes (4828 pass / 0 fail across 15 CI lanes (gate r5, 2026-10-01)); patch coverage
  `all changed executable lines covered` (`script/check-patch-coverage.ts --base origin/main`, lane lcov union).
- **Receipts (HEAD `ec247818`):** `.omo/evidence/ulw/01a0f656-c9f6-795d-9bfb-786c6699559b/1243/`
  holds `gate-1243.log` (lane totals), `patch-coverage-1243.txt`, `dod-1243.txt`
  (ultracite on the 32 changed sources, written any/unknown 0, jscpd 0 clones for the
  three touched packages and `quality:clones:production` 0 clones over 473 sources,
  dead-export ratchet 0 new), `verify-1243.txt` (the issue's rg searches), `checks-1243.txt`
  (CI 30 pass / 0 fail), `review-1243-r1.md` + dispositions, and
  `gate-1243-watch-sources-flake.md` (a pre-existing `watch-sources` flake met by
  the local gate on untouched code; its own subgoal, not this PR).
- **Desktop checks:** the two renderer/main behaviours touched here are covered by
  automated counterparts, `gateway-transport.test.ts` "ignores malformed frames and
  retains unsolicited reply correlation" and `window-bounds.test.ts` "Given malformed
  or undersized JSON, When parsed, Then the default" (desktopApp lane 443 pass / 0
  fail). A native Electron run was not performed.

## W5.3 #1113 closure receipt (2026-09-29, merged as `f7e36984`, PR #1240)

W5.3 on `kernel/1113-w5-closure-20260929` (draft PR #1240, HEAD `03f70089` plus this docs commit,
base `8390912c`) closes the W5 absolute-quality lanes. Lane receipts live
under `.omo/reports/kernel-campaign-w53/`.

- **Effect runner owners (A1):** `script/conformance/effect-runner-sites.json`
  is `[]` (48 → 0). `script/check-effect-boundaries.ts` names exactly one
  test-runner owner per package (`RUNNER_OWNERS`: the oni, agent,
  channels, ipc, ledger, llm, and machines test helpers) plus the two named
  bench entrypoints (`packages/agent/bench/turns.ts`,
  `packages/ledger/bench/index.ts`); the production edges remain
  `apps/oni/src/cli/main.ts` and `apps/oni/src/gateway.ts`. No
  production `src/` file changed for A1.
- **Written any/unknown 0 (A2/A2b/A3):** repository-wide written
  `any`/`unknown` type keywords went 68 → 0 (A2 protocol 16 → 0, A2b the last
  4 protocol sites, A3/A3b the script/app/package sites). The new AST gate
  `script/check-written-types.ts` (`check-written-types` package command,
  wired into CI next to `check-effect-boundaries`) has no baseline and
  excludes only `*.test.ts(x)`; it exits 0 with
  `OK: written any/unknown types: 0`. A2 also deleted 53 dead protocol export
  identities (`app-connector/`, `Mcp.Events`, `McpConfig`, `Deadline`, and the
  Tool/Transcript/Policy/Machine/Ingress aliases with zero production
  consumers).
- **One app-owned read model (A4/A4b):** the single read surface is the
  `session_read` handler in `apps/oni/src/gateway.ts`; channels only
  parses and transports the frame. Every read wire DTO is Zod plain data in
  `packages/protocol/src/gateway/session-read.ts` (`SessionRead.Request` /
  `Cursor` / `Page` / `Gap` / `Receipt`); the `session_snapshot`,
  `session_page`, and `session_gap` frames are additive. Usage provenance is
  `reported | estimated | unknown`, forked at the provider accounting site
  (`packages/llm/src/processor/stream-events.ts`) and written once by the
  durable attempt-result writer. Inspection is bounded
  (`packages/agent/src/inspect/index.ts`: limit 1-256, shared
  descendant budget, indexed catalog child pages, zero `kernel.listRows`
  loops). Desktop owns one query per durable session ID; tabs, drafts and
  selection stay local, and `DEFAULT_PROJECT_ID` plus the renderer
  `phase: "idle"` seeds are grep-zero.
- **A5 mutation baseline fix:** the #1049 baseline-compiler rejection is fixed
  by root-file candidate ownership (each compiler project diagnoses only its
  `getRootFileNames()`); the execution-copy tracked-deletion mirror is scoped
  to git roots (non-git fixture roots no longer fail); `quality-audit` gained
  TypeScript function metrics — cyclomatic (<22), Halstead difficulty (<80),
  CRAP (<25) — implemented in `script/quality-typescript-metrics.ts` and
  pinned in `script/conformance/quality-contract.json`.
- **W4 #1112 disposition (A6):** inert `RunInput.maxSteps` and orphaned
  `Retry.sleep` are deleted; the named executor files have zero duplicate
  abort/race owners; `tool-body.ts` keeps its one invocation-scoped
  cancellation bridge; channel HTTP retry and reconnect stay transport
  behavior. Full audit: `.omo/reports/kernel-campaign-w53/W4-1112-receipt.md`
  (H10 closed).
- **Review r1 findings 1-7 landed** (`review-r1.md`; fixes in `F1.md`,
  `F2.md`, and commits `cb4bf00e`/`f4542212`): (1) session-level terminal
  pages no longer settle other turns' pending chats; (2) an empty same-epoch
  same-head continuation keeps the cached page; (3) the descendant budget is
  independent of the mandatory root visit; (4) paged turn ancestry resolves
  through indexed `actionById` reads; (5) script entry points use top-level
  try/catch instead of inferred-`any` `Promise.catch`; (6) `phaseSince`
  derives from the phase-establishing transition; (7) the resume regression
  asserts exactly one delivery again. Each fix has a fails-before /
  passes-after regression.
- **Review r2 finding 1 (F1-r2):** the accepted receipt is restored to its
  frozen base shape `{type:"receipt",status:"accepted"}`; the durable binding
  moved to the additive `session_bound` frame (`SessionRead.Bound`), sent
  immediately after the receipt on the same socket; desktop binds from
  `session_bound` and ignores receipts.
- **Review r2 findings 2–7 (F2-r2..F6-r2):** (2, 6) the mutation baseline
  and candidate compilers share one root-file diagnostic ownership rule
  (`projectRootPaths`/`ownsDiagnostic` in `script/quality-mutation-input.ts`)
  and the generator's covered set is canonical root ownership, so
  transitive-only inventoried files enter the fallback deterministically;
  (3) the scheduled audit decodes the persisted version-1 summary footer
  (`previousTotalsSchema`) and skips regression rows for dimensions the
  footer never measured instead of comparing against invented zeros; (4)
  overlapping desktop `readSession` calls keep every waiter — same cursor
  coalesces onto the in-flight read, a differing cursor is rejected with the
  typed `SessionReadSupersessionError`, and close/error/session-scoped error
  frames reject all waiters;
  (5) paged turn ancestry resolves through descending 256-action history
  windows (zero point reads; a one-action page over a 300-link chain costs at
  most three window reads, attribution exact); (7) `readSessionCursor`
  captures every phase fact before the fence/revision check, so an
  interleaved commit surfaces as a typed `session_gap` instead of an old page
  with a newer turn's `phaseSince`; F6 sizes the durable-reconstruction
  child-exit deadline (60 s, exact exit signal) for cold hosted runners. Each
  fix carries a mutant-killed regression.

Wave-B gate line (`B-verify.md`, run locally at branch HEAD): build 0,
check-types 0, lint 0, lint:tools 0, lint:docs 0, check-topology 0,
check-deps 0, check-import-cycles 0, check-dead-exports 0,
verify-tsconfig-inheritance 0, check-effect-boundaries 0,
check-written-types 0; root `bun test --timeout 15000 --coverage`:
**4671 pass / 0 fail** after the r2 fix lanes (4635 before them); script
lanes serially 253/81/336 pass, 0 fail.

Honest audit deltas (`quality-audit --dry-run`; the W5.3 column had no local
LCOV lanes, so `complete: false`; the sweep column ran all 15 lanes locally
with LCOV, `complete: true`, `missingLanes: []`):

| Kind | `8390912c` baseline | W5.3 HEAD | quality-debt sweep (2026-09-29) |
| --- | ---: | ---: | ---: |
| coverage (uncovered lines with LCOV; missing-file records before) | 3116 | 485 | 1777 uncovered lines / 162 files |
| complexity | 17 | 14 | 0 |
| cyclomatic (new, <22) | — | 1 | 0 |
| halstead (new, <80) | — | 0 | 0 |
| crap (new, <25; needs LCOV) | — | 761 (no coverage input) | 0 |
| clones | 280 | 280 | 0 |
| types (transitive inferred sites, not written keywords) | 2779 | 2123 | 479 |

The sweep's residual coverage is enumerated in `docs/SLOP.md` §J (CLI
`main()`/violation-print paths in `script/`, race-guard tails in `agent`); the
479 type sites are Zod boundary parses and inferred generics, not written
keywords (`check-written-types` stays 0).

Not claimed: CI green, patch coverage, or mutation completion. B-verify
measured 71 patch-uncovered changed lines across 12 files locally; wave C
lanes C1/C2/C3 close them, and the authoritative gate is the CI
patch-coverage job on PR #1240. The full mutation campaign remains the
scheduled `quality-mutation.yml` run.

## W5.2 session entity receipt (#1197, 2026-09-28)

W5.2 merged as `8390912c` (PR #1239, 2026-09-29) on
`kernel/1197-session-entity-20260928`; it
ships one `Session` entity per `sessionId` on the `effect/cluster`
`SingleRunner` exposed by Effect `4.0.0-rc.118`. Each activation opens one
fresh-schema SQLite file under the configured sessions directory and shares a
catalog SQLite file for cross-session facts and cluster coordination. There is
no legacy migration path: the former `catalog.db` and other old database files
are neither read, migrated, nor deleted.

The entity owns mailbox FIFO followed by `decideSessionAdmission`, rotates the
session fence once per activation, drains the complete admitted backlog, and
uses `DeliverAt` messages for retry, request-deadline, and monitor timing. The
entity port now exposes `settle`; interruption detaches a running turn at the
entity boundary, and shutdown awaits quiescence before closing stores.
`localInboxCommit` borrows the active entity authority only while that entity
is running, preserving live-turn fence ownership while unrelated callers still
fail closed.

Historical deletion receipt: the former lease/alarm/inbox/migration planes are
deleted to the plan §5(a) grep-zero contract. Deleted symbols are `LEASE_TTL_MS`,
`HEARTBEAT_INTERVAL_MS`, `renewLease`, `acquireLease`, `sweepSessions`,
`wakeSession`, `createAlarms`, `Storage.get`, and `Storage.initialize`.
Deleted source surfaces include `packages/ledger/migration/`,
`packages/ledger/src/storage/migration-runner.ts`, the `u967-*`, `u969-*`,
`historical-projections`, and `historical-request-format` migration readers,
`packages/agent/src/executor-retry-alarm.ts`, and
`apps/oni/src/composition/alarm-worker.ts`. The obsolete script gates
`check-ledger-schema-drift`, `verify-ledger-rename`,
`generate-ledger-archive-manifest`, `ledger-archive-snapshot`, and
`ledger-producer-manifest` are also deleted.

The crash matrix remains exactly 27 faults on the entity plane. Parent-measured
gates at this branch state are: `apps/oni` 529/0, packages 1443/0,
channels 576/0, script 717/0, `check-types` exit 0, dead exports 0 known/0 new,
`check-effect-boundaries` exit 0 with its runner-site allowlist reduced 54 → 48,
and the §5(a) deletion grep at zero.

This receipt does **not** claim full CI, the pending L4.2 patch-coverage 100%
gate, or a mutation campaign. The 16 pre-existing protocol `unknown` sites
remain carried to #1113. Known findings are explicit: cluster entity reaper
resolution is at least five seconds; `ConfigProvider.fromEnv()` snapshots the
environment at module load; and protocol still retains the `Inbox.Commit` and
`Alarm.Watch*` wire schemas even though their consumer moved into the entity.

## Historical receipts retained below

The remaining sections preserve the evidence and scope claimed by earlier
campaign increments. Their source names are historical context, not live W5.2
ownership.

W5.0 (#1195) Effect pin `3.22.2` → `4.0.0-rc.118` (exact, published 2026-09-28) on `kernel/1195-effect-v4-pin-20260928` (PR #1198, ⏳ pending merge): zero behavior change — mechanical v4 renames across nine workspaces, `FiberRef` → `Context.Reference`, `Effect.withFiberRuntime` → `Effect.withFiber`, `Cause` reason filters, `Effect.all` failure semantics of `shutdownSessions` preserved under v4 `mode: "result"`, `effect/testing` `TestClock`; protocol/ui/desktop/tool bodies stay Effect-free (`check-effect-boundaries` 233 allowlisted ratchet sites, allowlist 224 entries, both unchanged from main); no `effect/unstable` cluster or workflow import. Receipts under `.omo/reports/kernel-campaign-w50/`. W3 (#1111) merged as `75d28562` (PR #1193, 2026-09-26): single ledger policy-generation writer (compiler `append: () => false` deleted), executor dispatch table with captured toolsGeneration, ToolCatalog Layer built once per generation with tools/** effect-free and sealed 12-tool catalog (read, write, edit, ls, find, grep, bash, eval, monitor, send_message, provision, completion), and typed evidence-only authority (`SessionRunnerInput.authority` from inbox `origin.inboundTreatment`) with OBSERVATION prose prefix deleted. W0.5 (#1184) source wiring inspected on `kernel/1184-consumed-layers-20260924`, 2026-09-24. This stamp covers the Layer/bundle slice below, not a re-verification of historical receipts or a merge/CI claim.

| Slice | Status | Scope |
| --- | --- | --- |
| Consumed Effect Layer floor (#1184), 2026-09-24 | wired in worktree; full acceptance not asserted | Effect factories consume Tags; AppLive composes package Layers and an app-owned generation map; validated bundle definitions and named policy contributions build in captured generation scopes. Sources and remaining boundaries follow below. |

At the #1184 inspection paths (since #1247: `packages/agent/src/kernel/gate/decide.ts`, `packages/agent/src/kernel/tool.ts`, `packages/agent/src/kernel/turn.ts`): `packages/agent/src/executor.ts` resolves Clock, Entropy, ObservationSink and
SessionLayer; `packages/agent/src/tool-dispatcher.ts` (since #1247
`packages/agent/src/kernel/tool.ts`) resolves ToolCatalog.
`packages/agent/src/core/execution/run.ts` (since #1247 `packages/agent/src/kernel/turn.ts`) and
`apps/oni/src/composition/completion.ts` resolve Llm and ObservationSink.
App boot and gateway thread the ledger plane explicitly
(`apps/oni/src/index.ts`, `apps/oni/src/gateway.ts`);
`createAppLedger` (`apps/oni/src/composition/cluster-runtime.ts`) owns
storage acquisition/release.

`apps/oni/src/runtime.ts` builds AppLive with a final Layer.mergeAll.
`apps/oni/src/composition/generation-layers.ts` constructs the selected
catalog, scoped local observations, named registry and compiled policy; its
session-keyed managers use `packages/agent/src/session-generations.ts`
(since #1247 `makeSessionGenerations` in
`packages/agent/src/session/run.ts`; the `GenerationRawSlots` raw-slot
service lives in `packages/agent/src/kernel/gate/decide.ts`) for
capture/configure and retirement. Boot initializes immutable role definitions
before recovery. Installed bundle names are passed to new sessions, and bundle
rows enter existing policy seeding (`apps/oni/src/index.ts`,
`apps/oni/src/bundles/core-policy/index.ts`). Existing configure operations carry recorded
membership unchanged (`packages/agent/src/session-configuration.ts`; since
#1247 `createSessionConfiguration` in `packages/agent/src/session/run.ts`).

`packages/agent/src/bundle.ts` (since #1247
`packages/agent/src/kernel/bundle.ts`) validates definitions and ordered composition,
including named policy services. The executor records original arguments when
pre-transforms apply (`packages/agent/src/executor.ts`,
`packages/agent/src/executor-record.ts`; both since #1247 `packages/agent/src/kernel/gate/decide.ts`). These are source-inspection claims,
not receipts for every runtime, crash, performance or patch-coverage gate.
B6 remains open: configure authority and approval-binding callbacks survive
([SLOP](SLOP.md#w05-consumed-layer-floor-1184)); W0.5 does not claim their W1
migration, a bundle membership API, full W3 G1, or concrete production bundles.

Policy/ledger ownership was updated on `kernel/s1-authority-cut-2`, 2026-09-18: G002 (#930) deletes the unused composition schema and moves app action reads to narrow SQL-backed ports.

**G003 durable spine (`kernel/s1-durable-spine`, 2026-09-18, #930):** the volatile `waitRetry` seam is deleted; a provider retry commits an `alarm.arm` action carrying a `retry.scheduled` spec (kind `at`, id `<intent>:retry:<attempt>`) before any wait, and the live waiter or boot alarm worker consumes it exactly once through the fenced cancel CAS (now admitting one-shot alarms) and wakes the session without an inbox prompt (`packages/agent/src/executor-retry-alarm.ts`, `apps/oni/src/composition/alarm-worker.ts`). A boundary-flagged execution (compaction) commits summary + successor projection + accounting as one ledger transaction before result commit or publication; crash recovery settles the open intent executed-from-boundary without resummarizing (`packages/agent/src/executor.ts`, `executor-recovery.ts` — since #1247 `packages/agent/src/kernel/gate/decide.ts` — and `compaction/execute-cut.ts`, since #1247 `plugins/compaction/execute-cut.ts`). Commit-time writer fencing is recorded as taxonomy: a stale fence gets the typed `{ok:false, reason:"stale"}` rejection atomically with no partial row, proven fence-only under the same owner name (`packages/ledger/test/session/commit-fencing.test.ts`). Crash-matrix rows `retry_backoff_wait` -> `rearmed`, `compaction_summary_before_result_commit` -> `resumed_without_reexecution`, `owner_reclaimed_before_stale_transcript_flush` -> `rejected`.

Single source of truth for current wiring, not a declaration that every target in [Core Model](core-model.md), [Kernel Contract](kernel-contract.md), [Architecture](architecture.md), or [Machines and Delegation](machines-and-delegation.md) has shipped. [Epic #930](https://github.com/INONONO66/oni/issues/930) supersedes #459 for kernel delivery; #966 and #968-#973 are the subsequent lifecycle campaign.

[Kernel reference pins](kernel-references.md) are owned by `docs/kernel-references.md`.

**#945 absolute census (2026-09-19, main `f5ea0e32`):** the Quality ratchet is green as a no-growth gate; the admitted baseline still holds 60,509 rows (99,601 multiplicity) across coverage, type, CRAP, clone, export, publisher, complexity and store gates. #945's literal-zero definition of done is not met; the per-gate table and the full-mutation campaign outcome are in [SLOP](SLOP.md#945-absolute-census-receipt-2026-09-19-main-f5ea0e32).

**#969 cutover (2026-09-07):** waiting and authenticated consent are original-action state. Source-owned outbound obligations feed the receiving kernel and inbox. Migration 0038 removes the independent stores with guarded archival retention. Final HEAD, gate outputs and acceptance receipts are recorded in the PR and local report.

**#971 cutover (2026-09-08):** alarm occurrence identity, deadline and notification budget are decided by the ledger from the committed row and its persisted spec; the evaluator reports a transport `sourceKey` and redelivery commits nothing. No schema change, no migration, no new table.

**#970 cutover (2026-09-08):** interrupted executor operations settle from classified durable evidence, never by rerunning a body. Attempt ordinal, cap, retry reason, usage, visible-output boundary and a non-secret credential handle are pinned on attempt actions. `restore_model_selection` and `restore_context_projection` are recorded, policy-evaluated actions that append; no schema change, no migration.

**#973 conformance (2026-09-08):** the unified lifecycle is proven on the real tree, not declared. `runLifecycleTrace` (`packages/agent/test/session-lifecycle-conformance.test.ts`) runs the six section 6.7 registrations of the [lifecycle contract](session-lifecycle-contract.md) over the real store, controller, executor waves, request port, outbound path and alarm rows, asserting append-only history, causal parents, terminal uniqueness, single input consumption, one observation per commit and effect-free replay from the reopened SQLite image. No production writer moved and no fixture was deleted; the #945 all-dimension quality receipt stays with #945.

**#1030 policy dead-code removal (2026-09-09):** the general effect-composition implementation and its 29 conformance tests are removed without replacement. Searches of updated `origin/main` (`47bc4299`) found no external production or test consumer of any of its 31 exports; the PR body records every command, result and census/prose/substring false positive. The retained engine evaluates compiled rows and permissions; it does not implement general deny/pending/allow composition, safe-deny effect ceilings, conflict merging, deduplication or retry-ceiling merging. Captured row budget limits and channel ceilings are unchanged. Protocol `Policy.EffectiveDecision` was deleted in G002 (#930), including its schema/type, parser/module-surface entries and snapshot. Shared `PolicyEffect` and `PolicyDecision` contracts still have separate consumers and are not deleted (the obligation contract followed in #1246).

**Source baseline:** #946 stage 2 includes main `678d357e` (#993/#949 stage 1), #991 codemode, #988's protocol contract and #990's desktop gateway selection. Historical #948 receipts below retain their `c4fb7748` source pin. [SLOP](SLOP.md) records deletion ownership; the PR body records the final gate commands and exit codes. Closed issue labels are not implementation evidence.

**W1 (#1108) durable reconstruction (merged `851a71fc`, 2026-09-24):** checkpoint folding commits `fold.checkpoint` at the 256-action threshold and at compaction/restoration boundaries (`packages/ledger/src/storage/l0-action-builders.ts`, `packages/agent/src/session-lifecycle/history.ts` — since #1247 `packages/agent/src/inspect/history.ts`). Bounded hydration validates the checkpoint seed before a capped range load; corrupt seeds refuse with `FoldCheckpointIntegrityError` — zero full-tree fallback, zero runner entry (`packages/ledger/src/session/kernel.ts`). The whole-tree kernel `tree` export is removed; production `.tree(` consumers grep to zero across agent/oni/ledger src, and the fold oracle remains test-only (now `packages/agent/test/store/helpers/session-tree.ts`, #1246). `authorizeConfigure` is a required pinned pre-policy authority on the session runtime (`packages/agent/src/session-contract.ts:129`); the optional-callback `?? Effect.succeed(true)` fail-open in `packages/agent/src/session-configuration.ts` is deleted (grep zero). Retry scheduling persists the unchanged `retry.scheduled` alarm payload (kind/attempt/reason/notBefore — `packages/protocol/src/ledger/l0.ts` `Alarm.RetrySchedule`) before any wait; restart sleeps only the residual `notBefore - now` with the recorded row byte-identical and no new jitter drawn (`packages/agent/src/executor-retry-alarm.ts`, deleted by W5.2 #1197; retry alarms live in `packages/agent/src/session/alarm.ts` since #1247). NOT in W1: durable alarm-level deadline/route/jitter/provenance/remainingBudget fields (protocol change required) and a durable route cooldown store (no owner exists); residual/jitter/provenance are proven only at the derived level (`notBefore` embeds the drawn jitter; provenance/budget live in attempt-intent metadata). Crash-matrix v2 reconstruction rows (`script/conformance/crash-matrix.json`): `fold_checkpoint_committed_before_wake`, `context_restore_checkpoint_committed_before_publish` and `same_id_result_after_checkpoint_before_wake` → `resumed_without_reexecution`; `fold_checkpoint_tampered_before_load` and `captured_generation_missing_after_restart` → `rejected` (typed refusal, no fallback or generation substitution); `open_tool_checkpoint_before_terminal` → `lost` (identity preserved, `outcome_unknown`, no re-entry); `recovery_dispatch_identity_committed_before_rpc` → `resumed_without_reexecution` (not the `rearmed` target: no separately durable recovery-dispatch identity).

**W2 (#1110) one message plane (merged `d5b48a1b`, PR #1190, 2026-09-25):** the Resident no longer replies on its own initiative. The post-turn block that dispatched `send_message` to the last external-origin actor is deleted from `apps/oni/src/bundles/resident/index.ts` (grep zero for `send_message` in that file); external replies happen only through an explicit `send_message` tool call, and a child's terminal still reaches the parent inbox as the kernel obligation. One alarm writer: the request-deadline `INSERT` in `sqlite-l0-write.ts` is gone; `requestDeadline` (`packages/ledger/src/storage/l0-action-builders.ts:24`) builds the row and the transaction-local `insertAlarm` (`packages/ledger/src/storage/sqlite-l0-write.ts:122`) is the single `INSERT INTO alarm` site, called by explicit `armAlarm` (`sqlite-l0-alarms.ts:87`) and by request/reply state projection in the same commit. The app alarm worker mints no occurrence ids and renders no timeout verdict; a watch timeout is delivered as a clock observation (`timer:<fireAt + timeout_ms>`) and the ledger alone decides expiry (`apps/oni/src/composition/alarm-worker.ts`). Channel provisioning is declared-only: `channelsFromEnv`, `config.channels` and the `source: "env"` selection are deleted; `loadConfig`/`doctor` refuse nonblank legacy tokens with `ConfigurationError` `legacy_channel_credentials` naming `provision`/`channel_add` (`apps/oni/src/config.ts:253`); the supervisor reports `source(): "declared"` only (`apps/oni/src/bundles/provision/supervisor.ts:76`). Physical delivery reports facts: adapters return `sent | not_sent | unknown` (`packages/channels/src/support/deliver.ts:8`), `DeliveryReconciliation` holds custody per idempotency key and releases it only on a proven `not_sent` (connection never established, typed `DeliveryNotSent`, or platform rejection); the kernel `accepted | rejected | unknown` receipt is a translation at that one boundary (`kernelDeliveryReceipt`), and the expiring outbound `DedupeWindow` is deleted. GitHub reports unopened webhooks as a typed `unsupported_event` refusal observation (`packages/channels/src/provider/github/surface.ts:23-35`) while keeping HTTP 200; PR events are still not ingested. Matcher bearer/identity-less branches and the resolver's `legacyActorFields` copier are deleted (SLOP H14). Agent ports: outbound recovery reconciles against the receiver's durable receipt before any redispatch (`packages/agent/src/session-outbound.ts:112`) and `SessionRequestPort.cancel` shares the original-action CAS (`packages/agent/src/session-requests.ts:127`). The IPC client drops frames once disconnected or closed (`packages/ipc/src/client.ts`). Crash-matrix rows (`script/conformance/crash-matrix.json`): `platform_send_committed_before_local_ack_reconciled_sent` → `resumed_without_reexecution`; new `alarm_fire_committed_before_hibernated_doorbell` → `rearmed`; `platform_attempt_marker_before_send_reconciled_not_sent` and `outbound_flood_deadline_before_timer_rearm` stay `rearmed` and `platform_send_ambiguous_without_reconciliation` stays `replayed` because the ledger outbound projection admits only `pending | delivered` (no durable attempt, `outcome_unknown` or `notBefore` state); that protocol change is NOT in W2.

## #947 stage-1 branch receipt (2026-09-06)

The stage-1 branch extends the existing alarm owner with fenced evaluation,
atomic fired/prompt delivery, persistent PTY and path sources, durable dedupe,
policy-budget pause/rearm, and boot discovery. The additive `monitor` tool uses
`op:create|rearm|cancel`. The app band outlives session hibernation; its committed
inbox doorbell re-enters the existing session controller, not a second loop.
The focused 30-test run passes, including a real PTY, SQLite reopen and a
one-model-call waiting terminal followed by a hibernated-session wake.

The Owner-approved input now nests an op-discriminated `operation`, with create
payload under `source` and required `alarmId` on controls. `lint:tools` passes
without an exemption or lowered floor. Path sources reconcile stat identity in
the same app scan as native notifications: unchanged observations write zero,
and a missed native event no longer strands a durable create. The path test
subscribes before mutation and drives reconciliation without yielding to the
native callback, proving atomic delivery independently of callback timing.
Evaluator entry captures the app async context, preventing tool-wave abort
inheritance. A real WebSocket/PTY/FIFO regression verifies that a tool-created
source wakes a hibernated app session after its original tool wave has ended.

Rebased production checkpoint `6a912340` passes the complete gate chain:
3377 tests across 359 files, zero failures, and all 11 coverage lanes plus the
unchanged coverage ratchet. The real app WebSocket/path exercise reaches a
hibernated-session wake at revision 59 with two model calls. Removing the app
async-context binding makes the PTY/FIFO regression fail with AbortError.

[Decisions and operational limits](alarm-monitor-stage-1.md) include the
at-most-once restart gap. Stage 2 after #946 still owes only the
message-deadline consumer -> `at` alarm migration, its answer/deadline CAS and
restart tests, and B4 deletion proof. #969-#972 receipts are consumed by their
own sections below; #973's executable evidence is in the conformance section.

### PR #994 R1 correction receipt

The R1 implementation merges main `678d357e` (#993): all six fs/bash tools,
monitor and existing tools remain in the catalog; placement stays deleted.
Callback deadline precedence now applies before ordinary match/exit admission.
Command cleanup kills its process group, including HUP-ignoring grandchildren,
and stale cleanup is fenced from a rearmed source. Migration validates the
complete shared WatchSpec before committing 0035. Synchronous inbox/action
assertions kill the path-reconciliation mutant before native callbacks can run.
A compiler-backed boundary test reports zero inferred unsafe values and rejects
its deliberately planted JSON/catch mutant; runtime payloads are schema-checked.
The earlier 3377-test receipt above remains historical, not a claim that R1
was already addressed at that checkpoint.

Production checkpoint `21675e12` passes the merged full suite: 3435 tests,
zero failures, 11167 assertions across 365 files. All ten current coverage lanes
and the unchanged ratchet pass (app 97.08%, ledger 99.34%). The full build/type/
dependency/cycle/lint/export chain, including tool-lint self-test, exits 0.
The reviewer's added-line compiler probe emits no unsafe values. The real-app
WebSocket/path wake still commits one fired pair and reaches revision 59.

## Deployed shape

| Component | Current wiring | Source |
| --- | --- | --- |
| Kernel app | Boot/shutdown, Resident, channels, gateway, provisioning, machines, messaging, cells, and compaction. No built-in curated memory or replacement port. | `apps/oni/src/index.ts` |
| Desktop console | Electron shell and app-owned AI SDK chat state; the renderer selects the configured gateway or the explicit preview transport. Gateway admission receipts and later message frames are distinct. Presentation is shared with the UI showcase. | `apps/desktop/`, `packages/ui/` |
| Channel drivers | Discord, GitHub, Slack, Telegram providers and a separate WebSocket bootstrap surface. Providers own credential/settings validation and outbound rendering; the app composes them. The three bot transports are the agent-messenger SDK (#1569 PRs 1–3): Slack Socket Mode (`SlackBotListener` + `SlackBotClient` pinned to one physical attempt per idempotency key), the Discord gateway (`DiscordBotListener`) and the Telegram long poll (`TelegramBotListener`), each under `support/sdk-listener.ts` custody; Discord and Telegram REST stays on the package's own clients over `fetch-retry`. No hand-rolled gateway, poller, reconnect schedule or socket shell remains. | `packages/channels/src/provider/`, `packages/channels/src/provider/{slack,discord,telegram}/sdk.ts`, `packages/channels/src/support/sdk-listener.ts`, `packages/channels/src/websocket.ts`, `apps/oni/src/channels.ts` |
| Perimeter gateway | Blacklist, physical request correlation, channel ceiling, actor identity, surface sessions, durable route decisions, and grant/egress/idempotency-controlled sends survive. Removed dialogue stores confer no routing rights. WebSocket credentials use the canonical auth subprotocol; query-only authentication is rejected (#974). | `packages/channels/src/router/`, `packages/channels/src/authn/websocket.ts`, `apps/oni/src/gateway.ts` |
| Provisioning | Durable persons, channel instances, and encrypted secrets; declared instances are the only channel provisioning owner, and nonblank legacy channel env credentials are refused at config load with `legacy_channel_credentials` (W2 #1110). The vault key and channel supervisor are composed at boot. The one-shot environment import command is deleted. | `packages/channels/src/store/provisioning/`, `apps/oni/src/bundles/provision/` |
| Runtime administration | The `provision` op union uses the live supervisor for channel/secret changes and status. Person mutations suspend their original invocation for authenticated approval when `approvalRequirement` demands one (editing the existing owner Person, or raising a tier above collaborator); other declarations and non-sole-owner `person_remove` apply directly. `contact_promote` and `contact_merge` suspend under the `require_approval` policy row until the Owner's answer re-admits the original invocation; the separate `approval` tool was deleted in `239b4273` (2026-09-08). | `apps/oni/src/tools/provision.ts`, `apps/oni/src/provisioning/supervisor.ts` |
| Resident and native workers | Shared durable session handles and one app runner. A turn opened by an approved person on a channel surface (external origin with an `actorId`, not `ws`) answers that person through the reply door (#1569 PR 4): the result text enters the gateway as an origin-targeted send naming the delivered prompt, the app folds the conversation from that prompt's recorded origin (the surface they wrote on, #1485; the channel or thread they wrote in, a DM directly, #1490) and the router admits it on the surface-key binding the inbound claimed — no grant, budget or tool row. A `send_message` letter to that same conversation is refused in the tool wave as `same_conversation`; every other external letter, and every session-to-session message, is an explicit `send_message` call (W2 #1110 removed the unconditional post-turn reply; the owner-only report returned with #1482 as a synthesized tool dispatch, replaced by the door). Native and real process child-to-parent delivery pass targeted tests; the old app delegation subtree and tools are removed. | `apps/oni/src/bundles/resident/index.ts`, `apps/oni/src/process-entry.ts`, `apps/oni/src/composition/process-session.ts` |
| Session durability | Fenced single-flight execution, durable inbox/alarms, parent-linked rows, action history, generation snapshots, boot recovery, idle release, authoritative reads, revision-gap observation, bounded revision history pages (`history()`) and redacted causal inspection (`inspect()`) derived from committed actions (#972). Legacy public CRUD/message/TTL ownership is removed, not aliased. | `packages/agent/src/core/store/fence.ts`, `packages/agent/src/core/session/run.ts`, `packages/agent/src/inspect/index.ts`, `packages/agent/src/core/store/session-file/index.ts`, `packages/agent/src/core/store/storage/` |
| Action executor and policy | Session-pinned compiled policy rows govern prompt/turn/model/tool/message pre/post decisions; message post is obligation-only. The executor owns model/tool intents and linked terminals; prompt/turn records remain session-owned. Old policy callback registries are deleted (#965); configure-authority and approval-binding seams remain tracked by B6/H6. Unconsumed general effect composition is deleted without replacement (#1030). | `packages/agent/src/core/loop/executor.ts`, `packages/agent/src/core/gate/compile.ts`, `apps/oni/src/bundles/core-policy/index.ts` |
| LLM | Canonical model/auth resolution, provider classification, retry-after/backoff, and corrected additive token accounting. The processor performs one attempt; session execution owns retry and re-admission. The unused public fact tap is removed (#976); ephemeral transcript folding and message/tool callbacks remain. | `packages/agent/src/model/`, `packages/agent/src/core/loop/executor.ts` |
| Compaction | App-configured summarization and agent-owned speculative/synchronous compaction, with durable projection/range/hash/revert evidence and reconstruction from canonical actions. The summarizer is wired, not dormant. | `apps/oni/src/bundles/compaction/`, `packages/agent/src/plugins/compaction/`, `packages/agent/src/inspect/history.ts` |
| Observation | Scoped agent bus/component observations are projections, not durable authority. Ledger facts commit before observation. The old telemetry package and bus-persistence writer are absent. | `packages/agent/src/core/observation/bus.ts`, `apps/oni/src/observation/` |
| Machine body and raw endpoints | Stable list/get handles expose confined fs read/write/list/stat, exec and code cells over IPC. The host owns attachment, enrollment admission, generation CAS, capacity and transport; Rust `mclient` is the only peer and owns the confined drivers. Effective capabilities are the enrollment/offer intersection, with export checks at the client and captured kernel `tool.pre` at the app. Unix and pinned mutual-TLS TCP join one host registry. Dropped calls fail once as `disconnected`; reconnects retain machine identity and present the host-minted generation. Self boots a spawned `mclient` over Unix and must attach before tool ports publish. | `packages/machines/src/host.ts`, `packages/machines/src/ipc/`, `clients/machine-client/src/`, `apps/oni/src/composition/self-machine.ts` |
| Code mode | `packages/codemode` supplies machine handles and routes `cell.run/peek/stop` to `machine.run_code/peek_code/cancel_code` on the attached client. The Rust client owns the per-tenant Python processes and the prelude in `clients/machine-client/src/code/driver.py`; cancellation and detach clean up processes. The app `eval` tool waits for a bounded result or returns a running cell id, and the cell-only completion helper uses the captured host tool executor. | `packages/codemode/src/`, `clients/machine-client/src/code/`, `apps/oni/src/bundles/tools/eval/index.ts` |
| Tool catalog and prompts | The catalog is sealed (#949): eleven model-door tools `read`, `write`, `edit`, `ls`, `find`, `grep`, `bash`, `eval`, `monitor`, `send_message`, `provision` plus the cell-only `completion`; snake_case names, one `op` discriminator under `operation` for eval/monitor/provision, flat `tools/<name>.ts` (`_` written `-` in file names; `lint:tools` `[tool-file-name]` pins the correspondence). There is no `approval` tool: `provision.contact_promote`/`contact_merge` carry `require_approval` policy rows resolved through the kernel request path. `lint:tools` and the catalog test pin the exact set and refuse retired names. The prompt builder accepts model tuning only; deleted-domain injection/instructions are absent. Dispatcher-only model truncation caps at 32,000 UTF-16 code units on a Unicode code-point boundary, with exact dropped/original UTF-8 byte counts; cell values stay full. | `apps/oni/src/bundles/tools/core/catalog.ts`, `apps/oni/src/bundles/prompt/`, `packages/agent/src/core/loop/tool.ts` |
| CLI and composition | Start/onboard/Resident daemon/doctor/logs and npm staging belong to the app. The portable npm package bundles the TypeScript app and native addons but not the platform-specific Rust `mclient`: an operator installs it beside `dist/app/` or sets `ONI_MCLIENT_BIN`. Self attaches as a spawned child; remote machines use `mclient join` and `mclient run --config <settings.json>`. Reversible composition owns boot rollback and reverse-order shutdown. | `apps/oni/src/cli/`, `apps/oni/script/build-npm-package.ts`, `apps/oni/src/composition/mclient.ts` |

#949 stage 1 removes the target-selection workspace and capability-based catalog fold; call-time admission belongs to executor `tool.pre`. Model fallback selection belongs to `packages/llm`. Together with #991's codemode workspace, the generated topology describes twelve workspaces. The standalone waiting/approval folds and stores are removed by #969. #949 stage 2 seals the catalog, folds approval into `provision`, and drops the catalog's conditional Proxy port scaffolding: every tool is constructed statically and refuses at execution when its port is absent. #949 stage 3 adds `eval` `peek`/`stop` over a background cell registry with streamed partial output, `completion` options `{model, system, schema}`, and renames the codemode handle methods to the tool names.

## G002 ledger authority cut (#930)

On `kernel/s1-authority-cut-2` (2026-09-18), session `action` is the single ordered action history. Each append stores its payload columns and session ordinal; replay compares the serialized row bytes.

The separate `ledger-core` event/head store is deleted. `decision_fact` holds first-writer-wins keyed facts: record returns either the newly recorded fact or the existing fact, and routing/admission callers replay that stored result. Migration 0040 preserves recognized historical stream heads as decision facts and refuses unrecognized stream classes before dropping the retired live tables.

App monitor, boot runner selection, message decision identities, platform-message lookup and outbound receipt recovery use `actionById`, `latestGenerationFor`, `policyDecisionRuleIds`, `messageActionByPlatformId` and `outboundReceipt`. SQL selects exact keys/kinds; schema decoding and the existing configuration fold remain ledger-owned. App source no longer loads `tree()`; agent history/fold consumers retain it. No new policy judgment or writer is introduced.

## #946 messaging cutover

The app exposes one `send_message` tool and one two-argument gateway ingest. Driver facts carry no authority. A/B message rows, tier and actor-grant preflight, transactional root/child inbox writes, source-owned outbound obligations and idempotent receiving inbox mail, durable reply-grant recovery and actor receipt distinctions are wired. Native, process, WebSocket and code-mode integration tests exercise the actual composition roots.

#969 replaces the former message-specific answer/deadline writer with the canonical request transition and an alarm projection. The request retains the original action binding and deadline; answer, timeout, refusal, and cancellation compete for one terminal action. Source terminal commits an outbound obligation; receiving acknowledgement is idempotent, and `LedgerSession.Commit.receive` is restricted to the committing session. **#947 supplies the shared live alarm worker; request deadlines use its `at` rows and the canonical request transition.** The earlier #946 deadline and native-delivery receipts do not, by themselves, verify these replacement paths.

The legacy tool trio, separate worker-run stores/process ACK lifecycle, channel return-value writeback, trigger rules and GitHub normalizer are deleted. Migration 0035 refuses nonempty retired tables rather than discarding their data; 0036 adds the bounded durable reply-grant projection. Historical migrations remain immutable. The coverage baseline is unchanged.

## #969 request waiting and delivery

The protocol exports SessionTransition under the existing session/action vocabulary. Gateway requestId/requestSpec/requestContext identify the original action; channels retains physical chain precedence, pins, responder matching, grants, egress budgets, idempotency and accepted/rejected/unknown receipts, while injected kernel ports decide request transitions. Typed Owner answers use the same authenticated gateway ingest, with no credential written to history. The model-facing protected-mutation tool no longer exposes request/decide operations or an approval-id bypass. Protected domain preconditions are checked again inside the actual mutation transaction.

Migration 0038 extends action/policy kinds with request/reply/outbound. It retains terminal legacy rows indefinitely in immutable archive_969_wait and archive_969_approval tables before removing the live tables. The preflight refuses unresolved, malformed, incoherent, or still-follow-up-visible rows before mutation; it cannot reconstruct an original invocation from old records. Historical migrations are unchanged. Unresolved legacy message alarms and native child inputs/turns also refuse; no captured invocation is guessed. Native message/part retention and the explicitly confirmed #967 archive procedure remain separate. Scoped pragma statements are finalized before rebuilding tables, including on Bun 1.3.6.

The executable census is `bun run script/request-authority-census.ts`; its test is `script/conformance/request-authority-census.test.ts`. It scans production, fixtures, and public schema with git grep, including untracked local files. Only enumerated archival SQL operations are excepted; no test tree or API-bearing file is excluded. Reintroduced store/interface, SQL writer, serialized correlation, and untracked fixture mutants must be rejected. This is a lexical/AST deletion guard, not proof against dynamically assembled SQL or renamed replacement engines. Behavioral tests exercise real Owner WebSocket consent after SIGKILL and two restarts, exact-invocation at-most-once execution, domain and principal refusal, answer/timeout/cancel CAS, real Telegram correlation, native/process replies and receiving-consumer failure discrimination. A copied-tree mutant that drops receiving intake fails the real app end-to-end test.

The producer manifest no longer permits independent waiting/approval streams or the deleted commit coordinator. The dependency manifest permits agent only for channels tests; production channels imports remain protocol/policy/ledger. Reviewed snapshots contain SessionTransition and the restricted protected-mutation catalog. The PR records the #969 gate results and unchanged coverage floors. This does not close the broader #945/#948 campaign.

## #970 durable recovery and typed restoration

`packages/agent/src/executor-recovery.ts` (since #1247 `packages/agent/src/kernel/gate/decide.ts`) owns the recovery product. Every intent records its `recovery` classification (`local_transactional`, `endpoint_idempotent`, `read_back_reconcilable`, `ambiguous_no_replay`; kernel-local compaction/message intents default to local-transactional, everything else to ambiguous-no-replay). A post-body exception at `post_policy`, `reverter` or `result_commit` reads the original terminal slot first, settles `failed` from the body's known evidence and treats a thrown reverter as no proof of rollback; a refused recovery commit propagates and the intent stays recovery-pending. `DurableExecutor.recover()` settles crash-open intents: an ordinary open tool records one `outcome_unknown` with no body, a lost provider attempt makes the logical llm outcome unknown rather than silently retrying, an llm whose attempts all settled fails from that evidence, and local projections fail from the ledger read-back. Request-bearing waves stay with the captured tool dispatcher, which now runs executor recovery before its captured waves and never runs a tool.

The provider retry owner is unchanged (`createAttemptRunner` in `packages/agent/src/executor-attempts.ts`, since #1247 `packages/agent/src/kernel/gate/decide.ts`); each attempt intent pins `attempt`, `maxAttempts` and `retryReason`, and the settled result carries the llm `AttemptEvidence` (usage, `visibleOutput`, finish reason, `Auth.reference` credential handle: type plus a 16-hex digest, never the key). Provider retry, crash-open resume and goal continuation remain distinct budgets with their own durable parents and IDs.

`restore_model_selection` (`packages/agent/src/model-selection.ts`, `packages/agent/src/core/execution/run.ts`; since #1247 `plugins/model-selection.ts` and `kernel/turn.ts`) runs at the turn boundary when the earlier turn's last chat attempt ended on a configured fallback: an executed action releases the primary, a refused one keeps the fallback pinned for the turn with the policy decision as the only record. `restore_context_projection` (`packages/agent/src/bundles/compaction/restore.ts` — since #1247 `plugins/compaction/restore.ts` — `SessionHandle.restoreContext`, `createSessionAdmission.restoreContextProjection`) rebuilds the projection from the compaction's own recipe under the held lease and appends it as a compensation with the compaction as parent; unknown or unexecuted compactions are refused before anything is recorded, and the original compaction facts are untouched. The contract's proposed relocation of admission/turn code into `session-lifecycle/*.ts` did not happen; the owners stayed in place until #1247 moved them into `session/` and `kernel/`. Tests: `packages/agent/test/executor-recovery.test.ts`, `core/model-restore.test.ts`, `model-selection.test.ts`, `session-context-restore.test.ts`, `session-chat-runner.test.ts`, `core/execution/llm-attempts.test.ts`, `packages/llm/test/run-outcome.test.ts`, `packages/llm/test/auth/storage.test.ts`.

## #971 monitor occurrences and evaluator recovery

The #947 alarm band is hardened against the transition contract without a second monitor, table or engine. `Alarm.Fire` (`packages/protocol/src/ledger/l0.ts`) carries the evaluator's transport `sourceKey`; the caller-minted `actionId`/`inboxId` and caller-supplied `limit` are gone. `alarmOccurrence` (`packages/ledger/src/storage/l0-action-builders.ts`) is the single admission judgment shared by the SQLite adapter and the in-memory test double: stale epoch/fence, pre-due time, consecutive equal poll batch, persisted `timeout_ms` deadline and persisted `notificationLimit` are decided there from the committed row. The occurrence action id is `Alarm.occurrenceId(alarmId, epoch, sourceKey)` and the prompt inbox id is derived alongside it, so redelivery of one committed occurrence appends nothing and leaves the session revision unchanged. Recurring matches stay armed; exit/timeout/one-shot complete; the N+1th match under a budget of N commits exactly one `alarm.paused` prompt and fences the evaluator; cancel and rearm fence before the band closes the source.

Recovery modes are unchanged in kind and now visible in identity: takeover (`acquire`) advances the fence and preserves epoch, notification count and dedupe digest, so a restarted idempotent poll that prints the same batch is suppressed and the next distinct batch delivers; explicit `rearm` advances the epoch and resets both. A non-persistent (timed) watch found running at band restart settles with a `restart` summary; live PTY output in the gap is never replayed; cursor-capable backends were not added. `createAlarmWorker` (`apps/oni/src/composition/alarm-worker.ts`) keeps only OS handles, the per-source line counter and the recovery flag; the path source hands its stat identity to the ledger as the occurrence key and keeps its snapshot only to classify create/modify.

Tests: `apps/oni/test/monitor-occurrence.test.ts` (distinct occurrences and zero-duplicate redelivery, takeover-vs-rearm dedupe, N+1 contenders, ledger-decided deadline, real PTY occurrence key), `packages/ledger/test/storage/alarm.test.ts` and `alarm-control.test.ts` (SQLite/memory parity, budget from the persisted spec), and the existing `alarm-boot-durability`, `alarm-worker-boundaries`, `monitor-budget`, `monitor-deadline`, `monitor-tool-boundaries`, `monitor-process-group` and `monitor-app` suites for evaluator restart, session hibernation and deterministic source shutdown. The contract's ALD/ALA/ALX relocation targets and `AlarmTransition` schema were not built; `session-lifecycle-contract.md` records the landed owners.

## #973 lifecycle conformance

`packages/agent/test/session-lifecycle-conformance.test.ts` is the section 6 HARNESS of the [lifecycle contract](session-lifecycle-contract.md). Each step of a trace runs against the real `SessionHandleStore`, session controller, `createExecutor.runBatch`, `createSessionRequests`, outbound dispatch and alarm rows, then snapshots the complete durable product of every traced session and checks: history only grows and keeps its prefix; every parent action precedes its child in the same session; at most one terminal per turn and per result slot; each inbox row is consumed at most once; exactly one `ledger.action.committed` observation per committed action. After the last step the file-backed SQLite image is reopened and the fold must equal the last prefix while dispatched bodies, tool observations and commits stay `[]`.

Measured against the landed #969-#972 tree: integrated wave revisions are 9/30/30/30/26 (ordinary, approved, refused, timeout, interrupt); the durable deadline fires once and a duplicate timer or late approve commits nothing; every losing contender on a closed request is recorded once per distinct input id as `duplicate`, `late_unknown` or `rejected` and never changes the winner (a seen reply id replayed by another principal is one `duplicate` in the pure authority, a record-free `rejected` at the store); a misrouted answer is refused before any record (destination revision, action count and `seenReplyIds` asserted unchanged; the request-id routing check is pinned in `session-request.test.ts`); the winning reply is delivered as pending inbox input keyed by its input id (inbox ids are store-wide); resume keeps the interrupted turn's messages and mints a new turn/result under the latest generation while crash-open recovery keeps the pinned turn, result and generation; a boot sweep resumes every open turn in the store; a child's reply survives a lost destination wake and a lost source ack with exactly one parent inbox row and one parent consumption; alarm takeover preserves epoch/count/digest and rearm resets them.

Not established here: the #945 receipt at final HEAD (any/unknown zero, clone zero, coverage 100%, complexity/Halstead/CRAP bounds, surviving mutants zero). The conformance file itself has no `any`, no `unknown`, and every unit below cyclomatic/cognitive 22 by the pinned analyzer; the campaign-wide receipt remains #945's.

## I09 deletion receipt synchronization

The A-row domain deletions below pass their exact production grep at the verified source. No production deletion is attributed to #948. [SLOP.md](SLOP.md) also records two archival-only semantic matches and three still-exported #944 G-CH9 callback types; those expanded acceptance gaps are not labeled zero. Exact identifiers and commands stay outside the active-contract grep surface.

| Rows | Disposition | Merged evidence |
| --- | --- | --- |
| A1, A2, A5 | Dormant transcript persistence, unused surface claim, and runtime integration client removed. The live ephemeral transcript fold survives. | #944 / PR #963, `b44cd76e` |
| A9 | Historical test-only export list was already zero; no invented deletion. The #948 source-pin empty-baseline Knip run reported twelve workspaces, zero issues. This is not proof of #945's stricter production-consumer census. | #944 / PR #963; current gate receipt in SLOP.md |
| A13 | Old task-ticket/completion domain, tools, schemas, and stores deleted. Later owner-schema correction consumed through #967. Generic provider-attempt history is unrelated and remains. | #940 / PR #960, `6c5d65d6`; PR #977, `eec7f7fc` |
| A14 | Built-in curated stores, mutation tool, config, and prompt injection removed without replacement. Local user files are not migrated by this docs update. | #941 / PR #958, `d35cdd39` |
| A15 | Blob store/schema/adapter/tools and spill removed; distinct model/cell output handling survives. | #942 / PR #959, `7edfe5d2` |
| A4, A16 | Dialogue-window, send-permission, and engagement domain stores/schemas/tools removed. Ordinary gateway send remains; #969 moves waiting to original-action request state. | #943 / PR #961, `23ad4f6b` |

Historical migrations remain immutable. The migration runner applies both 0030 deletion migrations, 0032's guarded dormant-table drops, 0033's session-handle lift, 0034's archive disposition, 0035's guarded retired-table deletion, 0036's reply-grant projection, and 0037's watch-alarm state. Source-level grep-zero does not mean that every historical identifier or every retained archival byte is gone.

## #937 and #967: merged corrections versus remaining retention

PR #985 (`c4fb7748`) completes session-loop convergence after #980: three inbox drains surround each model step/tool wave, then compaction and captured stop policy run. Approval covers the whole wave; positional results, sequential barriers, and live raw-effect lease retention remain. Visible text/tool output forbids provider replay. Missing/changed captured executable catalogs fail closed; crash-open recovery keeps captured IDs/generations, while terminal resume starts new ones. The #946 cutover replaces the earlier worker transport with session inbox messages.

The #967 corrections are merged: subprotocol-only authentication (#974), legacy session authority deletion (#975), unused fact-tap removal (#976), and native archive/retired-owner disposition (#977/#978). GitHub currently marks #967 closed. This document does not infer physical data deletion from that label: `message` and `part` remain in the source schema; #969 retains terminal waiting/approval records only in immutable archival tables; canonical history is written as actions.

The archive CLI creates a native SQLite image plus a v2 all-table receipt at explicit paths. Verification restores a temporary copy rather than opening the operator archive writable. `--dispose-967 --approve-manifest-sha256` revalidates the archive/receipt/source before guarded migration `0034_u967_archive_disposition`, in the migration transaction. Eligible retired Wait projections and archived bus rows are removed only with approval; the empty bus table is dropped. Ordinary boot does not archive implicitly. Message/part retention is not a DROP receipt and remains a final-convergence consideration for #945/#948, even though #937 is now merged.

## #1259 slop cleanup sub-PRs
Band b5 (`epic1260/1259-b5-oni`) cleans apps/oni composition, tools and delegation-cli items per the #1259 inventory: the dead `ONI_DB_PATH` test env var is deleted, the five boot-composition `console.error` incident sites publish `Operational.Events.Error` through the ObservationSink, `index-coverage.test.ts` is renamed `app-surface.test.ts`, `createMonitorTool` takes explicit `MonitorPorts | undefined`, find's `relativeTo` refuses a walk outside the search root, and eval's `signal` is the non-optional `AbortSignal`; items 118/133 defer to band 7's file ownership and eleven items keep with rationale — full per-item account in [SLOP.md](SLOP.md#l-1259-sub-prs).

Band b4 (`epic1260/1259-b4-channels`, commit `c1420c6e`) cleans packages/channels per the #1259 inventory: duplicated normalizer guards deleted from the telegram/discord surfaces, handler casts replaced by `requireHandler` binding, the floating telegram poll-loop promise annotated with `void`, the stale `DeliveringSurface` comment pruned, `verifyGitHubSignature` moved into `src/authn/` beside its only consumer, and a duplicate file-level `beforeEach` removed from the send suite — net LOC negative, zero behavior change; full per-item account in [SLOP.md](SLOP.md#l-1259-sub-prs).

Band b2 (`epic1260/1259-b2-agent-llm`) cleans packages/agent (core, session entity, compaction plugins, tests, model, store, gate) per the #1259 inventory: 17 items fixed (dead `runResult` options and `guardAborted`, one execution-authority refusal, a single `RetryReason` z.enum, deduped `requestSnapshot` reads, `Effect.retry`-native revision retry, zod-first `CompactionRecord`, zod row parsing in the surface-key adapter, the unreachable `writable()` gate, `evaluatedRuleCount`/`bucket` diagnostics, source-regex test ratchets, two stale comments, one rename, one flattened test loop), 23 kept with rationale, 11 deferred to bands 5/7, 11 re-verified as already resolved — net LOC negative, zero behavior change; full per-item account in [SLOP.md](SLOP.md#l-1259-sub-prs).

Band b7a (`epic1260/1259-b7a-xc`) sweeps the cross-cutting items outside `packages/agent`: knip.json stale ignore lists and eight redundant entry patterns deleted, `productionConsumerFindings` merged into `censusConsumerFindings`, the schema-only `runtime.workspace_lock` policy effect deleted, codemode's `decodeCodeFailure` rewritten as a plain instanceof dispatch, the provisioning `reconcile` pass-through inlined, cluster fixture clocks made deterministic, and stale H13 barrel claims corrected — 8 fixed, 18 already resolved upstream, 24 kept with rationale, net LOC negative; per-item account in [SLOP.md](SLOP.md#l-1259-sub-prs).

Band b7b (`epic1260/1259-b7b-agent-final`, the final #1259 sub-PR) cleans the packages/agent cross-cutting items and the four lead-owned apps/oni files: eight items fixed (single tool-result resolution and a collision-only tool-metadata assertion in `core/loop/tool.ts`, the `pendingBacklog` and `SessionActionCommitPort` wrappers deleted, a stop-evidence empty-page guard, one `node:crypto` sha256 API across the model fingerprints, a top-level `ai` import, provision `replaceAll`), eighteen re-verified as already resolved upstream, twenty-four kept with rationale, none deferred — net LOC negative, zero behavior change; full per-item account in [SLOP.md](SLOP.md#l-1259-sub-prs).

## Census and final quality: current versus required

**#1116 lean PR gate (2026-09-20):** the per-PR Quality ratchet stack (census
legs, exact statement evidence, coverage ratchets, metrics/clone legs, their
receipts and the `quality-baseline-lcov-bound`/`coverage-baseline` fragments)
is deleted. PR admission is build, types, lint (including cognitive-complexity
max 21), dependency rules, tests, and the diff-scoped patch-coverage gate
(`script/check-patch-coverage.ts`); deep audits run in the scheduled
`quality-mutation.yml` workflow only. The #945 absolute-distance receipt in
[SLOP](SLOP.md#945-absolute-census-receipt-2026-09-19-main-f5ea0e32) remains
the record of quality debt at its measurement HEAD; a green lean gate makes no
claim about it.

| Gate/row | Current evidence | Not established |
| --- | --- | --- |
| Export ratchet / A9 | `script/check-dead-exports.ts`, empty `script/conformance/knip-baseline.json`, package-entry export scan and synthetic Knip discrimination test are wired into CI. | Benchmark/test/barrel/adapter-only references are not yet comprehensively excluded as #945 requires. |
| Event pairing | `script/conformance/protocol-event-pairing.test.ts` checks declared start/terminal vocabulary. | This is not a declaration-to-production-publisher census. |
| Ledger producers | `script/ledger-producer-manifest.ts` and its drift test enumerate current append/SQL writers. | This is not an all-store production read/write consumer census. |
| E3 | No new fixture code or prose snapshots in this docs patch. | Reproducible separate production/test clone-zero receipts remain #945 work. |
| E4 | Required by the Owner-approved #945 amendment; **not parked**. | Explicit/implicit TypeScript any type0 and unknown type0, with no boundary exemption. |
| E5 | Script tests and the per-PR patch-coverage gate exist (#1116 deleted the script coverage ratchet lane). | Campaign-wide coverage100%, complexity and mutation guarantees, including the gates themselves. |
| E7 | Runtime prompt has no deleted injection or tool instruction; structural assembly assertions already exist. | `apps/oni/test/prompt.test.ts` still pins code-mode prose. E7 is not closed by a documentation-only PR; a negative signature/sentinel mutation gate is not claimed shipped. |

#945 remains open. Its acceptance also requires cyclomatic<22, cognitive<22, Halstead difficulty<80, CRAP<25, surviving mutants0, frozen analyzer versions/inventory/settings/coverage dimensions/operators, and full scheduled/final-convergence mutation execution. A passing ratchet or lint command does not establish any of those absent receipts. Local verification results, including pre-existing failures, are recorded in [SLOP.md](SLOP.md); no zero-failure campaign receipt is claimed.

## Parked and otherwise unimplemented

- [#950](https://github.com/INONONO66/oni/issues/950) remains `icebox`, outside #930, superseding closed [#811](https://github.com/INONONO66/oni/issues/811). It owns machine-offer isolation capability/fail-closed execution and the gateway egress secret gate. Kernel trust-boundary placement does not decide sandbox profiles or scanner semantics. Re-triage follows #938/#939 and #946; all three are open at verification. No sandbox/scanner implementation is included here.
- #949 stays open after stage 3, which landed `eval.op = run | peek | stop` over a background cell registry, `completion` options, and tool-named codemode handle methods for the five operations the machine wire carries (`read/write/ls/bash/eval`). Not landed: the `edit`, `find` and `grep` handle methods from the Owner amendment. Those tools are compositions the app tool layer builds over `read/write/list/stat` (`apps/oni/src/bundles/tools/{edit,find,grep}.ts` on `core/filesystem.ts`); the codemode plane (`packages/codemode/`, #1246 fold reversed by #1272) sits below that layer and the wire has no such op, so offering them in the cell without duplicating the tools means hoisting that composition into a package both can import. Until then the handle set is the five above and a cell reaches the other three through `tool.edit/find/grep()` proxies. Continuous alarm scheduling stays #947; #969 acceptance uses the behavioral and deletion receipts above, not only its census; machine handles and codemode are described above.
- Connector definitions and installation schemas are not an installed connector execution host. The dormant installation store is deleted.
- Governor/Jester/Voice, Stakes and effective-authority target consumers, dynamic reactive composition, and any later memory/search redesign are not promoted to shipped by retained design prose.

## #1259 slop cleanup ladder
Band b3 (machines + codemode) landed on `epic1260/1259-b3-machines-codemode`: the `RootWalk` alias is deleted, the duplicated `peek`/`stop` open-check is folded into `tenantCell`, and the unexported `Options` interface is renamed `CodemodeOptions`; the zod boundary parses in `exec.ts`/`failure.ts` stay (written-types gate: the untyped thrown value is owned by the parse), item 108 is deferred to PR #1293's ownership, and item 109 was already resolved on main.

Band b6 (`epic1260/1259-b6-ui-script-gates`) fixed item 171 (the quality-native-process excerpt-size comment now matches `ERROR_LIMIT`, 20 kB), and kept the remaining 15 ui and script-gates items with one-line rationales in the §L table of [SLOP.md](SLOP.md); the mechanical triage had labelled items 167/173/174/179 as resolved by #1241/#1037/#1015/#989, and review r1 disproved each against origin/main `79649f3c` (the symbols and concerns still exist), so the row records them as keeps with the inventory's own rationales.

## #1356 agent residue baseline

#1343 landed the shrink-only comment-residue gate (`script/check-comment-residue.ts`): every `packages/agent/src` file carries tight pins for issue-number comment lines and `// ───` dividers (491/52 at `d9800ad74`, plus one exact structural-header exemption in `inspect/index.ts`, allow-list budget <=10 enforced by the gate), comment lines classified from TypeScript comment-trivia ranges; the package comment ratio (1425bp = 3485/24454) is a growth-only CEILING (adding plain code passes), while the over-six-line JSDoc count (126) is a tight pin — growth and slack both fail, so cleanup (#1344) lowers pins in the same PR. The issue's 97 JSDoc count is not reproducible under any line-span definition; the ceiling is the measured 126 under "spans > 6 physical lines". `check-deps.ts` additionally pins direct agent-core responsibility tokens referenced from `apps/oni/src` code (19 across five files: cluster-runtime 5, ingress-executor 2, message-session 1, index 6, process-entry 5), counted by AST walk — code references only, never comments, strings, template text, regex literals or JSX text; token-pin slack is judged inside a git checkout only (worktree `.git` files included) and the skip outside one is a single loud NOTICE. No residue was removed and no production code changed; the Dependency Rules CI job runs both gates.
