<!--
PR title must follow conventional commits: type(scope): description
Examples: feat(session): add Bus filter API, fix(llm): handle provider timeout
-->

## Summary

<!-- What does this PR do and why? (1-3 sentences) -->

Fixes #
Relates to #

## Changes

<!-- Key changes as bullet points. -->

-

## Type

- [ ] `feat` — New feature or capability
- [ ] `fix` — Bug fix
- [ ] `refactor` — Code restructuring (no behavior change)
- [ ] `test` — Adding or updating tests
- [ ] `docs` — Documentation only
- [ ] `chore` — Build, CI, tooling, dependencies
- [ ] `perf` — Performance improvement

## Affected Packages

- [ ] `protocol`
- [ ] `session`
- [ ] `llm`
- [ ] `agent`
- [ ] `openomni`
- [ ] `coordinator`
- [ ] `server`

## Breaking Changes

- [ ] No breaking changes
- [ ] Yes — describe migration path below

<!-- If breaking, explain what consumers need to change: -->

## Checklist

- [ ] `bun run check-types` passes
- [ ] `bun run script/check-deps.ts` clean (dependency direction + source-import scan)
- [ ] `bun run lint:tools` and `bun run lint:tools --self-test` pass (baseline growth = Owner sign-off)
- [ ] Full suite green with an explicit timeout: `bun test --timeout 15000` (a hang is a finding)
- [ ] Tests added/updated for changes — no weakened assertions
- [ ] No `as any`, `@ts-ignore`, or `@ts-expect-error` added
- [ ] **Reconcile-first**: issue/audit claims re-verified on current `main`; deltas recorded above
- [ ] **Doc-state sync**: `docs/implementation-status.md` + phase issue updated in this PR
- [ ] AGENTS.md updated if public API or architecture changed; this PR's stamp line prepended to `docs/agents-stamps.md`
- [ ] **Independent adversarial review** run by a separate agent/session; verdict linked or pasted in a comment (author's green run alone is not evidence — see AGENTS.md § Execution Discipline)

## Review verdict

<!-- Link or paste the independent pre-merge review verdict (MERGE_OK / BLOCK + findings). -->

Phase issue: #
