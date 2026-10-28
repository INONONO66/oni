# clients

Rust workspace for programs that run on a machine and speak the oni machine
wire contract. `protocol` (`oni-protocol`) holds the contract types;
`machine-client` (`oni-machine-client`) builds the `mclient` binary.

Build and test from this directory with `cargo build`, `cargo test` and
`cargo build --release`; `rust-toolchain.toml` pins the compiler. Run
`cargo run -p oni-machine-client -- --version` to see the client and contract
versions.

Types are not written by hand. `protocol/build.rs` reads
`packages/protocol/schema/machine/index.json`, converts every listed JSON
Schema with typify into its own module, and exports
`CONTRACT_VERSION` from the index. Regenerate the schemas with
`bun run generate:machine-schema` at the repository root; the next cargo build
picks them up. `protocol/tests/fixtures.rs` checks the generated types against
the shared fixtures in `packages/protocol/fixtures/machine/`.

`mclient join <host> --host-pin <sha256> --export work=/absolute/path`
creates `~/.oni/machine-client/client.json`, an identity and an enrollment
receipt. The enrollment receipt contains the full supported capability set;
the running client offers only capabilities its drivers can serve. Join installs
and starts `ai.oni.machine` under the user's macOS LaunchAgents directory or
`oni-machine-client.service` under the system (root) or user (non-root) systemd
directory. Rejoining restarts the service with the new identity and settings.
`--no-service` leaves service management to the operator. `--service-dir <path>`
overrides the unit directory; it does not skip service activation. A non-root
Linux user unit needs `loginctl enable-linger` to survive logout. On macOS,
the launched client requests Screen Recording permission on its first start;
join opens the Settings pane for inspection unless `--no-open` is passed.
Join ends with the config path, service status, capabilities and instructions
for Screen Recording permission (or `unsupported` on Linux).
