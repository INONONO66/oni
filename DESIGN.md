# Publisher fixpoint redesign (2026-09-12)

## 1. Current algorithm and monotonicity

Baseline: fetched `origin/main` = `a2877746`; isolated worktree
`/Users/ino/Develop/openomni-ci-g12`, branch `ci/publisher-fixpoint`.
All execution uses `mise exec bun@1.4.1 -- bun ...` on Darwin arm64.
The prior report was read first. Its 680.99 s timing is historical; this run
independently reproduced its 79,580 initial queue. Unless marked prototype,
code citations below refer to this frozen baseline's line numbers.

### Actual work items

`script/check-census.ts:525-598` constructs one `Provenance`. The current file
has 4,552 lines, not approximately 1,700. Neither current main nor commit
`8c55e0e1` contains a `performIteration` function (checked with `rg`). The
closest actual operation is the dynamically growing FIFO drain at lines
593 and 597: it executes closures until the queue, including appended work,
is exhausted. There are two drains, not whole-AST fixpoint passes. The second
follows `nativeReady = true` and `dispatchEvents()`.

Each work item is a `() => void` closure, not an AST node. The same closure can
occur repeatedly. Items include propagation of one newly discovered points-to
pair, a watcher recomputing a property's flows or a call's targets/callbacks,
a scope-activation guard, and an event-dispatch scan.

The constructor walks each source file twice: `linkNode` builds static
module/scope links; `flowNode` seeds values, transfers, and watchers
(lines 585-592). `watch` always schedules its operation initially
(lines 901-905), even when there are no points yet. A call installs one
scope guard plus watchers on its expression, optional receiver, and every
argument (lines 1697-1752). Scope guards can also be queued by both initial
reachability and activation (`1015-1022`, `907-916`). Thus 79,580 is a historical
count of seeded closures, not 79,580 distinct AST nodes or a fixed constant;
its exact current composition is measured in section 2.

### Re-entry and growing facts

* `point(node, value)` adds a previously unseen pair, enqueues one transfer
  closure per outgoing edge and every watcher of that node (`885-893`).
  Repeated attempts at an existing pair return immediately.
* `flow(from, to)` adds a transfer edge once, synchronously propagates existing
  values, and leaves the edge to propagate future values (`894-900`).
* `watch` registers and immediately queues a closure (`901-905`). The watcher
  Set deduplicates registration by identity, not pending queue entries.
* `activate` records reachability, queues all scope watchers, and recursively
  activates previously unreachable linked scopes (`907-916`).
* `recordInvocation` adds callback/target facts and first-seen invocation sites;
  each new site schedules a whole event-dispatch closure (`1123-1153`).
* Spawn discovery can add a root even for an already imported/reachable source,
  then activate that source again (`2460-2507`).

Points-to sets, transfer edges, reachable membership, root membership,
callback targets, invocation sites, and registered callback sets only grow.
Their insertion order and the selected reachability root/chain are observable:
`censusInvocations` emits Maps/Sets in discovery order (`4180-4190`), and
`activate` can overwrite a reachable source's path when it becomes a spawned
root. Monotone membership therefore does NOT prove byte identity after queue
reordering or watcher deduplication.

### Branch classification is not wholly monotone

`activeBranch` first evaluates `missingOptionalReceiver` from current points
(`918-951`). All currently known receiver values lacking a property can stop
being decisive when another value arrives. This dynamic guard must remain live.
After it, the cached ACTIVE structural verdict is sound: `structurallyActive`
checks immutable ancestors, early returns/throws, literal true/false branches,
test-only CLI flags, and growing `import.meta.main` roots (`945-1011`). Only the
last structural input is mutable. A permanently inactive syntax branch can be
cached separately, but a root-gated inactive branch must be tested again.

`scope` separately climbs parents to the nearest function/source on EVERY call
(`286-290`). `declaration` unwraps and re-queries the TypeScript checker on EVERY
call (`688-697`); both are structural with an immutable program.

### Semantics and proof constraints

Read `docs/ci.md:139-149`: publisher negative findings and selected root plus
complete implementation sets cannot be unioned across root subsets. The
`8c55e0e1` message claims 15m49s -> 5m26s with byte-identical findings and
invocations, explicitly not cached inactive root verdicts. No sharding or
change in reachability/queue discovery order is proposed here.

