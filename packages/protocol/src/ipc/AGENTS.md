# packages/protocol/src/ipc

JSON-RPC 2.0-style IPC protocol for machine host ↔ machine daemon communication over Unix Domain Sockets.

## Purpose

Defines the locked-in wire contract between a machine host and an attached machine daemon. All messages are JSON-serializable. The fixed version field (`v: 2`) rejects mixed-version traffic; generic envelopes remain permissive while `Ipc.Methods` records the current same-version parameter/result schemas.

## Message Types

| Type | Description |
|------|-------------|
| `request` | Bidirectional call expecting a `response`. Has `id`. |
| `response` | Reply to a `request`. Carries `result` or `error`. |
| `notification` | Fire-and-forget. No `id`, no reply expected. |

## Method Table

| Method | Direction | Description |
|--------|-----------|-------------|
| `machine.attach` | Machine daemon → Machine host | Offer a capability set; the host answers with the enrollment∩offer effective set or a typed refusal. |
| `machine.report` | Machine daemon → Machine host | One load observation (`loadAvg1`, `memoryAvailableBytes`, `inFlight`) from an attached daemon; the host answers `accepted` or a typed refusal (`machine_not_attached`, `machine_mismatch`). Static capacity (`cpus`, `memoryBytes`) rides the attach offer as `resources`. (#1555) |
| `machine.run_cell` | Machine host → Machine daemon | Run one code cell on the attachment's persistent interpreter under a required deadline. |
| `machine.call_tool` | Machine daemon → Machine host | A `tool.<name>()` call made from inside a running cell, answered by the host's injected tool port. |

The former `coordinator.*`/`worker.*` method rows were removed with their runtime (coordinator/worker processes deleted in #792/#797; no live peer ever spoke them on the machine wire). The `machine.*` frames — the only frames any shipped peer sends — are byte-identical, so the version stays `2`; removing a never-spoken method row is not a wire change.

## Versioning Policy

The `v` field is a protocol version integer.

- Current version: `v: 2`
- Backward-incompatible changes to frames a live peer sends (field removal, type change, semantic change) require bumping the version
- Additive changes (new optional fields) are allowed without a version bump
- The transport rejects any schema-invalid JSON frame, including a version mismatch, with error code `4000`

## Error Codes

| Code | Meaning |
|------|---------|
| `1000` | Request handler failure or missing handler |
| `4000` | JSON parsed, but the IPC envelope schema (including version) is invalid |
| `4001` | Frame is not valid JSON or exceeds the transport frame cap |

The generic error envelope can carry other numeric codes, but current transport code emits only the codes above.
