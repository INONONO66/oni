# Machines and Delegation — the OS's Body and Workforce

Owner-directed target design (2026-08-23). This document supersedes the
package-layout portions of the archived clean-room blueprint (git history,
`docs/clean-room-blueprint.md`): the Owner ruling of 2026-08-23 replaces the
legacy brain and host with the sole-app target and includes machine placement.
Everything here is a target contract; [implementation-status.md](implementation-status.md)
alone says what is wired.

## 1. The two axes

OpenOmni is an agent OS. Its reach grows along two axes:

- **Axis A — body (machines).** Devices attach by running a daemon that dials
  home. What the OS may do on a device is `effective = enrollment ∩ offer`.
- **Axis B — workforce (delegation).** Work is commissioned through ONE
  address vocabulary covering internal loops and external actors uniformly.

The protocol contracts for both belong together because they meet in the tool catalog: a tool declares *where* it runs and *which capabilities* the executing side must hold.

## 2. Machine contracts (`protocol/src/machine/`)

- `Machine.Enrollment` — Owner-side admission record: the capability allowlist
  for one machine. Never empty (an enrolled machine with nothing allowed is a
  contradiction).
- `Machine.Offer` — daemon-side attach report: what the machine can do right
  now. May be empty; the daemon re-offers when modules come up.
- `Machine.effectiveCapabilities(enrollment, offer)` — pure clockless fold:
  intersection, sorted; mismatched machine ids refuse (`machine_mismatch`).
  Neither side can grant itself a capability the other never named.
- `Machine.CapabilityId` — dot-namespaced lowercase grammar (`fs.read`,
  `shell.exec`, `kernel.py`, `screen.read`, `input.write`, `pty.session`).
  Open vocabulary,
  owned grammar: enrollment writer, daemon offer, and tool `requires` all
  parse the same shape.
- Events: `machine.attached` (carries the effective set in force),
  `machine.detached`.

The daemon itself is the driver-band `packages/machines` package
({protocol, ipc} deps only, reverse-connection over the ipc transport);
enrollment storage is a ledger record; attach admission is kernel judgment.

### 2.1 Raw machine and code-mode consumers

`MachineHost.list()` returns attached enrollment fields, tags (empty when
omitted), the effective capability set, and os/arch from the daemon's platform
report. Detached machines are absent. `get(id)` returns a stable handle, even
before attachment; calling an unattached handle throws `MachineRefusalError`
with `machine_not_attached`. Handles follow reattachment by identity, not by
whichever connection was most recently used.

The handle exposes `fs.read/write/list/stat`, `exec(cmd,cwd)` and
`runCode(cell,signal?)`. Filesystem inputs are real absolute POSIX paths, never
a virtual root or URL. The longest matching offered root translates to the
existing export-relative `machine.fs_op` wire. Equal normalized roots refuse
`ambiguous_export`; the host does not select a broader root to evade a narrower
root's refusal. Offers carry named absolute roots; daemon configuration must
match those roots. Missing enrollment export grants fail closed.

There are exactly two authorization boundaries: the kernel executor's
`tool.pre` for app-originated effects, and the daemon's negotiated capability,
offer and export checks. Host path translation and same-connection cell
provenance are protocol mechanics, not additional policy checks. The app has
no VFS capability gate or cross-machine prohibition. Both consumer doors use
the same raw endpoint; the plain-tool locus door belongs to #949.

- `fs.read` gates read/list/stat. `fs.write` gates write. The daemon checks
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
- `shell.exec` grants machine shell authority. For each call, the daemon
  re-resolves the effective export root pathname and validates the requested
  cwd before spawning `/bin/sh` by pathname. Exec does not share the fs
  branch's pinned-root invariant: replacing the export-root pathname before a
  request changes the directory exec actually starts in (fs requests keep
  reading the root pinned at attach), and a symlink swap between validation
  and spawn is a bounded, accepted TOCTOU for now (follow-up #938 in
  `docs/SLOP.md`).
  This is path validation, not an OS shell sandbox: a shell running as the
  daemon OS user remains arbitrary within that user's normal OS authority
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
  the effective capability set like every other machine operation. The macOS
  adapter (`packages/machines/src/computer-use.ts`) shells out to
  `screencapture`/`sips`/`osascript`/`cliclick` through an injectable
  `CommandRunner` port (`packages/machines/src/commands.ts`, argv spawn, no
  shell, 256KiB output cap), so tests never touch the real screen.
