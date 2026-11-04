import type { Machine } from "@oni/protocol";

/**
 * The release artifact key for a platform (#1838), the same table the client
 * keeps in `release::platform`: macOS installs the universal archive, Linux
 * picks by architecture, anything else has no artifact. Node names the
 * platform `darwin`/`linux` and the architecture `x64`/`arm64`; the shell
 * script below reads `uname -s`/`uname -m` into the same keys.
 */
export function releasePlatform(os: string, arch: string): Machine.ReleasePlatform | undefined {
  if (os === "darwin") return "darwin-universal";
  if (os === "linux" && arch === "x64") return "linux-x86_64";
  if (os === "linux" && arch === "arm64") return "linux-arm64";
  return undefined;
}

/** The host's address as the install surfaces take it: the HTTP origin `GET /machine/release` is served from. */
export const HOST_ORIGIN = /^https?:\/\/[^/\s]+$/;

/**
 * The name `mclient join` attaches to: the origin's host without its HTTP
 * port, so the client reaches the machine plane on its own default port.
 */
export function joinHost(origin: string): string {
  return origin.replace(/^https?:\/\//, "").replace(/:\d+$/, "");
}

/**
 * The POSIX sh install script the host serves at `GET /machine/install`
 * (#1838), the shell twin of `oni machine bootstrap`: it verifies the
 * archive against the host's `/machine/release` answer, stages the binary
 * and runs `mclient join` from the stage, so join's own update path is the
 * only writer of `~/.oni/bin/mclient`. A tampered archive exits 1 with
 * `checksum_mismatch: <url>` before anything is written.
 */
export const MACHINE_INSTALL_SCRIPT = `#!/bin/sh
# oni machine install: served by the host at GET /machine/install.
#   curl -fsSL http://<host>:<port>/machine/install | sh -s -- http://<host>:<port> [--token <join token>] [--force]
set -eu

usage() {
  echo "usage: sh -s -- <http(s)://host[:port]> [--token <join token>] [--force]" >&2
  exit 2
}

# older A B: true when dotted version A sorts before B, numerically per part.
older() {
  a="$1"
  b="$2"
  while [ -n "$a" ] || [ -n "$b" ]; do
    x="\${a%%.*}"
    y="\${b%%.*}"
    [ "$a" = "$x" ] && a="" || a="\${a#*.}"
    [ "$b" = "$y" ] && b="" || b="\${b#*.}"
    [ "\${x:-0}" -lt "\${y:-0}" ] 2>/dev/null && return 0
    [ "\${x:-0}" -gt "\${y:-0}" ] 2>/dev/null && return 1
  done
  return 1
}

HOST="\${1:-}"
[ -n "$HOST" ] || usage
shift
TOKEN=""
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --token)
      [ $# -ge 2 ] || usage
      TOKEN="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    *) usage ;;
  esac
done
case "$HOST" in
  http://*|https://*) ;;
  *) usage ;;
esac
HOST="\${HOST%/}"
JOIN_HOST="\${HOST#*://}"
JOIN_HOST="\${JOIN_HOST%:*}"

case "$(uname -s)" in
  Darwin) PLATFORM=darwin-universal ;;
  Linux)
    case "$(uname -m)" in
      x86_64) PLATFORM=linux-x86_64 ;;
      aarch64|arm64) PLATFORM=linux-arm64 ;;
      *)
        echo "unsupported platform: $(uname -s)-$(uname -m)" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "unsupported platform: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

RELEASE=$(curl -fsSL "$HOST/machine/release") || {
  echo "release unavailable at $HOST/machine/release" >&2
  exit 1
}
ARTIFACT=$(printf '%s' "$RELEASE" | sed -n "s/.*\\"$PLATFORM\\":{\\([^}]*\\)}.*/\\1/p")
[ -n "$ARTIFACT" ] || {
  echo "no $PLATFORM artifact in the host's release" >&2
  exit 1
}
URL=$(printf '%s' "$ARTIFACT" | sed -n 's/.*"url":"\\([^"]*\\)".*/\\1/p')
SHA256=$(printf '%s' "$ARTIFACT" | sed -n 's/.*"sha256":"\\([0-9a-f]*\\)".*/\\1/p')
BYTES=$(printf '%s' "$ARTIFACT" | sed -n 's/.*"bytes":\\([0-9]*\\).*/\\1/p')
TAG=$(printf '%s' "$RELEASE" | sed -n 's/.*"tag":"\\([^"]*\\)".*/\\1/p')
VERSION=$(printf '%s' "$RELEASE" | sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p')
case "$URL" in
  *://*) ;;
  /*) URL="$HOST$URL" ;;
  *) URL="$HOST/machine/$URL" ;;
esac

CLIENT="$HOME/.oni/machine-client"
if [ "$FORCE" = 0 ] && [ -f "$CLIENT/pin.json" ]; then
  PINNED=$(sed -n 's/.*"pinnedVersion":"\\([^"]*\\)".*/\\1/p' "$CLIENT/pin.json")
  if older "$VERSION" "$PINNED"; then
    echo "downgrade_refused: the host's $VERSION is older than the pinned $PINNED (pass --force)" >&2
    exit 1
  fi
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
curl -fsSL -o "$WORK/archive.tar.gz" "$URL" || {
  echo "download failed: $URL" >&2
  exit 1
}
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "$WORK/archive.tar.gz" | cut -d ' ' -f 1)
else
  ACTUAL=$(shasum -a 256 "$WORK/archive.tar.gz" | cut -d ' ' -f 1)
fi
SIZE=$(wc -c < "$WORK/archive.tar.gz" | tr -d ' ')
[ "$SIZE" = "$BYTES" ] && [ "$ACTUAL" = "$SHA256" ] || {
  echo "checksum_mismatch: $URL" >&2
  exit 1
}

# The stage sits beside the client's own version directories (a tmpfs may be noexec);
# join copies the binary into its layout and this stage goes away with the trap.
mkdir -p "$CLIENT"
STAGE=$(mktemp -d "$CLIENT/bootstrap.XXXXXX")
trap 'rm -rf "$WORK" "$STAGE"' EXIT
tar -xzf "$WORK/archive.tar.gz" -C "$STAGE" mclient
chmod 0755 "$STAGE/mclient"
echo "verified $TAG ($PLATFORM): mclient join $JOIN_HOST"

if [ -n "$TOKEN" ]; then
  "$STAGE/mclient" join "$JOIN_HOST" --token "$TOKEN"
else
  "$STAGE/mclient" join "$JOIN_HOST"
fi
`;
