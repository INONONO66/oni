# PROJECT KNOWLEDGE BASE

PR stamps: each PR adds ONE new file `docs/agents-stamps/<issue>-<slug>.md` holding its one-line stamp (format in `docs/agents-stamps/README.md`); never edit a shared line — `docs/agents-stamps.md` is the frozen pre-#1433 ledger and AGENTS.md itself never carries stamps.
Keep that stamp current when editing (doc-state sync law).

## OVERVIEW

Project renamed on `rename/oni` (#1620, 2026-10-21): the repository, the
kernel app (`apps/oni`), every `@oni/*` workspace package, the `oni` bundle
and binary, `~/.oni`, the `ONI_*` environment family and the service names
all carry the name `oni`. Nothing reads the old name; frozen history
(`docs/agents-stamps.md`, `docs/agents-stamps/`, `.omo/`) keeps it.

Benchmark admission updated on `fix/benchmark-paired-reference-20260914`: every event measures the latest accepted SHA and head on one runner in alternating serial order, with separate frozen dependencies and canonical 14-metric summaries. The sole 20% gate uses a fresh one-reference history (zero historical noise band); only passing main push/dispatch runs publish original head timings. Raw paired observations and hashed provenance remain artifacts. An Owner-applied `benchmark:accept-baseline` label lets the PR gate pass with `ACCEPTED` rows. After merge, the Owner runs `gh workflow run benchmark.yml --ref main -f accept_baseline=true` to publish the new accepted reference; scheduled runs never accept baseline resets.
See `docs/ci.md`; hosted execution and landing remain parent-owned.

Native coverage merge correction on `fix/quality-lcov-union-20260914`: executing
lanes contribute the union of observed DA lines rather than their intersection.
Saved PR #1068 receipts reproduce the lost-positive-evidence defect; regression
tests retain uncovered-line refusal and the corrected replay reports no growth.
Full-codebase zero debt and complete mutation are not established by that replay.

Native mutation throughput updated on `fix/mutation-reach-integration-20260914`:
TypeScript/JavaScript candidates share one campaign reach map and execute only
tests that reached their original sites. Unreached candidates retain `noCoverage`
without candidate test receipts; Python retains its existing probe. The 112-test
runner suite passed, but a complete mutation campaign is still outstanding.

Reach discovery corrected on `fix/mutation-reach-e2e-20260914`: green baseline
JUnit supplies the executed test files, retaining Bun's package ignore rules
without removing source or candidate inventory. Probe failures retain process
and JUnit evidence; failed reach copies are unregistered during cleanup.

Statement probes corrected on `fix/mutation-statement-probes-20260914`:
block-owned statements retain their lexical position, including `super()`
with TypeScript parameter properties. Entry markers precede overlapping
expression probes and still record calls whose base constructor throws.

Mutation compiler reuse on `perf/mutation-incremental-typecheck-20260914`:
`quality-mutation-input.ts` owns shared cold compiler/input operations;
`quality-mutation-compiler.ts` owns the persistent worker and one retained
incremental checker. Candidate proof is separate from process receipts. The
bounded project-batch implementation caps requests at eight, canonicalizes
physical execution roots, and preserves request/proof identity and fallback
ownership. The final regression run passed 129 tests across five files. A real
16-candidate non-campaign receipt completed two batches (241.7s then 120.8s),
matched cold diagnostics at indices 0, 8 and 15, and reported
`originalRestored:true`. Full campaign completion and six-hour feasibility are
not established.

Oni is a single-Owner Agent OS: one Resident delegates through durable contracts and evidence, not self-report. The repository contains core packages, one deployable kernel app, and an Electron console (`apps/desktop`) with app-owned AI SDK chat state and shared UI presentation. Target contracts live in `docs/core-model.md`, `docs/kernel-contract.md`, and `docs/machines-and-delegation.md`; `docs/implementation-status.md` is authoritative for current wiring.

## STRUCTURE

```text
oni/
├── apps/
│   ├── oni/        # kernel app: eleven bundle directories under src/bundles/, gateway composition
│   │   └── src/bundles/ # alarms, approval-policy, compaction, core-policy, delegation-policy, hooks-json, messaging, prompt, provision, resident, tools
│   └── desktop/         # Electron console: shell/build pipeline plus app-owned AI SDK chat state
├── packages/
│   ├── protocol/        # Zod schemas and cross-package contracts
│   ├── agent/           # durable sessions, stateless runAgent loop, executor, policy gate, stores, llm port
│   ├── llm/             # model-call layer: providers, stream processor, accounting, failure classifier
│   ├── machines/        # raw list/get/fs/exec/runCode/pty WHERE endpoint + ipc transport
│   ├── codemode/        # code facade, machine handles, per-tenant interpreter runner
│   ├── channels/        # channel drivers and perimeter gateway router
│   └── ui/              # shared console presentation and design system
├── clients/             # Rust cargo workspace for machine-side clients (own Cargo.lock, outside the Bun workspace)
│   ├── protocol/        # oni-protocol: Rust types generated at build time from packages/protocol/schema/machine
│   └── machine-client/  # oni-machine-client: the mclient binary (version + CLI skeleton in #1623 P1)
├── script/              # conformance and repository gates
├── turbo.json
└── package.json
```

## DEPENDENCY GRAPH

<!-- BEGIN GENERATED TOPOLOGY -->
<!-- Generated by script/generate-agents-deps.ts from script/topology.ts. Do not edit. -->

Read `X <- Y` as Y may depend on X.

```text
protocol <- agent, llm, machines, codemode, channels, apps/oni, apps/desktop
agent <- channels, apps/oni
llm <- apps/oni
machines <- codemode, apps/oni
codemode <- apps/oni
channels <- apps/oni
ui <- apps/desktop
```

| Workspace | May depend on |
| --- | --- |
| `protocol` | none |
| `agent` | protocol |
| `llm` | protocol |
| `machines` | protocol |
| `codemode` | protocol, machines |
| `channels` | protocol, agent |
| `apps/oni` | protocol, channels, agent, llm, machines, codemode |
| `ui` | none |
| `apps/desktop` | protocol, ui |
<!-- END GENERATED TOPOLOGY -->

`script/check-deps.ts` is the executable contract. Product meaning is composed in `apps/oni`; core packages remain independently consumable primitives.

## PACKAGE OWNERSHIP

| Package | Owns | Must not own |
| --- | --- | --- |
| `packages/protocol` | Schemas, wire contracts, pure folds | I/O, storage, product decisions |
| `packages/agent` | Generic durable-session mechanics over its store facts, stateless loop, and compaction; the generic policy gate (`src/core/gate/`); handle-scoped catalog/session-file stores, action hash chain, decision facts, and activation fence CAS (`src/core/store/`); the model-call port and retry decision (`src/core/llm.ts`, `src/core/retry.ts`); bus and scoped observation (`src/observation/`) | Product-specific session identity, routing, lifecycle policy, or authority decisions; provider adapters or the `ai` SDK (that is `packages/llm`'s) |
| `packages/llm` | The model-call layer behind the core port: provider resolution and adapters over `ai@7.0.93`, one streaming attempt per `run`, stream-event processing, usage accounting, credential storage, the pure `classifyFailure` | Retry scheduling, attempt caps, fallback, compaction, or any `@oni/agent` import |
| `packages/machines` | Machine attachment, confined fs, exec and injected code wire; framing and bidirectional transport (`src/ipc/`); the structural host/daemon contracts code mode consumes | Enrollment policy, kernel policy, model rendering or product judgment |
| `packages/codemode` | Code facade (`createCodemode`), machine object handles, per-tenant Python interpreter and cell `run/peek/stop` lifecycle, code-mode prelude, codemode errors and call routing | Kernel policy, ledger state, model rendering, machine transport or enrollment |
| `packages/channels` | Drivers over the agent-messenger SDK transport (each SDK subpath imported only by its provider's seam file, `sdk.ts` for the bot and `owner-sdk.ts` for the Owner account, #1569) plus perimeter routing, physical request correlation, identity-keyed delivery (`<platform>:<identity>` routes) and admission; the channel-facing perimeter stores (`src/store/`) | Session content or product execution; the SDK's own credential store |
| `apps/oni` | Product composition: Resident, gateway, delegation, code mode, boot/shutdown | Reimplementation of package primitives |
| `apps/desktop` | Electron shell: main/preload/renderer build pipeline, window security defaults, the gateway endpoint resolved from env in main and handed to the renderer over one `contextBridge` call; AI SDK chat state and the gateway transport; client state in one TanStack `Store` (`state/store.ts`: sessions, tabs with strictly local history, active id, retained closed snapshots, collapsed project groups, per-session drafts) read through `useStore` selectors, and server state through TanStack Query (`state/queries.ts` mints every key; the only query is the gateway endpoint — the wire has no session-list method yet); native Menu → value-only preload → one disposed App subscription; app-owned places/icons, kind-grouped Sessions list, prompt-title lifecycle, search invocation/reveal, attention ordering and App-lifetime Chat cache; no mock data of any kind. Desktop owns the unified SessionCard state, phase-to-glyph mapping, and pinned/demand/report/residue/watch/rest attention kinds. | Kernel logic; anything beyond protocol contracts; **transcript presentation — that is `packages/ui`'s** |
| `clients/protocol` | Rust shapes generated from `packages/protocol/schema/machine` (the JSON Schema export of `Machine.*`, `index.json` first), `CONTRACT_VERSION` read from that index, the schema-validated `decode<T: WireRoot>` boundary with typed `DecodeError::{Schema, Shape}` (the only decode entry clients use), the one hand-written presence helper (`src/presence.rs`, keeps explicit `null` and empty collections on the round-trip), and the fixture tests over `packages/protocol/fixtures/machine` (every valid fixture decodes and re-serializes to the identical value, every invalid fixture is refused with `DecodeError::Schema`) | Hand-written wire shapes; any schema that does not come out of the generator; raw `serde_json::from_value` on wire input |
| `clients/machine-client` | The `mclient` binary: `--version` prints the client and contract version; `join`/`run` exist as CLI skeleton only and exit 2 with `not implemented in this phase` (#1623 P1) | Attach, transport, session sync or any daemon behavior until a later phase ships it |
| `packages/ui` | The renderer's UI package: tokens (`src/styles.css`), primitives, window chrome, the transcript's presentation (timeline, the three voices, tool rows and their folding, the composer, the approval tray), and the stable `Console` frame with generic `ConsoleContent`/`transcript` composition; `src/index.ts` exports only what apps/desktop imports, and `src/names.ts` is the single owner of every `data-ui` address. StatusGlyph owns generic tone/shape presentation and reference palette status tokens, never session phases. | Application places, project/session resolution, kernel logic or state policy. Touched Console contracts use generic transcript records; the lower-level Timeline sessionId adapter remains a legacy boundary |

## WHERE TO LOOK

| Task | Location |
| --- | --- |
| Shared schema or event | `packages/protocol/src/` |
| Session/store behavior | `packages/agent/src/core/store/` |
| Policy mechanism | `packages/agent/src/core/gate/` |
| Model/provider behavior | `packages/llm/src/` (port: `packages/agent/src/core/llm.ts`) |
| Session loop, executor, and compaction | `packages/agent/src/core/run.ts`, `packages/agent/src/core/turn.ts`, `packages/agent/src/core/gate/decide.ts`, `packages/agent/src/plugins/compaction/` |
| Channel driver or perimeter route | `packages/channels/src/` |
| Messaging identity, reply door vs `send_message`, SDK transport (#1569) | `docs/conversation-and-message-io.md`, `packages/channels/src/provider/slack/sdk.ts` |
| Raw machine endpoints | `packages/machines/src/` |
| Code mode and injected interpreter | `packages/codemode/src/` |
| Resident and app composition | `apps/oni/src/bundles/resident/index.ts`, `apps/oni/src/index.ts` |
| App policy, messaging, and prompts | `apps/oni/src/bundles/core-policy/`, `apps/oni/src/bundles/messaging/`, `apps/oni/src/bundles/prompt/` |
| App alarms and provision operations | `apps/oni/src/bundles/alarms/`, `apps/oni/src/bundles/provision/` |
| Production compaction strategy | `apps/oni/src/bundles/compaction/`, `packages/agent/src/plugins/compaction/` |
| Gateway and channel registration | `apps/oni/src/gateway.ts`, `apps/oni/src/channels.ts` |
| Contacts and the one send_message tool (#1258; `cli:`/`webhook:`/`a2a:` contact kinds, the missing-budget consent hook, #1569) | `apps/oni/src/bundles/messaging/send-message/`, `apps/oni/src/composition/{webhook,a2a}-contacts.ts` |
| First live run of messaging: declare a bot from the CLI, the readiness report, the runbook (#1600 lane R4) | `apps/oni/src/cli/channel.ts`, `apps/oni/src/cli/messaging.ts`, `docs/first-live-run.md` |
| A2A door, Linear and Owner-only providers, the Person `reach` grant (#1569) | `packages/channels/src/provider/{a2a,linear,instagram,kakaotalk}/`, `A2A_DOOR_ID`/`a2aRoster` in `apps/oni/src/channels.ts`, `grants` in `apps/oni/src/index.ts` |
| Delegation caps, deadline, and child replies (#1258) | `apps/oni/src/bundles/delegation-policy/` |
| Product tools and provisioning (no local fs/shell: every tool routes through the attached machine daemon, #1271; every tool is a removable bundle listed in `apps/oni/src/manifest.ts`, #1561) | `apps/oni/src/bundles/tools/<tool>/index.ts` (`file` bundle: `bundles/tools/file/`), `apps/oni/src/bundles/provision/provision.ts` |
| Machine wire contract as JSON Schema (#1623; `Machine.contractVersion`, the generator, the valid/invalid fixtures) | `packages/protocol/src/machine/contract.ts`, `script/generate-machine-schema.ts`, `packages/protocol/schema/machine/`, `packages/protocol/fixtures/machine/`, `packages/protocol/test/machine-contract.test.ts` |
| Rust client types and the mclient binary (#1623) | `clients/protocol/build.rs`, `clients/protocol/tests/fixtures.rs`, `clients/machine-client/src/main.rs` |
| Shipped-state truth | `docs/implementation-status.md` |
| Conformance/ratchets | `script/`, `script/conformance/` |

## CONVENTIONS

- ESM, strict TypeScript, Zod-first shared contracts, namespace-style public APIs.
- Effect-native runtime packages; protocol/ui/desktop/tool bodies never import effect (script/check-effect-boundaries.ts).
- One enforcement layer per invariant; durable writes fail closed. Machine effects enter captured kernel `tool.pre` and daemon negotiated/offered capability/export enforcement; no app VFS policy layer.
- No deep package imports. Driver-band code stays on published protocol/IPC contracts.
- Product vocabulary avoids new `runtime`, `task`, and `envelope` nouns in protocol surfaces.
- Tests must use exact state/event completion rather than timing sleeps; behavior-sensitive failure paths must assert typed errors or messages.
- Baseline shrinkage is autonomous; baseline growth requires Owner sign-off.
- Reconcile before deletion and update implementation docs in the same PR.

## COMMANDS

CI selection and verification wiring inspected at `c9c53af0` (PR #1117),
2026-09-20; scheduled Quality Audit added for #1116 PR B. See `docs/ci.md` for dependency-aware PR lanes, full runs, and
fail-closed completion checks. Use Bun 1.4.1 as pinned in `package.json`;
monitor source handling requires Bun >=1.4.0 for built-in PTY support.

```bash
bun install
bun run build
bun run check-types
bun run lint
bun run lint:tools
bun run script/check-topology.ts
bun run script/check-deps.ts
bun run script/check-import-cycles.ts
bun run script/check-dead-exports.ts
bun run script/check-journal-writers.ts
bun run script/verify-tsconfig-inheritance.ts
bun test --timeout 15000

# PR patch-coverage gate (#1116): changed executable lines must be covered by
# the lane lcov evidence. Locally, point --glob at fresh coverage output:
bun run script/check-patch-coverage.ts --base origin/main --glob 'packages/*/coverage/lcov.info' --glob 'apps/*/coverage/lcov.info' --glob 'script/coverage/lcov.info'

# Weekly/manual Quality Audit preview (no gh calls; missing LCOV is reported):
bun run script/quality-audit.ts --dry-run

# Separate scheduled mutation campaign (quality-mutation.yml, never per PR):
bun run script/check-quality-python.ts
gh workflow run quality-mutation.yml --ref main -f pilot_limit=0 -f shard_count=8

# Reproduce one CI test lane:
bun run ci test --lane agent
bun run ci test --lane scripts-contracts

# Machine wire contract export (#1623): regenerate packages/protocol/schema/machine
# after a Machine.* schema change, or --check to refuse a stale export.
bun run generate:machine-schema
bun run script/generate-machine-schema.ts --check

# Rust clients workspace (clients/Cargo.toml; cargo on PATH, run by the
# Clients Rust CI job when clients/ or packages/protocol/ change):
bun run clients:lint
bun run clients:test
bun run clients:build

# Sole deployable app
bun run --cwd apps/oni dev

# Desktop console (Electron)
bun run --cwd apps/desktop dev
```

Dead-export shrinkage uses `bun run script/check-dead-exports.ts --update`.

The per-PR quality ratchet stack (census, exact statement evidence, coverage
ratchet, metrics legs) was deleted by #1116 in favor of the lean PR gate:
build, types, lint (including `noExcessiveCognitiveComplexity`), dependency
rules, tests, and the patch-coverage gate. Deep audits stay scheduled:
`quality-audit.yml` records absolute findings in one rolling `quality: audit summary` issue (never per-file issues);
`quality-mutation.yml` runs `run-quality-mutations.ts`, which requires a
complete campaign receipt, including restoration and cleanup proof.

## NOTES

- `apps/oni` is the kernel composition root. `apps/desktop` owns Electron and AI SDK chat state and imports `packages/ui`; its dependency band permits `protocol` and `ui`, not kernel implementation packages. It speaks to the daemon over the gateway's WebSocket rather than importing it: main resolves `ONI_WS_URL`, else `ws://127.0.0.1:<ONI_WS_PORT or 3000>/ws`, and `ONI_WS_TOKEN`, with the port default and the `/ws` path copied as literals from `apps/oni/src/config.ts` and `apps/oni/src/index.ts` and the source named at each — the dependency the console must not take is the reason the copy exists.
- The three Promise-side app modules (`composition/watch-sources.ts`, `composition/process-session.ts`, `provisioning/supervisor.ts`) form the app's declared Promise band (#1423): each head comment names the forcing API and the single Effect entry call; nothing else in `apps/oni` may take a Promise or callback shape for session work.
- `packages/channels` is the perimeter gateway; `apps/oni` injects delivery and observation ports. Conversation windows, send leases, and engagement lifecycles were removed in issue #943; ordinary sends use grants, egress budgets, idempotency, and physical request correlation.
- `packages/agent` coordinates generic session handles through `SessionHandleStore` and owns the durable facts in `src/core/store/`, while product-specific session identity, routing, and lifecycle policy remain in `apps/oni`.
- Shipped-state claims, including Stakes, effective authority, and connector consumers, belong only in `docs/implementation-status.md`; other docs define target contracts or historical context and defer to it.
- CI lives in `.github/workflows/ci.yml`; its Ultracite check is `bunx ultracite check --formatter-enabled=false .` (formatting disabled). Full formatting checks use `bunx ultracite check .`; the pinned baseline has existing formatter failures, recorded in `docs/SLOP.md`.
- #945 is a campaign ratchet, not a zero-quality closure claim. Named publisher/export/store measurements and type, complexity, clone, coverage, and scheduled mutation gates are separate from final zero at #973. E4 is required, not parked; #950 alone parks sandbox/egress hardening outside #930.