Raw collector artifacts are not deterministic byte streams even without code
changes: `quality-measure.ts:38` embeds a random `mkdtempSync` inventory path in
the command; `:103` records elapsed duration. `quality-native-process.ts:22`
preserves that command in its receipt. Changing `check-census.ts` also changes
its inventory hash. The requested raw `cmp` commands were executed and their
failures are reported separately from census/findings/invocations comparisons;
no raw-receipt byte-identity claim is made.

Initial setup verification: install succeeded; `bun run build` succeeded
(6 tasks, 5 cached, 5.145 s). Two unmodified publisher runs and baseline census
tests run sequentially, without concurrent profiling workloads. Baseline 1 has
completed: 435.87 s wall (`/tmp/fp/base1.time`), collector exit 0.

## 2. Complexity and repeated work

This is not O(items x whole-AST passes). Initial graph setup is two AST walks,
O(N) excluding checker queries and seeding. Thereafter work is proportional to
new points-to pairs times their transfer/watcher fan-out, plus the work each
watcher recomputes. A property watcher rescans the ENTIRE current base points
set (`1024-1027`), so k successive additions can cause O(k^2) value visits.
There is no pending-operation coalescing. Call watchers similarly rerun their
entire callback/target/native-contract analysis (`1697-1747`).

More importantly, every new invocation site queues `dispatchEvents`
(`1153`), and native registration/emission processing invokes it synchronously
again (`1935-1965`). Each dispatch visits all registrations (`1457-1460`),
compares registrations to emissions (`1468-1478`), and executes native lifecycle
checks. Event contexts expand invocation chains and rewalk their owning AST
looking for preceding awaits (`1268-1327`). Root-dependent contexts cannot be
blindly memoized.

The decisive static-vs-dynamic join is listener removal:

* `dispatchEmission` scans ALL calls looking for removals, evaluating `path`
  and invocation contexts BEFORE rejecting non-removal syntax (`1530-1569`).
* `dispatchExternal` scans ALL calls once per supported lifecycle event name,
  evaluating `path` BEFORE rejecting non-removal syntax (`1604-1648`).
* Every `path` checks optional receivers and active branches, then climbs the
  scope parent chain (`2675-2676`). This explains the historical hot callback
  around line 1606 and TypeScript function/source/property predicates.

With C calls, R registrations, D dispatch invocations, E supported names,
this part approaches O(D R E C), multiplied by path/context costs, despite
almost all calls being permanently ineligible. A static candidate index makes
C the much smaller K of property-access removal calls. It leaves all dynamic
join predicates live. Generic kind-predicate memoization does not remove C.

Temporary instrumentation was outside inventoried roots in
`.quality-prof/census-instrumented.ts`, analyzing the unchanged baseline
inventory with ONLY `--class publisher` and the publisher leg's remaining
arguments. It counted initial enqueues by cause, both drain sizes, unique
closures, points/edges, scope/ancestor/checker calls and unique nodes, event
pair checks, and removal scans. The one instrumented run took 424.03 s and its
complete stdout is byte-identical to baseline (`/tmp/fp/frozen-comparison.log`).
Counters are in `/tmp/fp/counters.log`; temporary sources were archived to
`/tmp/fp/profiling-sources` and `.quality-prof` was removed before validation.

### Measured counts (one unmodified publisher analysis)

| Counter | Count |
| --- | ---: |
| Initial queue | 79,580 |
| Initial watch schedules | 55,046 |
| Initial transfer / points-watcher / scope enqueues | 9,998 / 6,184 / 8,352 |
| First drain / second drain processed | 214,218 / 56 |
| Distinct processed closures | 138,155 |
| All watch / transfer / points-watcher / scope / event enqueues | 59,031 / 86,884 / 50,256 / 14,809 / 3,294 |
| AST nodes in `flowNode` | 237,445 |
| All `walk` visits (including repeated owner walks) | 1,236,625,667 |
| `isFunction` wrapper calls | 7,944,060,726 |
| `scope` calls / unique input nodes | 1,362,163,594 / 16,865 |
| `scope` parent steps | 6,867,689,161 |
| `declaration` calls / unique input nodes | 2,057,595 / 109,587 |
| `activeBranch` calls / unique input nodes | 1,091,227,314 / 13,376 |
| ACTIVE cache hits | 1,090,799,336 |
| Optional-receiver false returns | 298,441 |
| Structural checks / ancestor steps | 129,537 / 795,708 |
| Conditional checks / if-statement checks | 795,708 / 137,800 |
| Early-exit checks / statements visited | 228,543 / 537,632 |
| Points attempts / added pairs | 200,519 / 120,223 |
| Transfer attempts / added edges | 264,469 / 107,420 |
| Scope activations | 2,846 |
| Call watcher executions / active executions | 75,093 / 41,132 |
| Property watcher executions / values scanned | 45,750 / 160,549 |
| Event dispatches / registration visits / emission pairs | 3,424 / 118,542 / 978,258 |
| Event context expansions | 4,661,024 |
| All calls / static removal candidates | 11,950 / 16 |
| External removal passes / call visits | 37,722 / 450,777,900 |
| Local removal passes / visits | 0 / 0 |

