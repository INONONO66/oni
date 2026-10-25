# Machine network keys (#1270)

Each end of a network attachment verifies the other, asymmetrically: the
daemon config carries the host's CERTIFICATE file (`hostCertificate`) and the
TLS chain must validate against it (`rejectUnauthorized: true`) with the
presented key's fingerprint equal to that certificate's — CN-only self-signed
certs work, no hostname semantics apply. The host pins the daemon's KEY
through `Enrollment.publicKey`. A fingerprint is 64 lowercase hex characters:
sha256 over the public key's SPKI DER (`Machine.fingerprintOf`; from a
certificate, `certificateKeyFingerprint` extracts the same SPKI first).
Daemon certificates are only carriers (self-signed is the norm); the HOST
certificate is a real trust anchor on the daemon side — its expiry is
enforced by chain validation, so give it a long validity.

## Generate an identity (self-signed EC P-256)

```sh
openssl ecparam -name prime256v1 -genkey -noout -out host-key.pem
openssl req -new -x509 -key host-key.pem -out host-cert.pem -days 3650 -subj "/CN=oni-host"
```

Repeat with `daemon-key.pem` / `daemon-cert.pem` (any CN) on the machine that
will attach.

## Derive the fingerprint to pin (enrollment side only)

```sh
openssl x509 -in daemon-cert.pem -pubkey -noout \
  | openssl pkey -pubin -outform DER \
  | openssl dgst -sha256 -r | cut -d' ' -f1
```

That value goes in the enrollment as `publicKey` (for the daemon's cert). The
daemon side needs no fingerprint: its JSON points at the host certificate PEM
itself.

## Host exposure

Set the full tuple or none of it — a partial tuple refuses boot
(`invalid_machines_tcp`) rather than binding unencrypted:

```sh
ONI_MACHINES_TCP_HOST=0.0.0.0     # or a tailnet/LAN interface address
ONI_MACHINES_TCP_PORT=7643
ONI_MACHINES_TLS_CERT=/path/host-cert.pem
ONI_MACHINES_TLS_KEY=/path/host-key.pem
```

The unix socket stays bound regardless; same-box daemons keep zero config.

## Daemon config (`oni machine attach <config.json>`)

```json
{
  "tcp": { "host": "100.64.0.7", "port": 7643 },
  "hostCertificate": "/path/host-cert.pem",
  "tlsCertificate": "/path/daemon-cert.pem",
  "tlsPrivateKey": "/path/daemon-key.pem",
  "offer": { "machineId": "studio", "offeredCapabilities": ["fs.read"], "daemonVersion": "1", "platform": "darwin-arm64", "offeredAt": 0 }
}
```

`hostCertificate` and the TLS fields are PEM file paths, read at attach time. Addressing is plain TCP:
over Tailscale, put the tailnet IP (or MagicDNS name) in `tcp.host` — there is
no app-level Tailscale integration; on a LAN, the host's interface address.
Pinning makes the transport safe on any reachable network.

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
`ONI_MACHINES_TCP_*`/`ONI_MACHINES_TLS_*` tuple serves daemons and clients.

## Rotation

DAEMON certificates may be re-issued freely as long as the KEY inside is
unchanged — the enrollment pin survives. The HOST certificate may not:
re-issuing it, EVEN WITH THE SAME KEY, fails chain validation against the old
PEM (observed on Bun 1.4.1/1.4.2: a same-key, same-CN self-signed re-issue is
refused `DEPTH_ZERO_SELF_SIGNED_CERT` — OpenSSL requires the presented
self-signed certificate itself to be the trust anchor, not merely its key),
so every daemon JSON must receive the new host PEM. Chain validation also
enforces the host certificate's validity window: an expired host certificate
refuses typed exactly like a mismatch (`IpcPeerKeyMismatchError`, code
`CERT_HAS_EXPIRED`) — choose a long validity when generating it. Rotating a
daemon key is an out-of-band admission change: update the enrollment
`publicKey`, then swap the files. A stale host PEM or enrollment pin refuses
with `peer_key_mismatch`; nothing downgrades. The Rust client pins the host
KEY, not the certificate, so a same-key host re-issue keeps working for it;
a host key change needs a fresh `mclient join` (or an edited `host-pin`).

## QA recipe (ten lines)

```sh
openssl ecparam -name prime256v1 -genkey -noout -out /tmp/hk.pem && openssl req -new -x509 -key /tmp/hk.pem -out /tmp/hc.pem -days 30 -subj "/CN=h"
openssl ecparam -name prime256v1 -genkey -noout -out /tmp/dk.pem && openssl req -new -x509 -key /tmp/dk.pem -out /tmp/dc.pem -days 30 -subj "/CN=d"
DF=$(openssl x509 -in /tmp/dc.pem -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -r | cut -d' ' -f1)
export ONI_MACHINES_TCP_HOST=127.0.0.1 ONI_MACHINES_TCP_PORT=7643 ONI_MACHINES_TLS_CERT=/tmp/hc.pem ONI_MACHINES_TLS_KEY=/tmp/hk.pem
export ONI_MACHINES_ENROLLED="[{\"machineId\":\"qa\",\"name\":\"qa\",\"allowedCapabilities\":[\"kernel.py\"],\"publicKey\":\"$DF\",\"enrolledAt\":0}]"
bun apps/oni/src/cli/main.ts start &   # host side, with the rest of your env
printf '{"tcp":{"host":"127.0.0.1","port":7643},"hostCertificate":"/tmp/hc.pem","tlsCertificate":"/tmp/dc.pem","tlsPrivateKey":"/tmp/dk.pem","offer":{"machineId":"qa","offeredCapabilities":["kernel.py"],"daemonVersion":"qa","platform":"qa","offeredAt":0}}' > /tmp/machine.json
bun apps/oni/src/cli/main.ts machine attach /tmp/machine.json   # prints {"status":"attached",...}
# kill the host: the daemon stays up, retrying with jittered backoff (capped 30s); restart the host and the machine serves again under the same identity
```
