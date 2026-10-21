# Oni

Single-Owner Agent OS — one permanent Resident agent, running 24/7 on your own machine.

Oni runs on the [Bun](https://bun.sh) runtime. The CLI installs via npm and re-executes itself under bun automatically.

## Install

```bash
curl -fsSL https://bun.sh/install | bash   # once, if you don't have bun
npm install -g oni                     # or: bun add -g oni
```

## Set up and run 24/7

```bash
oni onboard          # interactive: model provider/id/API key, port, channel tokens
oni daemon install   # launchd (macOS) / systemd --user (Linux); starts now, survives reboot
oni doctor           # read-only diagnostics
oni logs             # follow the daemon logs
```

Configuration lives in `~/.oni/env` (written by `onboard`, chmod 0600). Data lives in `~/.oni/`. Exported `ONI_*` environment variables always override the file.

On Linux, keep the user service alive after logout:

```bash
loginctl enable-linger $USER
```

## Foreground run

```bash
oni start
```

The Resident listens on `ws://127.0.0.1:3000/ws` by default (WebSocket, token-gated off loopback) with a `GET /health` endpoint on the same port.

## Commands

| Command | What it does |
| --- | --- |
| `oni start` | Run the Resident in the foreground |
| `oni onboard` | Interactive setup, writes `~/.oni/env` |
| `oni daemon install\|uninstall\|status\|start\|stop\|restart` | Manage the 24/7 service |
| `oni doctor` | Diagnostics: config, daemon state, health probe |
| `oni logs` | Follow daemon logs |

Source, docs, and issues: <https://github.com/INONONO66/oni>