- Attach-time probes decide the offer: `screen.read` requires a real tiny
  capture to succeed; `input.write` requires `cliclick` on PATH plus the
  Accessibility (System Events) grant. A capability whose probe fails is
  simply not offered. A mid-session failure re-probes and the capability
  stays withdrawn (typed refusals) while the probe keeps failing.
- `screen.read` returns `{captureId, png (base64, <= 4 MiB after bounded
  sips -Z downscaling — never truncation), accessibilityTree?}`. The tree is
  bounded JSON (<= 256 KiB) from a JXA System Events walk and is omitted, not
  failed, without the permission. Regions are display-relative points
  validated against measured display bounds (`sips` pixel dims over dpi);
  out-of-bounds refuses `invalid_region` before any command runs.
- `input.write` requires the `captureId` of the LATEST successful capture;
  anything else refuses `stale_capture` and executes nothing. Input execution
  is main-display only in v1: cliclick takes global (main-display-origin)
  coordinates, so a request anchored to a capture of any other display refuses
  `unsupported_action` with a message naming the display instead of silently
  mistargeting. Actions
  (max 32: click/type/key/move/scroll) map to one `cliclick` invocation;
  middle-click and scroll refuse `unsupported_action` on this adapter
  (cliclick 5.1 has neither), and coordinates outside the captured display
  refuse `invalid_region` — always before anything executes.
- There is no model-visible tool. Code mode is the only consumer:
  `m.screen(display=None, region=None)` and `m.input(actions,
  capture_id=None)` in Python cells (input defaults to the cell's last
  capture id; without one it raises `ToolError`), `screen/input` on SDK
  handles. `codemode.screen` is query-class at the app composition boundary;
  `codemode.input` is execution-class.

### 2.3 Network transport (#1270)

The host owns a listener SET feeding one attachment registry: the unix socket
(mode 0600) is always bound; a TCP listener appears only when the Owner
configures `OPENOMNI_MACHINES_TCP_HOST`/`PORT` plus the host TLS identity
(`OPENOMNI_MACHINES_TLS_CERT`/`KEY` — all four or none, else boot refuses
typed). Handles, events and codemode are transport-blind: a machine is the
same machine on either door, and if one bind fails startup fails with the
other listener released.

