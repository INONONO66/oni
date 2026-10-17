/**
 * The spool appender installed on the child's machine (#1511 remote-host
 * rule, #1512): the vendor runs `sh <script> <event>` with its payload JSON
 * on stdin, and the script appends exactly one line
 * `{seq, event, receivedAt, payload}` to the spool. The sequence is a
 * per-child counter file advanced under a `mkdir` lock, so two concurrent
 * hook processes never share a number; `receivedAt` is epoch milliseconds.
 * POSIX sh only — it has to run on whatever shell the machine offers — and
 * vendor-neutral: the event name is whatever argument the pack's live config
 * wired, the payload is appended verbatim.
 */
const LOCK_TRIES_BEFORE_BREAK = 500;

function singleQuoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function hookScript(spoolPath: string): string {
  return [
    "#!/bin/sh",
    "# openomni hook spool appender (#1512): one line per vendor event, monotonic seq, mkdir lock.",
    "set -u",
    // The vendor passes exactly one argument; `$*` reads it without tripping `set -u` when none came.
    'event="$*"',
    `spool=${singleQuoted(spoolPath)}`,
    'counter="$spool.seq"',
    'lock="$spool.lock"',
    "case \"$event\" in ''|*[!A-Za-z0-9_]*) exit 0 ;; esac",
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
    // A holder that died mid-append leaves its lock; after the bound it is broken rather than held forever.
    `  if [ "$tries" -gt ${LOCK_TRIES_BEFORE_BREAK} ]; then rmdir "$lock" 2>/dev/null; tries=0; fi`,
    "  sleep 0.02 2>/dev/null || sleep 1",
    "done",
    "trap 'rmdir \"$lock\" 2>/dev/null' EXIT",
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
