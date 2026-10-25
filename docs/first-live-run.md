# First live run — messaging

The runbook for the first time the Resident speaks to a real platform
(#1600 lane R4). Everything before this page was proven against fake SDK
listeners and clients; this page is the Owner's, run with real tokens, and
what it records becomes the first live evidence. Shipped state is in
`docs/implementation-status.md`; the contracts are in
`docs/conversation-and-message-io.md` and `docs/provisioning-and-providers.md`.

## 0. Before anything

- `oni onboard` writes `~/.oni/env` (model provider, id and API
  key; `ONI_WS_TOKEN` when the socket is reachable off loopback).
- `oni daemon install` (or `oni start` in a terminal), then
  `oni doctor`: every check `PASS`, `health` answering.
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
`oni channel history telegram:owner <chat-id> [--before <cursor>] [--limit <1..100>]`.
The default limit is 50. Use the page's `before` cursor for the next,
exclusive older page; an empty page ends the walk. This read needs the
authenticated Owner socket and does not ingest messages or download media.
History works regardless of the account's intake and outbound posture.