The instrumentation field `rootChecks` counts if-statement classifications,
not successful root lookups; the table names it accurately. Queue enqueue
counts sum to 214,274, exactly the combined drains. Rescheduling duplicates
exist, but 214 thousand work items are not the billions of operations here.
The negative-removal join alone performs 37,722 x 11,950 = 450,777,900 visits;
using all 16 candidates caps that same join at 603,552 visits without changing
its dynamic predicates. That is a structural bound, not a second measured
counter run. Most repeated classification is `scope`, not the already cached
ACTIVE ancestor walk. Symbol resolution is repeated but orders of magnitude
less frequent than parent-chain work.

Constructor phase times: link setup 0.576 s, flow/seed 2.732 s, first drain
218.366 s, native-ready dispatch/second drain 2.555 s, registration validation
0.021 s; total graph 224.250 s. The remaining 199.780 s of the instrumented
424.03 s is outside construction (program setup, later census analysis and
serialization), not unaccounted initial-queue passes. These counters and
phase times are from the same run; historical 242/680 s values are not mixed
into this breakdown.

## 3. Ranked redesign options

1. **Immutable removal-candidate index (specialized structural indexing / static
   join factorization).** Build an ordered subset of `calls` once, using the
   exact existing property-access + method-name predicate. Query that subset
   in BOTH removal joins, retaining the existing native owner, path, receiver,
   event name, listener identity and order checks. Expected saving: dominant
   C/K scan reduction; conservatively 25-70% wall if the historical 1606 hot
   callback remains dominant. About 12-20 production LOC. Risk: low. The AST
   and candidate order are fixed; roots, points and invocation sets may grow,
   but cannot make a non-removal call a removal. Queue order and the sequence
   of eligible calls are unchanged. Index-only frozen-input time was 235.48 s,
   with byte-identical complete census output.

2. **Memoize pure scope ownership; defer root-sensitive branch caching.**
   `scope(node)` depends only on an immutable parent chain. A WeakMap keyed by
   node identity preserves its exact result and does not retain old programs.
   The measured 1.362 billion calls over 16,865 nodes justified this additional
   small option. Seven added lines including the comment, one replaced return;
   low risk, no root/points invalidation. The combined frozen-input run took
   147.37 s versus index-only 235.48 s (37.42% further saving), with identical
   complete stdout. This and option 1 are the final recommendation.

   Separately splitting structural branch descriptors into always/never/root
   would take about 30-50 LOC plus tests. It must keep optional receivers live.
   The counters show under 0.8 million ancestor steps versus 6.868 billion
   scope steps, so this is rejected as low leverage here. Caching checker
   declarations/misses is also safe for the immutable program but deferred:
   2.058 million queries are not the dominant billions-scale work. No inactive
   branch, event context, receiver or checker result was cached in the patch.

3. **Semi-naive delta worklist / explicit dependencies.** Much is already
   present (points, transfers, watchers). Track newly added base values per
   property watcher and dependencies of event joins on receivers, invocation
   sites, reachability and roots; re-evaluate only affected joins. Expected
   saving: potentially 50-90%, but workload-dependent. About 200-400 LOC plus
   extensive tests. High risk: growing memberships are monotone but selected
   provenance and discovery ordering are observable; listener removal is a
   negative predicate. Pending-closure deduplication alone is not proven byte
   preserving. Rejected for this prototype because the smaller static index
   attacks the measured hotspot without altering the schedule.

4. **Generic per-SourceFile node-kind table.** O(N) preprocessing turns kind
   predicates into lookups but still visits all C calls in each query.
   Expected saving: 0-10%, possibly slower than an inline kind comparison.
   About 50-120 LOC. Low semantic risk, poor leverage. Prefer a semantically
   selective relation index rather than caching a boolean kind predicate.

