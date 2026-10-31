/**
 * The spool appender installed on the child's machine (#1511 remote-host
 * rule, #1512): the vendor runs `sh <script> <event>` with its payload JSON
 * on stdin, and the script appends exactly one line
 * `{seq, event, receivedAt, payload}` to the spool. The sequence is a
 * per-child counter file advanced under a `mkdir` lock that records its
 * holder's pid, so two concurrent hook processes never share a number and a
 * waiter breaks only a lock whose holder is gone; `receivedAt` is epoch
 * milliseconds. POSIX sh only — it has to run on whatever shell the machine
 * offers — and vendor-neutral: the event name is whatever argument the pack's
 * live config wired, the payload is appended verbatim.
 *
 * Single-user assumption (r2 L12): the child, every hook process it spawns
 * and the lock holder they contend with run as the one user the pane runs
 * as — the machine client's — so `kill -0 <holder>` answers honestly. A
 * holder owned by another uid would fail that probe with EPERM and read as
 * gone; its lock would be broken past the bound. No vendor runs its hooks
 * as a different user, so the probe is not told the two apart.
 */
const LOCK_TRIES_BEFORE_BREAK = 500;

function singleQuoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** `lockTriesBeforeBreak` is the wait (in 20 ms tries) before a lock's holder is checked; tests shorten it. */
export function hookScript(spoolPath: string, lockTriesBeforeBreak: number = LOCK_TRIES_BEFORE_BREAK): string {
  return [
    "#!/bin/sh",
    "# oni hook spool appender (#1512): one line per vendor event, monotonic seq, mkdir lock held by pid.",
    "set -u",
    // The vendor passes exactly one argument; `$*` reads it without tripping `set -u` when none came.
    'event="$*"',
    `spool=${singleQuoted(spoolPath)}`,
    'counter="$spool.seq"',
    'lock="$spool.lock"',
    "case \"$event\" in ''|*[!A-Za-z0-9_]*) exit 0 ;; esac",
    // A vendor that closed stdin must not hang the hook (r1 L2): with fd 0 closed the command substitution's own
    // pipe would land on it and `cat` would read its own output forever, so a closed fd 0 is reopened on /dev/null
    // first. Duplicating fd 0 onto a spare descriptor is the one probe every POSIX shell reports honestly.
    "if ! { true 3<&0; } 2>/dev/null; then exec </dev/null; fi",
    // JSON strings never carry raw CR/LF, so stripping them only removes inter-token whitespace.
    "payload=$(cat | tr -d '\\r\\n')",
    "[ -n \"$payload\" ] || payload='{}'",
    "now_ms() {",
    "  ms=$(date +%s%3N 2>/dev/null)",
    "  case \"$ms\" in *N*|'') ms=$(perl -MTime::HiRes -e 'printf \"%d\", Time::HiRes::time()*1000' 2>/dev/null) ;; esac",
    "  case \"$ms\" in ''|*[!0-9]*) ms=\"$(date +%s)000\" ;; esac",
    "  printf '%s' \"$ms\"",
    "}",
    "tries=0",
    'until mkdir "$lock" 2>/dev/null; do',
    "  tries=$((tries + 1))",
    // Past the bound only a lock whose holder is gone is broken (r1 L3): a live holder keeps it however long its
    // append takes; a holder that died before recording itself, or after, has left a lock nobody will release.
    `  if [ "$tries" -gt ${lockTriesBeforeBreak} ]; then`,
    '    holder=$(cat "$lock/pid" 2>/dev/null)',
    "    case \"$holder\" in ''|*[!0-9]*) holder= ;; esac",
    '    if [ -z "$holder" ] || ! kill -0 "$holder" 2>/dev/null; then rm -f "$lock/pid"; rmdir "$lock" 2>/dev/null; fi',
    "    tries=0",
    "  fi",
    "  sleep 0.02 2>/dev/null || sleep 1",
    "done",
    "trap 'rm -f \"$lock/pid\"; rmdir \"$lock\" 2>/dev/null' EXIT",
    "printf '%s\\n' \"$$\" > \"$lock/pid\"",
    'seq=$(cat "$counter" 2>/dev/null || printf 0)',
    "case \"$seq\" in ''|*[!0-9]*) seq=0 ;; esac",
    "seq=$((seq + 1))",
    "printf '%s\\n' \"$seq\" > \"$counter.tmp\" && mv \"$counter.tmp\" \"$counter\"",
    "printf '{\"seq\":%s,\"event\":\"%s\",\"receivedAt\":%s,\"payload\":%s}\\n' \"$seq\" \"$event\" \"$(now_ms)\" \"$payload\" >> \"$spool\"",
    "exit 0",
    "",
  ].join("\n");
}

/** The hook command a pack wires per event: `sh '<script>'`, quoted for the vendor's shell. */
export function hookCommand(scriptPath: string): string {
  return `sh ${singleQuoted(scriptPath)}`;
}
