# Machine network keys (#1270)

The host pins the Rust client's key through `Enrollment.publicKey`. The client
pins the host KEY after `mclient join`: the pin is the standard base64 of the
SHA-256 over the public key's SPKI DER, so it names the key and not any one
certificate — a certificate reissued or re-chained for the same key keeps the
pin. Its settings file does not carry TLS keys or the host pin; `join`
records identity and trust state.

## Generate an identity (self-signed EC P-256)

```sh
openssl ecparam -name prime256v1 -genkey -noout -out host-key.pem
openssl req -new -x509 -key host-key.pem -out host-cert.pem -days 3650 -subj "/CN=oni-host"
```

`mclient join` generates the client identity; no manual client certificate
is needed.

## Derive the host pin

```sh
openssl x509 -in host-cert.pem -pubkey -noout \
  | openssl pkey -pubin -outform DER \
  | openssl dgst -sha256 -binary | base64
```

Pass that value to `mclient join --host-pin`. When the host serves a chain
file, `openssl x509` reads its first certificate, the leaf, which is the one
the pin judges. The client's enrollment `publicKey` comes from the receipt
that `join` prints and stays the 64-hex fingerprint the host compares.

## Host exposure

Set the full tuple or none of it — a partial listener tuple refuses boot
(`invalid_machines_tcp`, `invalid_machines_ws`) and a half TLS pair or a
missing PEM refuses it as `invalid_machines_tls`, never binding unencrypted:

```sh
ONI_MACHINES_TCP_HOST=0.0.0.0     # or a tailnet/LAN interface address
ONI_MACHINES_TCP_PORT=7643
ONI_MACHINES_TLS_CERT=/path/host-cert.pem   # a leaf, or a full chain (leaf first)
ONI_MACHINES_TLS_KEY=/path/host-key.pem
```

The unix socket stays bound regardless; same-box clients can join over Unix.

## Client settings (`mclient run --config <settings.json>`)

```json
{
  "machineId": "studio",
  "name": "Studio",
  "host": "100.64.0.7:7643",
  "unix": null,
  "exports": [{ "name": "work", "path": "/home/owner/work" }],
  "tags": ["studio"],
  "memoryBudgetMb": 1024
}
```

Run `mclient join <host> --host-pin <pin>` before starting the
client. It persists the TLS identity and host pin separately from settings;
`unix` names a same-box socket instead of TCP. Host enrollment bounds
effective capabilities; no second capability filter lives in these settings.

## Client join (`mclient join`, #1626)

The Rust client needs none of the openssl steps above. `mclient join <host>`
generates its own identity and records the host's key in one run:

1. `<host>` is `name`, `name:port`, `ip`, `[ipv6]:port` or a bare peer
   name. An IP address or a dotted name is used as given; a bare name is
   looked up through `tailscale status --json` (searched on `PATH`, then
   `/usr/bin/tailscale`, then the macOS app bundle) by `HostName` or the
   first label of `DNSName`, and its first tailnet IP is taken. No resolver
   found, a failed lookup or an unknown name refuses `host_unresolved`. The
   port defaults to 7643. `--unix <socket>` skips resolution and trust
   entirely (same-box use; the unix door carries no peer key).
2. Host trust is the pin alone: `--host-pin <base64>` (the host key's SPKI
   SHA-256; a value that is not 32 base64 bytes is `invalid host pin`). No
   certificate file stands in for it. A TLS join without it is
   `pin_required`: the client never connects unpinned, and no flag turns
   that off.
3. `~/.oni/machine-client/` is created 0700 and `client.json` written 0600
   (`machineId`, `name`, `host`, `exports`, `tags`, `memoryBudgetMb`,
   `unix`). `machineId` is the slug of `--name` (default: the hostname).
   Each `--export name=/abs/path` needs a lowercase name (`[a-z][a-z0-9_-]{0,63}`)
   and an absolute path without `..`; duplicates refuse `invalid export`.
4. A self-signed EC P-256 identity valid for ten years is written as
   `client-key.pem` and `client-cert.pem`, both 0600. Its SPKI SHA-256 is
   the `publicKey` in the receipt, so `join` can be rerun to rotate: the
   enrollment pin then changes and the Owner must re-admit the id.
5. Over TLS the client connects once with that pin, verifying the
   handshake signature as well as the key. The host's SPKI SHA-256 is then
   persisted as `host-pin` (0600, the same base64 text) and that file is
   the only trust `run` consults afterwards. A host that later presents a
   different key is refused `peer_key_mismatch` (exit 3) before any frame
   is sent; nothing downgrades.
6. Any saved attach generation (`state.json`) is cleared, and the enrollment
   receipt is printed on stdout as one JSON object:
   `{"machineId", "name", "publicKey", "allowedCapabilities":
   ["fs.read","fs.write","shell.exec","pty.session"], "allowedExports":
   [names]}`. Hand it to `provision machine_add` (or the
   `ONI_MACHINES_ENROLLED` seed) unchanged.

A join that fails after step 3 leaves the config and identity behind but no
`host-pin`, so `run` refuses with the missing-file I/O error until the join
completes. The host side needs nothing beyond the enrollment: the same
`ONI_MACHINES_TCP_*`/`ONI_MACHINES_TLS_*` tuple serves clients.

## Rotation

The Rust client pins the host key, not its certificate; reissuing a
certificate with the same key preserves trust. An ACME-style renewal works
the same way: point `ONI_MACHINES_TLS_CERT` at the renewed full chain (leaf
first) with the unchanged key under `ONI_MACHINES_TLS_KEY`, and the host
serves the whole chain while every joined client keeps attaching with the
pin it recorded — no re-join and no change to its enrollment. A host KEY
change needs a fresh `mclient join`. Rotating the client identity changes
the enrollment `publicKey`, so the Owner must re-admit the new receipt.

## QA recipe

```sh
openssl ecparam -name prime256v1 -genkey -noout -out /tmp/hk.pem && openssl req -new -x509 -key /tmp/hk.pem -out /tmp/hc.pem -days 30 -subj "/CN=h"
HP=$(openssl x509 -in /tmp/hc.pem -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | base64)
export ONI_MACHINES_TCP_HOST=127.0.0.1 ONI_MACHINES_TCP_PORT=7643 ONI_MACHINES_TLS_CERT=/tmp/hc.pem ONI_MACHINES_TLS_KEY=/tmp/hk.pem
oni start    # with the host environment above
mclient join 127.0.0.1:7643 --name qa --host-pin "$HP" --export work=/tmp
# Admit the printed enrollment receipt through provision machine_add.
mclient run --config ~/.oni/machine-client/client.json
# Restart the host: the client reconnects with its saved generation.
```