5. **Topological initial queue ordering.** May reduce repeated value rescans
   for acyclic transfers; cycles and runtime event roots remain. Expected
   saving unquantified and likely modest after option 1. About 100-200 LOC.
   High byte-identity risk: first reachability witnesses, Map/Set ordering and
   native event readiness are observable. Monotone set convergence does not
   establish identical witnesses. Rejected.

Savings stated as expectations for unimplemented options are hypotheses,
not measured results. Only the selected index and scope cache were prototyped.

## 4. Prototype and proof protocol

The installed prototype adds one ordered `listenerRemovals` array, populates
it while `linkNode` collects calls, and switches the `some` and `filter` queries
to it. It deliberately retains the queries' existing syntax/native-owner guards
for minimal change and unchanged type narrowing. The scope cache leaves the
original parent walk and its function/source boundary semantics untouched on
a miss. No queue item, points propagation, root update, active verdict, or
result ordering has been changed. Production diff: 19 added / 3 removed lines;
regression tests: 32 added lines (11 generated cases).

Prototype citations: `script/check-census.ts:286-296` (scope cache), `:537`
(index), `:798-807` (candidate collection), `:1546` and `:1623` (queries).
New tests are at `script/check-census-native.test.ts:326-356`. Diagnostics on
both changed TypeScript files and both temporary analyzer copies found no
errors. An explicit source comparison confirmed that the installed analyzer
matches the frozen-input prototype exactly apart from relocated imports.

The strongest counter-case is a removal candidate that is initially inactive
or has unresolved receiver/callback identity, but becomes applicable as roots,
points and invocation edges grow. The index includes it BEFORE the first
drain and does not cache any dynamic verdict. Conversely a method named `off`
on a non-native receiver must not become a removal: the old native-owner guard
remains. Order-sensitive `.some` still sees exactly the same eligible calls in
the same order; skipped calls could previously only populate the safe ACTIVE
cache while eventually returning false. `eventContexts` has no graph mutations
other than that cache via `path` (`1268-1327`).

Additional deterministic runtime-backed tests cover `off`, `removeListener`,
`removeAllListeners`, DOM `removeEventListener`, a different receiver, a
mismatched event name, a removal after emission, a non-native lookalike method,
and native process-exit lifecycle removal. The existing late spawned-root and
optional-receiver regressions remain unchanged. No sleeps or polling are added.

Measurements are sequential: two unchanged collectors, unchanged census tests,
one instrumented baseline publisher, then the prototype against the exact
frozen baseline inventory, followed by the installed branch collector and tests.
The frozen-input runs distinguish algorithmic output identity from the
mandatory changed-source inventory hash. Complete stdout was compared using
`cmp`, not reconstructed or normalized. Actual branch collector receipts were
also compared raw, without changing timestamps, paths or hashes.

Both baseline runs have 37 findings, 37 schema records, 2,526 invocations,
424 aliases and no invocation/alias rows in `script/check-census.ts`. The
inventory has 1,132 source entries (`/tmp/fp/base1`, parsed summary only).

| Run | Publisher collector wall | Complete census stdout cmp to base1 |
| --- | ---: | --- |
| origin/main base1 | 435.87 s | reference |
| origin/main base2 | 452.19 s | identical |
| branch new | 143.07 s | differs ONLY in `inventoryHash` |

The collector is **67.78% faster** than the 444.03 s baseline mean (3.10x),
and 67.18% faster than the faster baseline. These three wall times use exactly
`mise exec bun@1.4.1 -- bun run script/quality-measure.ts collect --leg publisher
--output /tmp/fp/{base1,base2,new}`, timed with `/usr/bin/time -p`. They ran
without another census/test/build workload in this task. Each collector exited
0; each child census exited 1 because it reports 37 complete findings.

Supplementary isolated-implementation runs on the IDENTICAL origin/main
inventory used the publisher child arguments and the temporary analyzer entry
point, not the collector wrapper:

| Prototype | Wall | Complete stdout / inventory cmp |
| --- | ---: | --- |
| Removal index only (`/tmp/fp/frozen-new`) | 235.48 s | identical / identical |
| Index + scope cache (`/tmp/fp/frozen-both`) | 147.37 s | identical / identical |

