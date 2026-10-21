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
with `peer_key_mismatch`; nothing downgrades.

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
