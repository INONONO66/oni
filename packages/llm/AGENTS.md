# packages/llm

Created 2026-10-13 (#1352, branch `epic1356/1352-llm-package`).

The model-call layer (`@openomni/llm`): provider resolution and adapters over the AI SDK, one streaming attempt per invocation, stream-event processing into protocol messages, usage accounting, credential storage, and the pure failure classifier. Extracted from `packages/agent/src/model/` (the #1246 fold reversed; `Retry.decide` stayed in the core as `core/loop/retry.ts`). The dependency direction is reversed from the pre-#1246 package: `packages/agent` declares the port (`Core.Llm`, `Core.LlmPort`, `Core.LlmSink`, `Core.RunInput`, `Core.LlmRunFailure`, `Core.FailureClass`) and never imports this package; only `apps/openomni` binds `makeLlmService()` to `Core.Llm` at composition (`src/runtime.ts`).

Vocabulary: `llm` is the call layer; `Model` only as protocol `Model.Ref`; `Provider` is a package-internal namespace (not exported).

## STRUCTURE

```
src/
├── index.ts        # public surface: errors, classifyFailure, makeLlmService, Auth, ModelsDev, run
├── services.ts     # makeLlmService(authFilePath) — the LlmPort value the app binds
├── port.ts         # FailureFacts / FailureClass / ProviderReason (mirrors the core port shape)
├── classify.ts     # classifyFailure: aborted | overflow | retryable | terminal; NEAR_WINDOW_RATIO
├── run.ts          # one Processor attempt (maxRetries: 0, isStepCount(1)) over the resolved SDK model
├── errors.ts       # LlmError union; LlmOperationFailure carrier; LlmRunFailure
├── error.ts        # decodeLlmFailure / coerceApiError boundary decoders
├── header-delay.ts # retry-after header parsing (the delay facts the classifier reports)
├── sink.ts         # projected observation sink
├── model/          # catalog schema, models.dev snapshot loader, auth file path
├── provider/       # Provider.resolveModel, proxy listing, SDK model construction, stream transform
├── processor/      # stream-event -> message-part fold, tool bridge, step accounting
├── auth/           # credential storage (atomic 0600 writes)
├── message/        # protocol message -> SDK model message rendering
└── token/          # usage tracker and schema
```

## DEPENDENCIES

`@openomni/protocol` only, plus `ai@7.0.93`, `@ai-sdk/anthropic@4.0.49`, `@ai-sdk/openai@4.0.60` (exact pins, same majors as the desktop console) and `effect@4.0.0-rc.118` — enforced by `script/check-deps.ts` and `script/topology.ts`. Consumer: `apps/openomni` only; `packages/agent` must not depend on this package.

## RULES

- One attempt per invocation: `run()` performs exactly one Processor attempt; the core loop owns retry scheduling, the 3-attempt cap, the instant-failure streak, fallback, and overflow-to-compaction. `classifyFailure` is pure and decides only the kind (and `afterMs`/`instant` for retryable).
- Overflow is declared (`contextOverflow`), text-matched, a normal stop whose input + cacheRead exceeds the window, or a length stop with zero output at >= `NEAR_WINDOW_RATIO` of the window. Missing usage never reclassifies.
- Usage accounting is provider-plus-local with `reported | estimated | unknown` provenance; a reported numeric 0 is authoritative. Auth storage writes atomically at mode 0600 and never reads env — the credential path is injected.
- Do NOT add provider-specific logic at call sites, reintroduce SDK retries/`maxSteps`/zero-defaulted usage counts, or import anything from `@openomni/agent`.
- `src/` keeps the consumer lib floor: never raise `lib` in `tsconfig.json` (sources check under ES2020; the test tree runs at ES2022 via `tsconfig.test.json`).
- Tests run Effects only through `test/helpers/runner.ts`; `test/helpers/native.ts` delegates to it. The shared 7-signature `ai` mock lives in one place: `test/helpers/retry.ts` (`sdkError`), consumed by `script/effect-error-contract.test.ts` too.
