//! Machine wire contract types for oni clients.
//!
//! Every type is generated at build time from the JSON Schema export in
//! `packages/protocol/schema/machine/`; nothing here is written by hand.

include!(concat!(env!("OUT_DIR"), "/machine.rs"));