`/tmp/fp/final-comparison.log` records all file comparisons. On the installed
branch, findings, invocations and schemas are byte-identical. Every other
census document field, including roots, configuration hashes, errors, aliases,
assets, dependency contracts and external event evidence, is equal as well.
The ONLY census-document difference is its inventory hash. The regenerated
inventory differs in exactly two rows: `script/check-census.ts` and
`script/check-census-native.test.ts`. Receipts differ in random inventory path,
new inventory digest, elapsed time and their corresponding stdout/hash fields.
There is no changed semantic finding or provenance row.

`/tmp/fp/new/inventory.json` was regenerated from the final files. A second
fingerprint after the build compared byte-identical (`/tmp/fp/final-inventory.json`).
Historical quality-baseline source hashes were not rewritten to falsely bind
old measurements to new code. `git grep -l` found no tracked file pinning the
baseline analyzer's actual SHA-256
`b72e59bb926cf20e96990f17913a35909516045254a248fdb07e8715a26ce4d1`;
no committed live inventory needed regeneration. All new proof receipts carry
the new inventory digest honestly.

The baseline mean is 444.03 s. `python3 /tmp/fp/compare.py base1 base2` executes
`cmp` for each file; `/tmp/fp/base-comparison.log` records the result. Full
`census.json`, findings, invocations, schemas and inventory are byte-identical.
Raw `publisher.json` and `publisher.process.json` differ ONLY at command array
index 7 (random temporary inventory pathname); `publisher.identity.json`
differs ONLY in `durationMs`. Thus the requested all-files raw determinism
premise is false even before changes. No byte-identity claim for these wrappers
is made. The owner subsequently accepted the semantic identity proof and
explicitly authorized shipping; see the shipping addendum below.

Baseline census tests: 63 pass, 7 fail, 627 assertions, 222.56 s. The exact
command was `mise exec bun@1.4.1 -- bun test script/check-census*.test.ts`, with
full output retained in `/tmp/fp/base-tests.log`. Deduplicated failures:

1. R3 Python thread start, inactive branches and cursors have separate effects.
2. R3 child Python source is rooted in its actual spawn invocation.
3. R3 unresolved process source and cursor identity are errors, not clean.
4. R4 suspended Python construction and partial next do not execute later segments.
5. R4 dynamic native triggers and unmodeled consumers stay incomplete.
6. helper-created generators retain distinct advancement identities.
7. durable filesystem discovery and Python operations use real files and rows.

The local `python3` is mise Python 3.13.15, whereas census requires 3.12.12;
failures return analysis exit 2 / `tool_version` instead of expected findings
or operation evidence. No test is skipped or weakened. Separately, all 11 new
boundary cases pass against the unmodified implementation (55 assertions,
31.62 s; `/tmp/fp/boundary-base-tests.log`). The initial attempt omitted the
leading `./` needed for Bun to select a hidden-directory test path and ran no
tests; the corrected explicit-path command ran once and passed.

### Final local validation

* `bun test script/check-census*.test.ts`: **74 pass, same 7 fail**, 682
  assertions, 194.40 s. Full output: `/tmp/fp/new-tests.log`. A parsed comparison
  confirms identical deduplicated failure-name sets on main and branch. All
  11 added cases pass. No tests were skipped or rerun to obtain a passing result.
* `bun test script/ci.test.ts`: **72 pass, 0 fail**, 265 assertions, 16.93 s.
* `bun run build`: **6/6 successful**, 18.507 s. Existing desktop chunk-size
  advice is a build warning, not a failure.
* `bun x tsc -p script/tsconfig.json`: **pass** against the completed build.
* `bun x ultracite@7.8.3 check --formatter-enabled=false .`: **pass**, 1,224 files.
* `bun run lint`: **pass** against the completed build (guards, side effects,
  dependency docs, Ultracite). `git diff --check`: **pass**.
* Markdown LSP diagnostics are unavailable: no `.md` server is configured.
  Both changed TypeScript files have clean diagnostics.

All commands above use the pinned mise Bun invocation. I initially ran tsc
and lint concurrently with rebuilding, which was incorrect: build deletes
workspace `dist` before recreating it and emits a temporary Electron config.
Tsc then reported missing `@oni/protocol` declarations, and lint reported
`noVar` on `apps/desktop/electron.vite.config.1789190744678.mjs:5`. These were
verification scheduling failures, not pre-existing source defects. No source
was changed or warning suppressed; both validators passed after build had
finished. Initial logs are retained (`/tmp/fp/tsc.log`, `/tmp/fp/lint.log`), as
are the successful post-build logs. The known seven Python failures remain.

