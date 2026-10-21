# Contributing

Oni is a personal AI workforce project with a specific architectural vision. Contributions are welcome, but please read through `docs/` before proposing significant changes. The project prioritizes coherence over feature count.

## Prerequisites

- [Bun](https://bun.sh), exactly the `packageManager` version in `package.json`
- Python 3.12 for attached-machine integration tests
- TypeScript and other development tools installed from `bun.lock`

## Setup

```bash
git clone https://github.com/INONONO66/oni.git
cd oni
bun install --frozen-lockfile
bun run build
bun test --timeout 15000
```

## Development Commands

| Command | Description |
|---|---|
| `bun install --frozen-lockfile` | Install the pinned dependencies |
| `bun run build` | Build all packages |
| `bun test --timeout 15000` | Run discovered tests; not the full CI gate chain |
| `bun run check-types` | Type check |
| `bun run format` | Format with Biome |
| `bun run script/check-deps.ts` | Check package boundary violations |

See [CI verification](docs/ci.md) for selected workspace tests, full verification,
coverage checks, and the distinction between local tests and GitHub merge checks.

## Code Style

Formatting and linting via [Biome](https://biomejs.dev). TypeScript strict mode throughout. Cross-package contracts use Zod-first types. Public APIs follow the namespace pattern (`Session.create()`, not named exports). See `docs/architecture.md` (Code Conventions) for the rationale behind these choices.

## Commit Messages

Conventional commits: `type(scope): description`

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`

Scope is the affected workspace or concern (`protocol`, `ledger`, `llm`, `agent`,
`app`, `desktop`, `ui`, `ci`). Keep descriptions imperative and under 72 characters.

## Architecture

TypeScript monorepo built with Bun and Turborepo. `script/topology.ts` owns the
workspace inventory and allowed dependencies; the generated table in `AGENTS.md`
is its readable counterpart. `apps/oni` composes the agent product and
`apps/desktop` consumes the `packages/ui` design system. Core packages retain
their declared boundaries, which `script/check-deps.ts` enforces in source and
manifests. See `docs/implementation-status.md` for current wiring.

## License

MIT. By contributing, you agree your contributions will be licensed under the same [MIT License](LICENSE).
