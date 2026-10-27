# Machine network keys (#1270)

The host pins the Rust client's key through `Enrollment.publicKey`. The client
pins the host key after `mclient join`, using a 64-character lowercase hex
SHA-256 fingerprint of the public key's SPKI DER. Its settings file does not
carry TLS keys or the host pin; `join` records identity and trust state.

## Generate an identity (self-signed EC P-256)

```sh
openssl ecparam -name prime256v1 -genkey -noout -out host-key.pem
openssl req -new -x509 -key host-key.pem -out host-cert.pem -days 3650 -subj "/CN=oni-host"
```

`mclient join` generates the client identity; no manual client certificate
is needed.

## Derive the host fingerprint

```sh
openssl x509 -in host-cert.pem -pubkey -noout \
  | openssl pkey -pubin -outform DER \
  | openssl dgst -sha256 -r | cut -d' ' -f1
```

Pass that fingerprint to `mclient join --host-pin`. The client's enrollment
`publicKey` comes from the receipt that `join` prints.

## Host exposure

Set the full tuple or none of it — a partial tuple refuses boot
(`invalid_machines_tcp`) rather than binding unencrypted:

```sh
ONI_MACHINES_TCP_HOST=0.0.0.0     # or a tailnet/LAN interface address
ONI_MACHINES_TCP_PORT=7643
ONI_MACHINES_TLS_CERT=/path/host-cert.pem
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

Run `mclient join <host> --host-pin <fingerprint>` before starting the
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
2. Host trust is chosen in this precedence, first match wins:
   `--host-pin <64 hex>` (the host key's SPKI SHA-256; a malformed value is
   `invalid host pin`), then `--host-cert <pem>`, then
   `~/.oni/tls/host-cert.pem` if present, then `--trust-on-first-use`.
   None of them is `pin_required`: the client never connects unpinned by
   default.
3. `~/.oni/machine-client/` is created 0700 and `client.json` written 0600
   (`machineId`, `name`, `host`, `exports`, `tags`, `memoryBudgetMb`,
   `unix`). `machineId` is the slug of `--name` (default: the hostname).
   Each `--export name=/abs/path` needs a lowercase name (`[a-z][a-z0-9_-]{0,63}`)
   and an absolute path without `..`; duplicates refuse `invalid export`.
4. A self-signed EC P-256 identity valid for ten years is written as
   `client-key.pem` and `client-cert.pem`, both 0600. Its SPKI SHA-256 is
   the `publicKey` in the receipt, so `join` can be rerun to rotate: the
   enrollment pin then changes and the Owner must re-admit the id.
5. Over TLS the client connects once with the chosen trust, verifying the
   handshake signature as well as the key. The host's SPKI SHA-256 is then
   persisted as `host-pin` (0600) and that file is the only trust `run`
   consults afterwards. A certificate given by `--host-cert` or the shared
   PEM must carry the key that is presented; `--trust-on-first-use` records
   whatever key answered and prints it once as `{"hostPin": "<hex>"}` on
   stderr so the Owner can compare it out of band. A host that later
   presents a different key is refused `peer_key_mismatch` (exit 3); nothing
   downgrades.
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
certificate with the same key preserves trust. A host key change needs
a fresh `mclient join`. Rotating the client identity changes the enrollment
`publicKey`, so the Owner must re-admit the new receipt.

## QA recipe

```sh
openssl ecparam -name prime256v1 -genkey -noout -out /tmp/hk.pem && openssl req -new -x509 -key /tmp/hk.pem -out /tmp/hc.pem -days 30 -subj "/CN=h"
HP=$(openssl x509 -in /tmp/hc.pem -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -r | cut -d' ' -f1)
export ONI_MACHINES_TCP_HOST=127.0.0.1 ONI_MACHINES_TCP_PORT=7643 ONI_MACHINES_TLS_CERT=/tmp/hc.pem ONI_MACHINES_TLS_KEY=/tmp/hk.pem
oni start    # with the host environment above
mclient join 127.0.0.1:7643 --name qa --host-pin "$HP" --export work=/tmp
# Admit the printed enrollment receipt through provision machine_add.
mclient run --config ~/.oni/machine-client/client.json
# Restart the host: the client reconnects with its saved generation.
```
