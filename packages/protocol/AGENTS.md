# packages/protocol

2026-10-03, #1251 point registry: `src/policy/point.ts` carries the fourteen `{id, owner, allowedDo, rewritableFields, whenFields}` point records (eight core, six capability) and the emit allowed set `message | alarm.arm | compaction`; `src/policy/row.ts` the single gate-row contract, decision/consulted/fact records, `emittedRowKey`, and the #1255 compose rejection codes (`unknown_point`, `unknown_handler`, `duplicate`, `bad_action`, `bad_field`, `post_end_emit`). New points require a record; agent composes the merged registration table.

2026-09-07, #969 Owner-answer ingress: `Gateway.RequestAnswer` carries a stable inputId, exact request binding, explicit approve/refuse decision, and transient credential. Authenticated principal and receipt time are gateway outputs, not caller-supplied wire fields.

2026-09-07, #969 request cutover: `ledger/session-transition.ts` owns the original-action request schemas. Gateway and ingress use `requestId`, `requestSpec`, `requestContext`, and `request_correlation`. The old independent lifecycle schema/fold modules and gateway lifecycle control contract are removed. Physical matching lives in channels; durable transition decisions live in agent.

Shared type foundation. Zero internal dependencies. All cross-package Zod schemas live here.

Protocol defines schemas plus pure folds — no effects, storage, or I/O. It may describe communication, actor, dispatch, work, IPC, and storage contracts, but it must not decide routing, authority, lifecycle precedence, or execution policy. Product meaning belongs in `apps/openomni`; lower primitive behavior belongs in its owning package.

## STRUCTURE

```
src/
├── index.ts              # Package barrel: all public domains
├── actor/                # Actor.Identity / Endpoint, TrustTier, blacklist schemas
├── bus/                  # BusEvent.define() + injected BusEvent.Sink contract
├── channel/              # Channel surfaces, messages, config, and surface-key codec
├── cron/                 # Cron job schemas
├── error/                # NamedError factory and shared protocol errors
├── event/                # Ingress, LLM, operational, policy, and tool descriptors
├── gateway/              # Gateway delivery/send/request contracts and messaging events
├── ingress/              # Inbound contracts plus payload, route-record, surface-key, and target helpers
├── ipc/                  # Version-2 generic envelopes plus machine wire method schemas
├── ledger/               # Append/adopt/chain contracts and frozen stream payload registry
├── message/              # Message.Part variants, Message.Info, Message.WithParts
├── model/                # Model.Ref and model status
├── policy/               # 18-point registry, contracts, plan, permissions, resources, and effects
├── storage/              # Storage namespace: sub-adapter interface contracts (single file)
├── token/                # Token usage contracts
├── tool/                 # Tool.Spec / Call / Result / State
├── trace/                # TraceContext contract and pure UUID-to-trace-id codec
├── transcript/           # Transcript facts and pure fold
```

The #969 `SessionTransition` vocabulary maps to the existing Session and Action contract: Request/Answer/Command describe transitions of the original action, not a new standalone domain. Its reviewed schema snapshot replaces the deleted independent lifecycle schemas; this issue authorizes that removal, not compatibility aliases.

