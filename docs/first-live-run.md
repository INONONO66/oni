# First live run — messaging

The runbook for the first time the Resident speaks to a real platform
(#1600 lane R4). Everything before this page was proven against fake SDK
listeners and clients; this page is the Owner's, run with real tokens, and
what it records becomes the first live evidence. Shipped state is in
`docs/implementation-status.md`; the contracts are in
`docs/conversation-and-message-io.md` and `docs/provisioning-and-providers.md`.

## Isolated CLI child acceptance

Build the client before boot or app tests:
`cargo build --release --manifest-path clients/Cargo.toml`. Use a temporary
`HOME`, a private `TMUX_TMPDIR`, a scratch project export, and explicit catalog,
sessions, generation-file and socket paths. `ONI_HOME` alone does not redirect
these paths; `loadConfig(home, env)` takes its home argument explicitly.
Do not restart an installed machine service for this check.

Declare each contact on the authenticated gateway socket:

```json
{"type":"channel_add","requestId":"declare-claude","id":"channel:cli:claude","provider":"cli","identity":"bot","settings":{"dialect":"claude-code","machine":"self","cwd":"/absolute/scratch/project"}}
```

The provision tool uses the same declaration under
`{"operation":{"op":"channel_add","args":{...}}}` and asks for Owner consent.
`oni channel add` does not accept `cli`; use the socket or provision surface.
Ask the Resident to call `send_message` with
`to: {kind: "contact", id: "cli:claude"}` and a one-file task.

For each dialect retain the returned `agent.session.open` id, `child_fact`
counts by phase, the `agent_permission` action and
`agent_permission.decided` fact, and the `cli_turn` pointer reply. Answer a
permission through `provision`'s `permission_allow` operation and its Owner
approval request, never by writing a decision row directly. Codex currently
uses its own terminal approval prompt, not this hook (#1811).

The 2026-11-02 MacBook run (#1778) reached real CLI processes but did not
complete a CLI child turn: Claude waited for its first prompt while `open`
waited for a transcript (#1807); Codex required login (#1809); the installed
`pi` executable used a different transcript root (#1810). Each refusal and
its missing rows are recorded on #1778. `omp` was absent and its dialect
was removed rather than treated as verified.

The 2026-11-03 run on the same Mac completed the claude-code cycle without
hands: `open` is answered by the SessionStart `mclient hook ready` file,
the letter submits on its own, the child's `Write` reaches the lead as the
`agent_permission` action, and the child's terminal turn returns the
`cli_turn` pointer. The permission itself expired: the lead's turn is parked
inside `send_message` for the whole child turn, so nothing can call
`permission_allow` before the 100 s deadline (#1828); expect
`refused (timeout)` and no written file until that lands.

## Session-owned capture receipt

For `machine("self").screen()`, enroll `screen.read`; `computer.use` alone
does not grant this legacy method. From a native child (`runner: "native"`),
run one `eval` cell:

```python
shot = machine("self").screen()
print({key: value for key, value in shot.items() if key != "png"})
print("PNG_BYTES", len(shot.get("png", b"")))
```

Read the `codemode.screen` result in that session's SQLite `action` table.
Its envelope names a digest; the image lives in `tool_outputs.bytes` under
`output_id = "sha256:" + digest` in the same session file. Retain the JSON
row's byte length and the blob length, not the screenshot in the issue.
Observe mclient stderr and heartbeat metrics for at least 15 seconds after
capture. The self client uses the same 512 MiB budget as the joined client.

The #1776 G002 C002 receipt on 2026-11-02 captured 3024 by 1964 pixels:
2065011 PNG bytes, a 444-byte effect JSON and a 751-byte serialized row.
The client remained alive beyond 15 seconds without a memory-budget exit.
Accessibility was unavailable; Screen Recording was granted.

## Screen stream stage-metrics probe

With the daemon running on the same host as the CLI and an attached machine
offering `computer.use`, run:

```bash
oni machine probe macbook 1 --reconnect-after-ms 1000
```

Replace `macbook` and `1` with the attached machine ID and its display ID.
The CLI reads `ONI_WS_TOKEN` from the effective `~/.oni/env` and connects
to the loopback gateway. It opens a WebRTC stream, receives encoded frames,
decodes them in a headless viewer, closes the handle, then reopens it after
the requested delay. Standard output is one JSON object:

```json
{
  "type": "stream_probe_report",
  "requestId": "request-id",
  "stages": {
    "captureToReceipt": { "frames": 20, "p50": 30, "p95": 40, "p99": 45, "reconnectFirstFreshFrameMs": 90, "dropped": 0 },
    "captureToDecoded": { "frames": 20, "p50": 35, "p95": 46, "p99": 52, "reconnectFirstFreshFrameMs": 95, "dropped": 0 },
    "captureToDisplay": null,
    "displayedBy": "none"
  },
  "reconnect": "measured",
  "reconnectFirstFreshFrameMs": 90
}
```

The numbers above illustrate the shape, not acceptance thresholds. Percentiles
and reconnect times are milliseconds; `dropped` counts missing sidecar sequence
numbers. An unavailable reopen reports `"reconnect":"unavailable"` and a
`null` reconnect time. This probe does not present frames, so it cannot measure
capture-to-display latency. Save the actual JSON with the MacBook acceptance
record in #1702.

## 0. Before anything

- `oni onboard` writes `~/.oni/env` (model provider, id and API
  key; `ONI_WS_TOKEN` when the socket is reachable off loopback).
- `oni daemon install` (or `oni start` in a terminal), then
  `oni doctor`: every check `PASS`, `health` answering.
- Build the platform's `mclient` beside `dist/app/` in the Oni install,
  or set `ONI_MCLIENT_BIN` to its executable path before starting the
  Resident service. The npm package embeds the release manifest, not the
  binary. On an enrolled machine, `mclient update` fetches the host-pinned
  archive, verifies its byte count and SHA-256, probes it, then switches
  `~/.oni/bin/current` and restarts the client service. Use
  `mclient update --from URL` or `--file PATH` to select a different manifest.
  Hosted release records require absolute archive URLs; relative archive
  paths are supported only for explicit `--file` or `--from` documents.
  On macOS the service runs the regular file `~/.oni/bin/mclient`, replaced
  atomically from the selected release, rather than the versioned target of
  `current`. Once the certificate secrets in #1724 are set, releases carry
  a stable signing requirement. The first change from an ad-hoc signature
  requires granting Screen Recording and Accessibility once more; subsequent
  pin updates should retain those grants. Until then the release job announces
  ad-hoc signing and grants may need to be renewed after each update.
  The host-self supervisor deployment and update recipe is tracked in #1699;
  live MacBook grant retention and PVE bootstrap are tracked in #1702.
- `mclient join <host> --mode <tailnet|domain>` names how this machine
  reaches the host, and the address scheme must agree with it (#1837).
  Tailnet mode: `tcp://host[:port]` or a bare `host[:port]` dials the raw
  TLS-TCP listener (port 7643 by default) through Tailscale, a bare name
  resolved through `tailscale status --json`. Domain mode:
  `wss://host[:port][/machine]` dials the host's WebSocket listener
  (`machines.listen.ws`, port 443 and path `/machine` by default) by its
  public DNS name, over the same client identity and host pin as TLS-TCP.
  The two modes are each explicit — there is no domain-then-tailnet
  fallback — and one host may keep both listeners open, but one machine
  holds exactly one mode: a network host without `--mode` is refused
  `mode_required`, a mode that does not dial the address it was given
  (`--mode domain` with a `tcp://` host, `--mode tailnet` with `wss://`,
  any mode with `--unix`) is refused `mode_mismatch` before any dial, and a
  saved `client.json` whose mode disagrees with its host is refused the same
  way when `run` loads it. The mode rides the attach offer, and
  `machine_list` reports it per machine. `unix:<path>` dials the host's
  unix listener and takes no mode.
- In tailnet mode the client gets Tailscale up itself before the dial: it
  looks for the `tailscale` CLI on `PATH` and in the platform's locations,
  installs it when absent (`brew install --cask tailscale` on macOS,
  Tailscale's `install.sh` on Linux), starts the daemon when it does not
  answer (`open -a Tailscale` / `sudo systemctl start tailscaled`), runs
  `tailscale up` when the node is logged out (an auth key from
  `ONI_MCLIENT_TAILSCALE_AUTH_KEY` or `--tailscale-auth-key` is presented
  and never recorded; without one `tailscale up` prints its login URL on
  the operator's terminal and the join waits for the login, bounded) and
  attaches only once `tailscale status` reports `Running`. Every step
  lands in the join receipt as `tailscale.steps` (`{step, via, ok}` —
  `locate`, `install`, `start`, `status`, `up` via `auth-key` or `login`;
  the receipt names commands and states, never a key), and a step the client
  cannot finish is one typed refusal naming what the Owner does by hand:
  `tailscale_absent` (no install recipe for this platform),
  `tailscale_install_failed`, `tailscale_down`, `tailscale_login_failed`,
  `tailscale_login_timeout` and `tailscale_not_ready`, each with the steps
  taken so far and a `nextStep`. Domain mode never touches Tailscale. With `HTTPS_PROXY` or
  `https_proxy` set (`http://proxy:3128`, `proxy:3128` or `proxy` for port
  80), the `wss://` dial opens an HTTP CONNECT tunnel through that proxy
  first; TLS and the host pin are verified end to end inside the tunnel.
  Only a plain `http://` proxy without credentials is supported (`https://`
  or `user:pass@` is refused typed before any dial) and `NO_PROXY` is not
  read. A plaintext `ws://` address is refused as `plaintext_ws_refused`
  before any dial.
- On a fresh machine, one command installs the client and joins (#1838):
  `curl -fsSL http://<host>:3000/machine/install | sh -s -- http://<host>:3000
  --mode <tailnet|domain> --host-pin <pin>` (or `oni machine bootstrap
  http://<host>:3000 --mode <tailnet|domain> --host-pin <pin>` where the
  Oni CLI is installed), with `--token <join token>` once #1833 issues
  tokens (the token reaches `mclient join` as `ONI_MCLIENT_JOIN_TOKEN` in
  its environment and is never written to `client.json`). Both take the
  mode and the host pin the Owner read from the host, and run the join as
  `mclient join <address> --mode <mode> --host-pin <pin> --yes` — the
  address is the origin's host name in tailnet mode and `wss://<name>` in
  domain mode; a missing or unknown mode or a missing pin is the usage
  refusal before anything is downloaded (#1837). The
  download is verified against the host's `/machine/release` answer and
  `mclient join` runs from a staging copy, so join's own install path is the
  only thing that writes `~/.oni/bin/mclient` (a rerun keeps a joined
  machine's pin; an older host release is `downgrade_refused` unless
  `--force`); a tampered archive stops with `checksum_mismatch`. Later, `mclient upgrade` (the same path as `mclient
  update`) refreshes the binary, and a machine whose contract no longer
  matches the host's is listed with `upgradeRequired` in `machine_list`.
- `mclient join` over a network carrier is interactive: once the host's
  key is verified it prints `host:` and `host pin:` on stderr and asks
  `trust this host? [y/N]`; only `y`/`yes` records the pin, and a declined
  or unanswered prompt (closed stdin) exits `host_untrusted` with nothing
  written. Scripts pass `--yes` to trust the verified pin without the
  prompt. The offer is bounded by consent: `--capability <name>`
  (repeatable) declares the capabilities the client may offer; without it
  the first join declares every supported one and a later re-join keeps the
  set the previous join saved. The host answers with `consent_required` when
  its enrollment allows more than the offer declares; `mclient status`
  prints each missing item as `consent required: capability <name> — mclient
  grant <name>` (exports: re-join with `--export`), and the host publishes
  the same delta as a `machine.consent_required` event. `mclient grant
  <capability>` records the consent and asks the running service to
  re-attach with the wider offer at once; nothing restarts. `mclient join
  --rekey` replaces the client identity key: the new key is staged beside the
  enrolled one and swapped in only after the host is verified and the join
  recorded, so a declined prompt or a failed join keeps the key the host
  knows. The rotated key attaches only once the Owner enrolls it again.
- Every network connection the service makes after the join opens with the
  signed `machine.handshake` (machine contract v6, #1832) before it attaches:
  the client proves its enrollment key and the host proves the pinned key
  inside the message, and every later frame is sealed under a per-attach
  session key, so a proxy or CDN in front of the host sees ciphertext only.
  Nothing changes in the commands; the attach receipt (`state.json`) records
  the `handshake` the admission followed. A `not_admitted`
  refusal at the handshake means the host has no enrollment for this machine
  under this key (enroll it, or re-join after a `--rekey`), and a service
  that is refused `unsupported_contract` needs `mclient update`.
- On macOS, `mclient join <host>` installs the LaunchAgent and opens Screen
  Recording settings. Grant the installed client binary access; the running
  service checks the grant every five seconds and restarts itself once it
  arrives. Check `machine_list` for the new process and a granted screen
  fact. If the grant flaps, three restarts in one hour are allowed; the
  service then stays up with the `restart_bound` screen blocker. A manual
  `launchctl kickstart` command remains in `mclient join --help`.
- The daemon's socket stays on loopback for every step below: a login and a
  channel declaration carry a credential across it in clear.
- Voice notes and video, when the model cannot read them: a voice note is
  transcribed and the text added to the prompt; a video becomes at most
  eight frames, cut by `ffmpeg` on the attached machine (absent: only a
  `[video <duration>, 0 frames]` line, and one warning). Speech-to-text
  uses the first provider row naming a `transcription` model: the
  `ONI_PROVIDERS_PATH` rows when one of them does, else the bundled OpenAI
  row (`gpt-4o-transcribe`). Its key comes only from the auth file
  (`ONI_AUTH_FILE`, default `~/.oni/auth.json`), never from
  `ONI_MODEL_API_KEY`. Both need `ONI_MACHINES_INBOX`. Media the model
  can read (and the frames) reach the model call as content, held in the
  daemon's memory between delivery and turn: a restart in between leaves
  only the `[attached …]` line, which still names the inbox file.

## Deploy a new release

`oni daemon install` writes a unit that runs `oni supervise`; re-run it once
over an older install so the supervisor owns the host. Then, for each
release:

- `oni deploy oni-<version>.tgz [--grace-ms <0..300000>]` — stages the
  tarball under `~/.oni/releases/`, drains the running host (default 60 s),
  snapshots the catalog and sessions, starts the new release on the same port
  and verifies it. It prints `{"ok":true,"instanceId":…}` and exits 0, or
  prints `{"ok":false,"class":…,"step":…}` and exits 1 after restoring and
  restarting the previous release.
- `oni deploy --reload` (or `systemctl --user reload oni`) re-deploys the
  newest staged release.
- `ONI_WS_TOKEN` must be set: the drain and status endpoints refuse a
  tokenless host, and the deploy then answers `drain_refused`.
- Copy the platform's `mclient` beside the new release's `dist/app/` before
  deploying, or keep `ONI_MCLIENT_BIN` in `~/.oni/env`.

## 1. Declare

One row per platform and identity. The credential is asked for at the
prompt and sealed into the vault by the daemon; nothing is written on the
CLI side.

- Your own account (Slack, Discord, Instagram, KakaoTalk):
  `oni login <platform> [--intake mentions_and_dms|all|none] [--outbound] [--auto-reply]`.
  Without `--outbound` the account only reads: a DM to you, or a mention of
  you, reaches the Resident as `receivedBy: owner`, and an answer only your
  account could carry is delivered to you as a draft. With `--outbound
  --auto-reply` the account answers those conversations itself and sends
  `as: owner` when you say so from an Owner-origin turn.
- Your Telegram account: set `ONI_TELEGRAM_API_ID` and
  `ONI_TELEGRAM_API_HASH` in the service user's `~/.oni/env`, or enter
  missing values at the private terminal. Run
  `oni login telegram [--id channel:telegram:owner] [--intake mentions_and_dms|all|none] [--outbound] [--auto-reply]`.
  The API hash, phone, code and password prompts do not echo. The account
  database and retained download cache live only under the service user's
  `~/.oni/telegram/owner/{db,files}`. Stop or disable an already mounted
  account before logging in again; the database has one owner at a time.
  An unreachable daemon cannot seal credentials: rerun login when it is
  reachable. Telegram login never prints the credential payload.
- A bot (Slack, Discord, Telegram, GitHub, a webhook target, an A2A peer) or
  Linear (a personal API key, so the Owner instance):
  `oni channel add <platform> [--tier manager] [--allow <id>,<id>] [--mention-only]`.
  The grant block is yours by the call: `--tier` is what every sender on the
  surface gets who is not a declared Person (the mount tier admits nobody
  the owner policy passes — a bot nobody may write to is the default),
  `--allow` the platform ids admitted alone — your own id among them, or
  check 1 below fails on that row — `--mention-only` the posture. An A2A
  peer takes no block: the one door admits every peer at its contact's tier.
- Who you are on a platform: a Slack, Discord, Instagram or KakaoTalk
  Owner instance binds your account to the Owner Person when it mounts. On
  a bot-only platform, and on Linear (the API key names no account), name
  your platform id on the Owner Person through chat (`contact_add` on
  `person:owner` with the endpoint) so writing to the bot from your account
  is owner-tier.
- Who the Resident may write to cold: `contact_add` with `reach: true`,
  under your consent. The Owner is always reachable, no budget asked.

## 2. Read the readiness report

`oni messaging` reads the catalog and says, per platform: the rows
and their postures, who reaches the Resident (READ), how the Resident
answers and writes (WRITE), whether you are known there (OWNER), and who
is reachable cold. Fix every line that names a missing tier, a missing
credential or an unknown Owner before going live; exit 0 means every
enabled row is sealed.

## 3. The live checks

Run them in this order on one platform, then the next. Watch
`oni logs` beside each step; every arrival and refusal is an
observation there.

1. **Inbound, as you.** From your account, DM the bot (bot platforms) or
   DM a friend's account that the Resident watches (Owner-only platforms).
   Expect: the Resident answers in the same chat. A refusal in the log
   names its policy row (`message.external.grant_tier` means the tier;
   declare it).
2. **Inbound, as a stranger.** From an account that is no declared
   Person, write to the bot. Expect: admitted at the declared tier, or
   refused with the tier row when none was declared; never silence.
3. **A mention.** In a channel the bot is in, mention it. Expect: an
   answer in the thread; under `--mention-only` an unaddressed message is
   not read.
4. **The draft arm.** On an Owner-only platform without `--auto-reply`,
   have someone DM your account. Expect: no reply there; a draft reaches
   you through the bot on another platform (or the socket) naming who,
   where and the words. Say "send it from my account" to answer as you.
5. **Outbound, cold.** Ask the Resident to write to a reachable Person on
   another platform. Expect: the letter lands; the tool result names the
   contact outcome (`delivered`, `not_sent` with the platform's word, or
   `unknown`).
6. **Approval.** Ask for something that takes your consent (a channel
   declaration with a tier through chat). Expect: a request you answer
   from the console; on a tokenless loopback boot the socket is the
   evidence, with a token configured the token is.
7. **A webhook.** `curl -X POST .../webhook/<slug>` unsigned expects 401;
   signed with the declared secret expects 200 (`OK` when admitted, `Not
   ingested` when the policy refused it). That 200 is the only answer a
   webhook target ever gets: the reply door does not write back to it, and
   the Resident reaches it only through `send_message` to `webhook:<id>`
   when the declaration carries a url. On GitHub a reply is an issue
   comment only when a token was sealed; keyless, the log says
   `github token missing`.

## 4. Record

Each check is one line in the lane's section of
`docs/implementation-status.md`: platform, the step, pass or the exact
refusal, the log line. A platform with every step passing is the first
one the shipped-state doc may call live; until then every claim there is
fake-tested only.

## Telegram account history

After the account is ready, configure `ONI_WS_TOKEN` and use
`oni channel history channel:telegram:owner <chat-id> [--before <cursor>] [--limit <1..100>]`.
Use the declared instance id if its slug is not `owner`.
The default limit is 50. Use the page's `before` cursor for the next,
exclusive older page; an empty page ends the walk. This read needs the
authenticated Owner socket and does not ingest messages or download media.
History works regardless of the account's intake and outbound posture.