Trust is certificate- and key-pinned, not public PKI: the daemon JSON carries
the host's certificate PEM (`hostCertificate`) — the TLS chain must validate
against it and the presented key must carry its fingerprint — while the host
pins the daemon's key through the REQUIRED `Enrollment.publicKey` (sha256
over SPKI DER, 64 lowercase hex). On TCP, an
offered machineId whose presented key differs from the enrollment pin is
refused `peer_key_mismatch` before admission, and a pin-mismatched intruder
never displaces a valid attachment. Unix connections carry no peer key; the
enrollment pin is simply not consulted there. See `docs/key-generation.md`
for openssl one-liners, rotation, and addressing (Tailscale = tailnet IP in
`tcp.host`; LAN = interface address). Breaking (#1270): `Enrollment.publicKey`
is REQUIRED — existing `OPENOMNI_MACHINES_ENROLLED` values without it fail
closed at boot until each enrollment carries the daemon's key fingerprint.

Disconnection is a first-class state: while a known machine's transport is
down, its handle calls — including calls that were in flight when the
transport dropped — fail once with typed `MachineRefusalError`
`disconnected` (never replayed); a machine that never attached stays
`machine_not_attached`. A daemon configured with `reconnect` (the CLI enables it for tcp
attachments; a unix daemon exits with its same-box host) keeps its
drivers alive and redials with full-jitter exponential backoff (base 250ms,
cap 30s, injected scheduler/randomness in tests); a successful reattach
resets the backoff and the host's existing handles serve the replacement
connection. A REFUSED reattach is terminal: the refusal surfaces, nothing is
rescheduled, and the daemon closes (the CLI exits nonzero) until restart or
config change.

### 2.4 Self machine (#1271)

The brain host is an ordinary attached machine. `machines.self` enrolls the
application host itself: `{id?: "self", capabilities, exports[{name, path}]}`
via `OPENOMNI_MACHINES_SELF` (JSON), with `OPENOMNI_MACHINES_DEFAULT` naming
the machine a prefix-less path resolves to (default `self`). Self exports are
mandatory and absolute — the Owner names the host roots the in-process daemon
may expose; no host path outside them is readable, writable, listable,
stat-able, or usable as a shell cwd. Duplicate self/enrolled ids, a default
absent from effective enrollments, and empty or relative exports are typed
configuration refusals BEFORE the listener starts.

Boot order is fixed: validate the plane, start the listener set, start an
in-process daemon with the self exports/capabilities, dial the host's own
unix listener and complete `machine.attach`, and only then publish tool
ports. Every failure in that chain is the one typed startup refusal
`self_attach_failed { cause }`; there is no local execution fallback — ever.
`apps/openomni/src/bundles/tools/<tool>/index.ts` and `apps/openomni/src/bundles/provision/provision.ts` contain no `node:fs`, no `Bun.spawn`, and no
local locus: `parseLocus(input, { defaultMachine })` maps `/absolute/path`
to the configured default machine and preserves explicit
`machineId:/absolute/path`; relative paths refuse (no process cwd exists).
A self daemon that disconnects after boot keeps the tools published but
every call refuses with the typed `disconnected` reason; the lifecycle
surface is the typed `machine.detached` event plus a logged
`self_attach_failed` cause. `openomni machine
attach` is unchanged: a remote daemon attaches alongside `self` over the
same protocol and negotiates capabilities through the same
enrollment/offer intersection.

### 2.5 Persistent terminals (`pty.session` over tmux, #1273)

- Capability `pty.session` is offered only when `tmux` resolves on PATH at
  attach time (probe via the same `CommandRunner` port); enrollment ∩ offer
  stays authoritative, so an installed binary alone grants nothing. Wire
  methods: `machine.pty_open/pty_write/pty_read/pty_resize/pty_close/pty_list`
  with protocol-owned bounds (`PTY_READ_MAX_BYTES` 256 KiB,
  `PTY_WRITE_MAX_BYTES` 16 KiB, list 1000, cols/rows 1000, `waitMs` <= 30 s)
  and typed refusals `pty_not_found` / `pty_not_available` /
  `path_escapes_export`.
- The daemon runs ONE tmux control-mode client (`tmux -C`, module split
  `pty-control` / `pty-decode` / `pty-registry` / `pty.ts`); each `pty_open`
  is `new-session -d` with cwd confined by the SAME `openCwd` rule as exec
  (refused before any session exists, symlink escapes included). Same-name
  open reattaches, never creates a second session; each session's window is
  linked into the reserved control session `omo-pty-control` because
  `%output` only flows for the attached session's panes.
- The daemon shares the user's DEFAULT tmux server (the private `-L` socket
  is test-only): granting `pty.session` exposes every grammar-conforming
  session on that server — reattach-by-name reaches sessions the user created
  (cwd confinement applies at open, not reattach) and `pty_close` can kill
  them. This is the accepted #1273 design (restart rediscovery makes a prior
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
- The tmux server, not the daemon, owns session lifetime: a daemon restart
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
`cell.stop(cellId,tenant)` and `listMachines/getMachine/findMachine({tag})`.
Tag lookup requires exactly one match: zero or multiple matches are typed
errors, never arbitrary selection. Handle methods are the tool names —
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

Only a daemon's injected `createCodemode().runner` starts Python, lazily on
its first request. Codemode owns the interpreter map, per-tenant persistence,
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
Attachment loss closes the injected runner; `daemon.close()` and `closed`
await process cleanup. Facade close cancels and awaits its live requests.