### Shipping addendum (owner authorized the semantic identity gate)

The owner explicitly accepted complete frozen-input stdout identity and
installed findings/invocations/schemas identity, with expected regenerated
source inventory hashes and volatile receipt paths/durations. The initial
prototype commit `d3d297fa` was retained locally pending this authorization;
shipping now uses the same index and scope cache without changing freshness
validation or census semantics.

Two additional regressions are in `script/check-census.test.ts:19-49`, already
assigned to `scripts-tooling-2` in `script/scripts-lanes.ts:64`:

* Two adjacent event registrations publish different schemas. A removal before
  emission cancels one, while an adjacent removal after emission cannot cancel
  the other. Runtime prints only `other`, and census reports only `ready` as
  missing. Dropping a candidate or conflating callback identity would fail.
* `scope` is exported for direct testing without a test-only implementation.
  Two functions contain distinct statement nodes with the same syntax. The
  real parent getter records one read for the first query and none for the
  second; the other node still resolves to its own function. This asserts both
  actual caching and isolation, not merely equal output from recomputation.

`quality-results/inventory.json` was regenerated with the documented inventory
CLI and verified by that CLI. Its analyzer digest is
`1d000acddd3842c4e1c56e90970ea0d3eb4b0ede210f5f7f2c8a6ead61b3384b`.
The only tracked hash entry found by the requested search is the historical
`script/conformance/quality-baseline-lcov-bound.json:1841`; it is not rewritten:
`quality-ratchet.ts:110-129` uses it as unchanged-source evidence only for
UNMEASURED sources. Tooling plans remeasure the full inventory. Updating that
old measurement's hash without recreating its evidence would be incorrect.

### Measured before/after counters

A second temporary instrumented publisher-only analyzer used the exact same
counters around the final implementation. These are measured, not estimates.
The final run retained every census document field except the expected new
inventory hash. Instrumentation was archived under `/tmp/fp/ship` and removed
before lint. Its elapsed time is not used for the speedup claim because local
gate tests ran concurrently; the three isolated collector wall times above
remain the performance proof.

| Counter | Baseline | Index + scope cache |
| --- | ---: | ---: |
| Initial queue | 79,580 | 79,580 |
| First / second drain | 214,218 / 56 | 214,218 / 56 |
| Removal query passes | 37,722 | 37,722 |
| Removal candidate visits | 450,777,900 | 603,552 |
| Scope calls | 1,362,163,594 | 912,133,872 |
| Unique scope inputs | 16,865 | 16,865 |
| Scope cache hits | 0 | 912,117,007 |
| Parent-chain steps | 6,867,689,161 | 84,196 |
| Function-kind predicate calls | 7,944,060,726 | 6,849,513 |
| Active-branch calls | 1,091,227,314 | 641,052,966 |
| Declaration queries | 2,057,595 | 2,057,595 |
| Walk visits | 1,236,625,667 | 1,236,625,667 |

Queue sizes, scope identity cardinality and declaration work are unchanged;
only irrelevant candidates and repeated pure parent walks are eliminated.

### Shipping gates

All commands retain `mise exec bun@1.4.1 -- bun ...`:

* Combined census, quality-inventory, CI and scripts-lanes test command:
  **153 pass, same 7 Python-version failures**, 1,014 assertions, 218.02 s.
  New regression tests and inventory tests pass. Failure names match the
  baseline list exactly; no additional failures or skipped tests.
* Build: **6/6 pass**, 9.538 s, completed before typecheck.
* Script tsc: **pass**.
* Ultracite 7.8.3, formatter disabled: **pass**, 1,224 files.
* Full lint: **pass** (guards, side effects, dependency docs, Ultracite).
* Diagnostics: no errors; the existing deprecated `db.exec` test signature is
  an informational TypeScript hint, not suppressed.

Logs: `/tmp/fp/ship/{tests,build,tsc,ultracite,lint,counters-after}.log`.
The CI reference is the successful main run `34545253567` at `a2877746`:
Quality Static (publisher) **508 s**, Quality span **584 s** (earliest static
leg start through Quality completion), workflow total **672 s** (workflow
start through last job completion). These are GitHub job timestamps, not local
wall times. PR and merged-main results are recorded in the final report copy.

Report copy: `/Users/ino/Develop/openomni/.omo/reports/publisher-fixpoint-design-20260911.md`.