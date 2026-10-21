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
