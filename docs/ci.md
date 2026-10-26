# CI verification

## Selection and merge results

PR verification uses the PR merge result, not only its branch tip. The planner
compares the PR base with that tested commit using NUL-delimited Git paths,
including both endpoints of renames. A Git or topology error fails planning.

`script/topology.ts` owns workspace identities and permitted dependencies.
`script/ci-plan.ts` emits plan v2: `class`, logical `lanes`, `toolingTests`,
and the executable test `matrix`. Impact follows the broader permitted
dependency band, including test dependencies and transitive consumers. Mixed
changes take the maximum class in the table; scopes are unions.

| Class (ascending) | Trigger | Workspace tests | Tooling tests |
| --- | --- | --- | --- |
| `docs` | Root `*.md` or `docs/**` only | None | No |
| `desktop` | `apps/desktop/**`, `packages/ui/**` | Affected workspaces and consumers | No |
| `kernel` | Other packages or `apps/oni/**` | Affected workspaces and consumers | No |
| `tooling` | `script/**` except conformance contracts | Changed workspace lanes, if present | Two tooling shards |
| `global` | Protocol, manifests/lockfile, conformance contracts, CI/root configuration, malformed or unowned paths | All | Two tooling shards |

Package-local documentation retains workspace impact. Main pushes, schedules,
manual dispatch, and the planner's `merge_group` event mode select `global`.
The workflow trigger for merge groups belongs to the subsequent two-tier change.

Repository contracts run on **every PR**, including docs-only PRs. Consequently
Build also runs for documentation changes, but workspace tests and
static/dependency jobs remain omitted. Build/pack/restore deliberately remain
global: contracts and consumers require the complete validated dist archive.
The plan travels as `ci-plan.json` in the `ci-plan` artifact; only small
selection fields and the matrix travel through job outputs.

The **Clients (Rust)** lane runs on full plans and when a PR changes
`clients/**`, `packages/protocol/**`, `script/generate-machine-schema.ts`, or
`.github/workflows/ci.yml`. It rebuilds the protocol schema before formatting,
linting, and testing the `clients/` workspace. The setup action runs the sole
`bun install`; the job pins `rust-toolchain` by SHA and gates workspace coverage
with `cargo llvm-cov --fail-under-lines 100`.
Changes under `clients/**` also select the `machines`, `codemode`, and
`oniApp` TypeScript test lanes because they exercise the client over the wire.
Each of those matrix lanes installs the pinned Rust toolchain, caches the
`clients/` workspace, builds `oni-machine-client --release --locked`, and
exports `ONI_MCLIENT_BIN` before its tests. The local `bun run ci test --lane`
entry point builds the same binary when none is supplied.

## CI tiers and merge queue

CI has two tiers with the same job names and required `CI` status. The scoped PR
tier uses the change class and affected closure from `ci-plan.json`; docs-only
executable jobs are skipped. Tooling self-tests run only when `script/**`
changes.

The full tier runs on `merge_group`, pushes to `main`, nightly schedules, and
manual dispatch. It uses the global plan, all workspace lanes, and all tooling
self-tests. The merge queue trigger is required so its unchanged job contexts
report the required status.

Only pull-request runs are cancellable; queue entries and main pushes are never
cancelled. Dependency review and the patch-coverage gate are pull-request-only.
The lead applies the reversible ruleset requirement for `CI` with `gh api`
after merge; this workflow does not apply the ruleset.

## The lean PR gate (#1116)

Issue #1116 deleted the per-PR quality ratchet stack (census legs, exact
statement evidence, coverage ratchets, metrics/clone legs, receipts and their
baselines). A PR is admitted by:

- **Build** (`prepare`) and the restored `workspace-dist` artifact.
- **Static Analysis**: `lint` (Ultracite, including
  `complexity/noExcessiveCognitiveComplexity` at `maxAllowedComplexity: 21`,
  suppression-free) and `check-types`.