Namespace additions are gated: `script/lint-tools.ts` (#467) enforces a grandfathered baseline with a no-new-violations ratchet against the core-model Tier-1/2 vocabulary, and the schema-snapshot lint flags field removals/renames (regenerate via `--update` — that diff is the review sign-off surface).

## KEY PATTERNS

- `Machine.CapacityRow`/`CapacityRows` validate host capacity data: one machine or tag selector, positive slots, nonnegative memory reserve, unit exec/eval/pty costs and a positive job cost. Duplicate selectors refuse; future selectors remain valid. `Machine.LeaseRefusal` carries decision credit (`slots: null` for unknown), shared with `machine.lease_refused`; runtime admission and expiry belong to machines.

- **NamedError factory**: `NamedError.create(name, zodSchema)` produces typed error classes with `.isInstance()` guard, `.toObject()` serialization, and `.Schema` for validation. `ProviderError` (in the agent model plane) uses this.
- **Namespace + Zod duality**: Schemas and types share the same name (e.g., `Tool.State` is both a Zod schema and a TS type). Access schema for validation, type for TS.
- **Discriminated unions**: `Tool.State` on `status`, `Message.Part` on `type`, `Message.Info` on `role`, `Policy.PolicyDecision` on `verdict`, and `Ingress.InboundEvent` on `mode`. `DirectEvent` (`mode: "direct"`) is external inbound; `InternalEvent` (`mode: "internal"`) is system-origin input such as cron. The external `ingest()` path rejects internal events for security. LLM `Run.Outcome` and its streaming `Sink` are owned by the agent model plane, not protocol.
- **Event correlation**: Event descriptors define their own schemas and carry the relevant trace/run/session identity. There is no exported universal `BaseEvent` contract.
- **Policy vocabulary**: `Policy.PolicyDecision` verdict is one of `allow | deny | pending`; executable row verdicts live in `policy/row-verdict.ts`. The unconsumed interception-point contract registry, plan/obligation schemas, and the legacy `Timing` alias were deleted in #1246 — the gate engine in `packages/agent` evaluates compiled rows and permissions directly.
- **Storage sub-adapters**: `storage/index.ts` holds the `Storage` namespace of pure interface contracts — no runtime logic. Implementations live in the agent store plane and the channels store plane.
- **IPC contracts**: `ipc/` describes the generic wire envelopes and the machine wire method schemas only. Process delegation lifecycle lives in the product app.
- **Machine gateway reads**: `machine/gateway.ts` owns `Machine.Info`, `Machine.Request` (`machine_list`) and `Machine.Response` (`machine_listed` or a correlated refusal). These are desktop gateway frames, not daemon IPC methods. Enrollment events carry the committed enrollment or removed machine id; detach reasons include `enrollment_removed`.
- **Trace contract**: `trace/index.ts` defines `TraceContext` and the pure `traceIdFromUuid()` format codec. Runtime entropy belongs to telemetry or the consuming driver package.

## CONTRACT BOUNDARY

Allowed here:

- Zod schemas and inferred TypeScript types.
- Bus event descriptors via `BusEvent.define()`.
- Storage adapter interfaces.
- Wire/request/response contracts for IPC, ingress, and tools.
- Pure helpers that are strictly schema-local, such as ID/hash formatting or status derivation when no storage/runtime facts are consulted.

Not allowed here:

- Actor trust, channel grant, or blacklist evaluation.
- Session or target resolution.
- Dispatch/ingress handler routing.
- Provider behavior, process supervision, storage implementation, or agent-loop execution.

If a helper needs data from stores, runtime context, channel facts, or policy decisions, it does not belong in protocol.

## FUTURE PRODUCT MODEL CONTRACTS

The product model is documented in `docs/core-model.md`. Future schemas should live here when they become implementation work:

- Resident/Worker profile and lifecycle contracts;
- inbound authority / actor role contracts;
- self-loop session metadata;
- distilled writeback records;
- memory candidate records for Anamnesis ingestion.

Keep these as protocol contracts only. Runtime policy and storage implementations belong in upper packages.


## ANTI-PATTERNS

- Do NOT add effects, storage, or I/O here. Runtime helpers must remain pure folds or schema-local derivations.
- Do NOT import from other `@openomni/*` packages — protocol is the dependency leaf.
- Do NOT add authority or communication-kernel shortcuts here. Add the schema here, then implement semantics in `apps/openomni`.

## WHEN MODIFYING

- Adding a new error? Use `NamedError.create()` in `error/index.ts` and re-export from `src/index.ts`.
- Adding a new event? Use `BusEvent.define()` in the relevant domain and include the identity fields required by that event family.
- Adding a new message part? Add a variant to `Message.Part` in `message/index.ts`.
- Adding a new tool state? Add to `Tool.State` discriminated union in `tool/index.ts`.
- Adding new policy vocabulary? Extend `policy/row-verdict.ts` or `policy/permission.ts` and coordinate with the gate engine in `packages/agent` — policy additions are protocol vocabulary and ride the #467 gate.
- Adding a new storage sub-adapter interface? Add it as a named interface inside the `Storage` namespace in `storage/index.ts`.
- Adding a new IPC method or field? Update `ipc/` here first, then adapt the machines/openomni callers.
- Adding trace metadata? Update `trace/index.ts`; helper functions stay in the agent store plane.
- This package builds to `dist/` — run `bun run build` after changes.

_Edited 2026-08-10 per Owner-approved clean-room corpus (local docs/corpus, session record)._

_2026-08-19: gateway stage 0 (#706) landed `gateway/` — `Gateway.Deliver`/`Send` contracts (the historical lifecycle-control contract was removed by #969), `ReplyGrantRule` (retired by #1569: the reply door is authorized by the channels router's conversation binding), perimeter/conduct trust vocabulary (docs/gateway-design.md §2–§3). `openomni/messaging/schema.ts` re-exports the Send vocabulary from here; grant EVALUATION stays above protocol (contract boundary). The #969 request cutover above supersedes the original independent lifecycle control surface._
