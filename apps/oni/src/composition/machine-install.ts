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
 * (#1838): one command on a fresh machine does what `oni machine bootstrap`
 * does — detect the platform, read the host's `/machine/release` answer,
 * download the archive it names, refuse it unless its byte count and SHA-256
 * match that answer, install `~/.oni/bin/mclient` (0755) and run
 * `mclient join`, which stages the same verified release, records the pin
 * and installs the service. Nothing external is fetched: the release
 * record, the archive and the script itself all come from the host or the
 * download URL the host's record names. Only the host's HTTP origin and the
 * optional join token are arguments; a tampered archive exits 1 with
 * `checksum_mismatch: <url>` on stderr before anything is installed.
 */
export const MACHINE_INSTALL_SCRIPT = `#!/bin/sh
# oni machine install: served by the host at GET /machine/install.
#   curl -fsSL http://<host>:<port>/machine/install | sh -s -- http://<host>:<port> [--token <join token>]
set -eu

usage() {
  echo "usage: sh -s -- <http(s)://host[:port]> [--token <join token>]" >&2
  exit 2
}

HOST="\${1:-}"
[ -n "$HOST" ] || usage
shift
TOKEN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --token)
      [ $# -ge 2 ] || usage
      TOKEN="$2"
      shift 2
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
case "$URL" in
  *://*) ;;
  /*) URL="$HOST$URL" ;;
  *) URL="$HOST/machine/$URL" ;;
esac

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

tar -xzf "$WORK/archive.tar.gz" -C "$WORK" mclient
BIN="$HOME/.oni/bin"
mkdir -p "$BIN"
cp "$WORK/mclient" "$BIN/mclient.staged"
chmod 0755 "$BIN/mclient.staged"
mv -f "$BIN/mclient.staged" "$BIN/mclient"
echo "installed $BIN/mclient ($TAG, $PLATFORM)"
rm -rf "$WORK"
trap - EXIT

if [ -n "$TOKEN" ]; then
  exec "$BIN/mclient" join "$JOIN_HOST" --token "$TOKEN"
fi
exec "$BIN/mclient" join "$JOIN_HOST"
`;
