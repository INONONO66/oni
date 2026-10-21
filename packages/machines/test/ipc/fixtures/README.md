# Test-only TLS fixtures

Self-signed EC (P-256) key pairs consumed by `packages/machines/test/ipc/network-tls.test.ts`:
`host-*` and `daemon-*` are the two pinned peers, `wrong-*` is the deliberately
mismatching identity. `host-issued-*` is a leaf with its OWN key but SIGNED by
`host-key.pem` (`openssl x509 -req -CA host-cert.pem -CAkey host-key.pem`,
CN=oni-test-host-issued, 7300 days): it validates through the host chain,
so it exercises the pin-compare branch of `checkServerIdentity` in isolation. This is TEST-ONLY material — committed on purpose so tests
never depend on a key generator in the environment; nothing outside these tests
trusts or is trusted by these keys.