`openomni machine attach <config.json>` is the minimal production composition
of the retained daemon wire. It prints its structured attach result, exits 1
on refusal, and awaits close on host loss or SIGINT/SIGTERM. It is distinct
from `openomni daemon`, which still manages the Resident service. Example:

```json
{
  "socketPath": "/tmp/openomni-machines.sock",
  "offer": {
    "machineId": "laptop",
    "offeredCapabilities": ["fs.read", "fs.write", "shell.exec", "kernel.py"],
    "exports": [{ "name": "work", "path": "/home/owner/work" }],
    "daemonVersion": "1",
    "platform": "linux-arm64",
    "offeredAt": 1
  }
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
  omitted, it defaults to `<cell cwd>/.openomni/browser-profile`. The session
  opens with that directory as cwd, so the existing `openCwd` export rule
  refuses `path_escapes_export` before Chromium starts. The profile persists
  across close and reconnect (`--user-data-dir`), pairing the documented
  requirement that `--remote-debugging-port` never runs on the default
  profile.
- Port selection: the launch probe-binds on the machine starting at the
  documented default 9222 and advances past occupied ports; the chosen port
  and the browser pid are printed as `[openomni-browser] cdp-port <port>` /
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
  failure output stays readable (`codemode.getMachine(id).pty(session)` or
  `tmux attach -t <session>` inspects it; the session name is
  `openomni-browser-<sha256(profile_dir)[:12]>`). `client.close()` ends
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
                 profile_dir="/home/owner/work/.openomni/browser-profile")
headed.close()                                  # ends Chromium + session, keeps profile
```

## 3. Session messaging contracts

The model and cell catalog exposes one `send_message({to, message, kind?, reply_to?, deadline_ms?})` tool. Targets are an existing session (`to.kind: session`), a new parent-linked session (`new_session`), or an existing contact (`contact`; the protocol keeps `actor` internally). `kind` is `prompt | interrupt | resume` and defaults to `prompt`; a committed prompt becomes a letter in the recipient inbox. The returned `{messageId, target}` is a handle, not a synchronous join.

Every request enters `gateway.ingest(sender, envelope)`. External drivers provide authenticated sender coordinates and raw `Gateway.IngressFacts`; session tools supply their executor-bound session identity. Compiled message pre-policy selects external table A or session table B. Worker actor sends and worker allocation are denied by the default rows. The gateway reads perimeter facts and uses the injected L1 inbox writer; it does not query session state.

L1 supplies source fences, target relationship/depth/fanout facts, and the child's initial configuration. Child configuration and first inbox commit are atomic. Native and process sessions use the same session runner. A process transports a session id and model configuration over shared durable storage; its output carries committed inbox doorbells, not acceptance or completion settlements.

Child terminal mail preserves final text, terminal kind and original reply binding. Its atomicity, source answer/deadline CAS and exactly-once identity belong to the session/action store. Deadline requests use durable alarm rows, never per-message application timers. The retained Wait fold still owns external reply correlation; it is not a second worker lifecycle.

A machine remains WHERE execution happens, not a messaging target. Actor delivery uses the existing grant, egress-budget, endpoint and idempotency kernel, returning `accepted | rejected | unknown` only for an executed actor effect. Session commits succeed or throw. Current verification and remaining integration gaps are listed in [Implementation Status](implementation-status.md).

## 4. Tool execution boundaries

The executor's `tool.pre` policy point owns call-time admission. There is no
separate target-selection package or capability-based catalog fold. Machine
operations additionally cross the daemon's negotiated capability/export boundary.
The model-fallback fold belongs to the agent model plane (`packages/agent/src/model/`). Tool `safe` derives only from
`category === "query"`.

## 5. Ownership boundaries

The historical rollout sequence is retained in git history. Messaging now uses session inboxes and the shared executor, including from code-mode cells. Native and process child sessions use the same terminal-to-parent contract. Actor sends retain the channel grant/egress/Wait correlation kernel.

#947 owns continuous live due-alarm dispatch and monitoring. #969 owns unification of the retained generic Wait and approval lifecycles. Neither introduces a second messaging or execution authority in this cutover.