- **Dependency Rules** (`deps`): topology, dependency bands, guards,
  side-effects, tool lint, plus the relocated structural gates
  `check-dead-exports.ts`, `check-import-cycles.ts`,
  `check-journal-writers.ts` (one writer module per journal kind, #1252) and
  `verify-tsconfig-inheritance.ts`.
  Two shrink-only ratchets (#1343): `check-comment-residue.ts` pins per-file
  issue-number comment lines and `// ───` dividers across
  `packages/agent/src` as tight pins (growth and slack both fail; a pin above
  the actual count is lowered in the same PR), the package comment-to-nonblank
  ratio as a growth-only ceiling (adding plain code passes), the over-six-line
  JSDoc count as a tight pin, and an exact, documented structural-header
  allow-list; `check-deps.ts` additionally pins
  per-file direct agent-core responsibility tokens (`kernel.commit`,
  `createSessionEntityLayer`, `SqliteClient.layer`, ...) referenced from
  `apps/oni/src` code — comments and strings never count, a new app
  file starts at zero, and pin slack is judged only inside a git checkout
  (outside one the skip prints a NOTICE and growth is still judged).
- **Tests**: selected workspace lanes and, for tooling/full plans, the two
  scripts-tooling shards; `scripts-contracts` always runs.
- **Patch Coverage** (`patch-coverage`, PR-only): every changed executable line
  must be covered by the PR's own lcov evidence.
- **Dependency Review** (PR-only, on dependency-affecting plans).

Deep audits are scheduled, not per-PR. The weekly Quality Audit records debt
and maintains issues; the separate mutation campaign runs daily and on dispatch.
Neither workflow is a required check.

### Patch coverage

Every selected coverage test lane produces fresh LCOV (`coverage/lcov.info`)
and uploads it as `coverage-<key>`; `scripts-contracts` uploads
`coverage-scripts-contracts`. The `patch-coverage` job downloads every
`coverage-*` artifact into its own subdirectory (identical `script/coverage`
paths from different shards never collide) and runs
`script/check-patch-coverage.ts --base <PR base SHA> --glob
'coverage-artifacts/**/lcov.info'`.

The checker diffs `<base>...HEAD` with zero context, keeps changed/added lines
in `packages/*/src/**`, `apps/*/src/**` and top-level non-test `script/*.ts`,
and unions `DA:` records across every lcov file (maximum hits per line, with
each file's repo prefix inferred from the artifact path; an lcov whose
artifact path lost its workspace ancestor is refused). Before checking hits,
a TypeScript AST filter skips changed lines containing only imports,
bodyless exports (including re-exports), type aliases/interfaces/type-only
members, comments/whitespace, or closing body/list delimiters and terminators.
Any runtime token on the same line keeps that line gated; child-process
`import.meta.main` statements are not exempt. The verdict prints the number
of AST-skipped changed lines for each file, independently of LCOV hits.

Of the remaining changed lines, a line that every lcov reporting the file
knows with zero hits fails the gate; lines absent from the lcov intersection
never count. Bun reports every line of a never-executed function as
`DA:n,0`, braces and comments included, so a line that only such a lane
records while an executing lane omits it is still dropped rather than
reported as uncovered. The AST filter additionally handles Bun zero-hit
import/type headers and closing delimiters present in every reporting lane.
A gated file with no `SF:` record in any lcov was never loaded by any test:
it fails with `<path>: no coverage record` unless type-stripping its source
emits zero executable lines (pure type-only modules; `.d.ts` is outside the
gate entirely). There is no baseline and no ratchet: the gate is scoped to
the PR's own diff.

Skipped or failed test lanes skip the gate rather than passing it with partial
evidence; the fan-in `CI` gate then rejects the unexpected skip on executable
pull requests.

## Quality Audit

`.github/workflows/quality-audit.yml` runs weekly (Monday 05:17 UTC) and on
`workflow_dispatch`. It is never a PR gate or a required check. Its matrix uses
`script/ci-plan.ts`'s full plan plus `scripts-contracts`, and executes each lane
through `bun run ci test --lane <key>` rather than maintaining another test list.
Each coverage lane runs Bun LCOV once; separate artifacts retain both tooling
shards. All lanes must succeed before the audit can publish issues.

`script/quality-audit.ts` writes the Zod-validated `quality-audit.json`:

| Measurement | Tool and meaning |
| --- | --- |
| Absolute line coverage | Bun LCOV, unioned across the same lanes as CI; per-file covered/executable denominators, with unloaded production/tooling sources explicitly reported as missing records |
| Cognitive complexity | The pinned Biome engine used by Ultracite, JSON reporter, `noExcessiveCognitiveComplexity` above 21; `--only` also measures the two lint-override files |
| Cyclomatic complexity | TypeScript 5.9.2 AST function walker `oni-typescript-function-metrics-v1`; one plus branch, loop, catch, case, conditional-expression and short-circuit decision nodes; exclusive maximum 22 |
| Halstead difficulty | The same function walker counts TypeScript operator and operand tokens and computes `(distinct operators / 2) * (total operands / distinct operands)`; exclusive maximum 80 |
| CRAP | `cyclomatic^2 * (1 - coverage)^3 + cyclomatic`, where coverage is the function's fraction of covered LCOV `DA` lines; exclusive maximum 25 |
| Clones | Pinned jscpd, separate production and test configurations, at least 5 lines and 50 tokens; fixtures, declarations and generated output excluded |
| Type census | Surviving `check-types-census.ts`, preserving site kind and owned/foreign origin |
| Mutation | Link to `quality-mutation.yml`; no second campaign or inferred completion |

Coverage totals count uncovered executable lines, or one finding for an unloaded
file whose executable denominator is unavailable. Complexity counts violating
functions, cyclomatic/Halstead/CRAP count functions at or above their exclusive
contract bounds, clones count both endpoints, and types count census sites.
Python is included in clone scans, not Bun coverage or TypeScript function
metrics. `script/conformance/quality-contract.json` pins the metric algorithm,
TypeScript version, LCOV coverage interpretation and thresholds.

`script/quality-audit-issues.ts` uses `gh` with parsed JSON, creates the missing
`quality-debt` label, and maintains exactly one issue: the rolling
`quality: audit summary`, updated (or reopened) in place and never duplicated.
Its body carries the previous and current totals per kind, the regressions since
the previous summary's head, the fifty highest finding counts by file, and the
fenced JSON totals the next run compares against. The publisher never creates,
reopens, or closes any other issue: the earlier per-file and
`quality: regression` issues reopened after every hand close and were retired as
noise. The artifact contains the complete findings. Malformed history and
incomplete measurements stop publication, not reset it.

Local preview after building:

```bash
bun run script/quality-audit.ts --dry-run
```

This measures lint, clones and census, reads downloaded LCOV under
`quality-audit-input/coverage-<lane>/lcov.info`, and prints the audit plus planned
issue operations without invoking `gh`. With no GitHub reads the preview assumes
first-run state. Missing lanes are explicitly marked incomplete and cannot be
published; copy fresh local lane LCOV or download the workflow artifacts for a
complete preview. `--publish` is reserved for the scheduled workflow's issue-write
token. Measurement findings are recorded, not a debt ratchet; tool failures still
fail the run. Audit artifacts are retained for 30 days.

## Operations

Partial workflow reruns (`gh run rerun --failed`) are supported; the
patch-coverage job re-downloads the run's `coverage-*` artifacts. The known
full-rerun reason is the artifact-service 403 flake class tracked by
actions/upload-artifact#560.

## Execution

The shared setup action installs Bun 1.4.1, pinned in `package.json`,
and uses `bun install --frozen-lockfile`. Test results and coverage are not
cached. Alarm monitoring requires Bun >=1.4.0 for its built-in PTY support;
unsupported runtimes refuse app construction.

The Build job creates workspace `dist` artifacts once per run. Typechecking and
test lanes restore the same archive and reject missing outputs. Workspace tests
run in separate jobs with their own files, ports, and process environments.
Tests do not wait for unrelated lint or typecheck jobs. Machine integration
uses Python 3.12.

The codemode browser recipe tests (#1275) need playwright with Chromium and
an Xvfb display. `.github/actions/browser-prerequisites` is the one owner of
that install block; the CI codemode lane, the Quality Audit codemode coverage
lane and every `quality-mutation` shard (whose green-baseline run executes the
whole suite) consume it. A scheduled workflow that skips it fails before any
measurement: the audit lane with `ModuleNotFoundError: playwright`, the
mutation shards with `baseline test selection is not green`.

The oni app media tests encode real H.264 clips and sample their frames
through a machine daemon, so they need ffmpeg (with libx264) and ffprobe.
`.github/actions/ffmpeg-prerequisites` installs them from apt and fails when
the encoder is missing; the CI `oniApp` lane, the Quality Audit `oniApp`
coverage lane and every `quality-mutation` shard consume it.

`script/check-effect-boundaries.ts` is the fail-closed boundary gate. It scans tracked and non-ignored untracked TypeScript under `apps/`, `packages/` and `script/`, resolves Effect runners through imports and repository re-exports, and permits execution only in `apps/oni/src/cli/main.ts` and `apps/oni/src/gateway.ts`. It also rejects Effect imports in protocol/UI/desktop/tool surfaces, forbidden excluded-package dependencies and Promise twins; the runner-site JSON (`script/conformance/effect-runner-sites.json`) is a shrink-only ratchet whose live rows are reported without failure and whose stale rows fail. Ratchet rows may name only non-production sites (`packages|apps/<ws>/test|bench/...` or `script/*.test.ts`); a production `src/` row is `R2_INVALID_ALLOWLIST`, so production runners outside the two app edges always fail. The remaining test/helper/bench rows are owed to W5 #1113 (zero target).

`script/scripts-lanes.ts` is the explicit recursive test manifest. Its contract
test rejects missing, duplicate and newly unassigned `script/**/*.test.ts` files.
`scripts-contracts` contains topology, CI planning/execution, patch coverage,
tsconfig inheritance, store contracts and repository-consumer tests; its
command also runs dead-export, dependency and import-cycle self-tests. `scripts-tooling` contains the surviving mutation
runner, quality-plan/inventory/receipt and type-census self-tests. It runs only
when `toolingTests` is true, as two explicit matrix partitions packed by their
measured heavy hitters. Contract tests reject unassigned or duplicate files
across partitions and verify the actual commands select every recursive test
exactly once. `scripts-tooling-1` also runs the Python analyzer self-tests
(`pythonSelfTests` in `script/scripts-lanes.ts`, an explicit manifest its
contract test checks against `script/**/{test_*,*.test}.py`) directly under the
pinned Python.

Python quality tools are installed from
`script/conformance/quality-python-requirements.txt` under Python 3.12.12.

Full mutation runs in the explicit `quality-mutation` manual-dispatch
workflow (`gh workflow run quality-mutation.yml --ref main -f pilot_limit=0
-f shard_count=8`), not in PR admission; its nightly schedule was removed on
2026-10-14 after a month of runs that completed 0 of 8 shards each night, and
returns only once a dispatch has completed a full campaign receipt (#945). It retains failed/incomplete process evidence
and fails closed until a complete campaign exists; a complete campaign is
recorded as one measurement receipt (`current.json`) whose findings are the
surviving mutants, with no baseline to ratchet against. Candidates come only
from production, tooling and migration sources: test, fixture and benchmark
files are censused but never mutated. A mutant whose test batch hits the
suite timeout is killed by non-termination, not infrastructure. A PR pilot is
never reported as zero survivors.
The `--mutant-memory-mb` option defaults to 6144 MiB and caps only candidate test children on Linux (`prlimit --as`, with `ulimit -v` fallback; Darwin runs unwrapped), recording abnormal exits of mutated code with missing or truncated JUnit as `killed`/`resource-exhaustion` after green selection.
Campaign setup first verifies once that the cap wrapper can start Bun; failure is infrastructure and preserves the wrapper's stderr, never a mutant kill.
Original-source Python probes also run under the cap for protection, but any non-green probe remains `infrastructure`/`baseline-probe-not-green`.

The TypeScript/JavaScript mutation runner builds a campaign-scoped reach map
before candidate execution. Files recorded in the green baseline's native JUnit
run against instrumented original sources, and reached sites select the tests
for each candidate. The baseline still receives every inventoried test path;
Bun's package configuration decides which files execute. Ignored files remain
in the source/candidate inventory, not in the reach execution list. Failed
probes preserve their test identity, process output and JUnit in the failure
receipt, and cleanup removes the reach worktree's Git registration. The map binds
the execution tree, candidates, test list, source hashes and site identities.
Block-owned statement probes use entry points before the original statement,
not a wrapper around it. This preserves Bun's derived-constructor initialization;
the marker also records entry when `super()` throws. Instrumented sources stay
strict-compilable and free of compiler `any`: the probe loads `node:fs`
through the typed `process.getBuiltinModule`, and expression sites on `&&`,
`||`, `??` or `!(...)` conditions descend to the leftmost operand while literal
comparison operands move to their comparison, and a `switch (true)` or
`switch (false)` discriminant becomes an entry marker on the switch statement,
because a comma probe around a logical condition or literal discriminant would
erase every type narrowing it provided (the failure behind the red
`typed-facade-types` reach test in #1049). Mutation
replacements and candidate identity are unchanged.
An unreached candidate is `noCoverage`, not killed: it produces no candidate
test or JUnit receipts. Python retains its per-candidate probe. Source restoration,
cleanup and complete campaign receipts remain required. Passing the runner's
tests does not establish a complete campaign or zero surviving mutants.

Candidate compiler validation uses a campaign-owned persistent worker over the
frozen execution tree. Every affected native project and the inventory fallback
remain checked; only projects whose complete frozen source membership excludes
the changed file reuse baseline diagnostics. Requests are processed in bounded
project-first batches of eight, while the worker retains at most one
incremental checker at a time. Candidate batches stop at source-path
boundaries, preserve request order, and canonicalize physical execution roots
so workspace package aliases cannot hide consumer diagnostics. Baseline
validation and `--typecheck-root` remain fresh full checks. `compilerProof`
records the candidate/source/configuration identities, native diagnostics and
per-project `frozen`, `cold` or `incremental` modes separately from actual
subprocess `receipts`. It is not an independent process exit receipt.
Compiler failure is infrastructure, and workers terminate before source cleanup.

Ownership is handwritten `.ts`, `.tsx`, and `.py` under `packages/*/src|test`,
`apps/*/src|test`, and `script/`. Handwritten declarations remain type inputs;
`dist`, dependency trees and generated directories never contribute findings.

`CI` is the stable completion check. It runs even after upstream failure and
rejects failed, cancelled, missing, or unexpectedly skipped jobs. Only skips
justified by the plan and event are accepted; contracts remain required for
docs-only/empty plans, and patch coverage is required on executable pull
requests. Configure the repository ruleset to require `CI`; adding the workflow
does not itself change GitHub branch protection. Benchmark checks are
post-merge checks and must not be required for PR admission.

## Desktop smoke

The desktop lane includes built-output CSP/preload contracts in its Bun tests and
one Playwright production-build smoke when `desktopApp` or `ui` is selected.
Locally, build first and run `mise exec bun@1.4.1 -- bun run --cwd apps/desktop test:e2e`.
On Linux the command must run under `xvfb-run -a`; macOS can run it directly.
CI reuses the prepared `workspace-dist.tar` and caches Electron's binary only in
this smoke job.

## Local reproduction

Use the pinned Bun version, a clean build, and the same commands as CI:

```bash
b() { mise exec bun@1.4.1 -- bun "$@"; }
b install --frozen-lockfile
b run ci build
b run script/ci-plan.ts --full > ci-plan.json
b run lint
b run script/check-topology.ts
b run script/check-deps.ts
b run script/check-comment-residue.ts
b run script/check-import-cycles.ts
b run script/check-dead-exports.ts
b run script/verify-tsconfig-inheritance.ts
# Test lanes (fresh lcov lands in each workspace's coverage/):
b run ci test --lane agent
b run ci test --lane scripts-contracts
# Patch coverage over the local evidence:
b run script/check-patch-coverage.ts --base origin/main \
  --glob 'packages/*/coverage/lcov.info' --glob 'apps/*/coverage/lcov.info' \
  --glob 'script/coverage/lcov.info'
```

The planner accepts `--base <full-SHA> --head <full-SHA>` for a local change
comparison. Save its JSON output and pass the path to
`bun run ci check-types --plan <file>`. On GitHub non-PR events the planner
intentionally selects everything.

`bun test --timeout 15000` remains a useful local test command, but is not
equivalent to all CI gates. `bun run ci test --lane <key>` matches a CI lane.
Do not use a cached Turbo test result as evidence that a fresh coverage report
was produced.

## Benchmark references and diagnostics

Benchmark collection validates its repeat-count input before running samples.
Its p50 and p95 describe the distribution of per-run means, not operation-level
tail latency. When a workload changes meaning, review its metric identity and
comparison reference rather than silently accepting a different measurement.

Every Benchmark event (PR, main push, schedule, dispatch) uses one same-runner
paired admission gate. Accepted `gh-pages` history supplies the exact latest
accepted 40-character commit SHA, not cross-runner comparison timings. A detached
reference worktree uses the same head-pinned Bun toolchain and its own frozen
lockfile dependencies; protocol declarations are built in both worktrees.
Each repeat measures reference/head serially, reversing order on even repeats.
Both sets use the canonical summarizer: head requires all 22 metrics, while
`--reference` accepts a nonempty subset of the head contract that must be identical
across reference runs, without foreign or duplicate metrics. Only shared metrics
are gated; head-only metrics are reported as `new (no reference)`, and reference-only
metrics remain errors. Missing history and invalid commit IDs fail closed; there
is no bootstrap or historical-timing fallback.

`check-benchmark-regression.ts --accepted-commit <accepted.js>` validates and
prints the accepted SHA. `--prepare-reference <reference-statistics.json>
<accepted.js> <measured-reference-sha> <head-sha>` verifies that identity and
writes `bench-results/reference.json`: exactly one freshly measured reference,
using unrounded p50 values. The normal comparison command receives head
statistics and that file. The workflow fixes the limit at 20%, with zero
historical noise band because there is only one reference. A slowdown strictly
above 20% in even one shared metric fails. An Owner-applied `benchmark:accept-baseline` label lets the PR gate pass with `ACCEPTED` rows. After merge, the Owner runs `gh workflow run benchmark.yml --ref main -f accept_baseline=true` to publish the new accepted reference. Scheduled runs never accept baseline resets. This is stricter than both the former PR
20%-plus-historical-two-sigma gate and the main publisher's 50% alert.

Only successful paired comparisons permit main push/dispatch history storage;
PRs are read-only, and scheduled runs do not publish. The publisher stores the
original head summary without a second cross-runner alert decision. Accepted
references can advance; this is not a fixed long-term absolute performance
budget. Raw head observations remain in `bench-results/runs`, with fresh
reference observations in `bench-results/reference/runs`; neither is normalized.
Artifacts also retain accepted history, both summaries, exact revision IDs,
Bun/runner details and measurement order. Reference metadata binds both commits
and SHA-256 hashes of accepted history and fresh reference statistics; the gate
receipt hashes the head statistics and prepared reference including its metadata.

Memory regression guards run independently, so their failure does not discard
completed benchmark samples or skip the comparison. Coverage, selection, and
benchmark artifacts are retained for 14 days, including available partial
results on failure. Local model/cache/auth and packaging tests must use
test-owned paths, not operator configuration or shared release staging.
