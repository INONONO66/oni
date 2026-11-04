# Test-only TLS fixtures

Self-signed EC (P-256) key pairs consumed by `packages/machines/test/ipc/network-tls.test.ts`:
`host-*` and `daemon-*` are the two pinned peers, `wrong-*` is the deliberately
mismatching identity. `host-issued-*` is a leaf with its OWN key but SIGNED by
`host-key.pem` (`openssl x509 -req -CA host-cert.pem -CAkey host-key.pem`,
CN=oni-test-host-issued, 7300 days): a different key behind a familiar issuer,
so only the key pin can refuse it. `host-renewed-cert.pem` is `host-key.pem`
reissued self-signed (`openssl req -new -x509 -key host-key.pem`, 7300 days):
a renewal that keeps the key and therefore the pin. `host-chain.pem` is an
ACME-style chain for the same key: a leaf for `host-key.pem` signed by a
throwaway `CN=oni-test-issuer` CA (`openssl x509 -req -CA issuer-cert.pem
-CAkey issuer-key.pem`), followed by that issuer certificate; the issuer key
was discarded after signing. This is TEST-ONLY material — committed on purpose
so tests never depend on a key generator in the environment; nothing outside
these tests trusts or is trusted by these keys.
