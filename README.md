# Maestro

A single stateless daemon that watches GitLab/GitHub repos, picks up issues
assigned to a bot account, and drives each through a human-in-the-loop lifecycle
using Claude as the coding agent: branch + MR/PR, autonomous atomic-commit work,
proof generation, handoff to the ticket creator for review, and merge per the
repo's own git rules once approved.

- **Design spec:** [`docs/superpowers/specs/2026-06-03-maestro-design.md`](docs/superpowers/specs/2026-06-03-maestro-design.md) (locked)
- **Build roadmap:** [`tasks/todo.md`](tasks/todo.md) → milestone plans in `docs/superpowers/plans/`

## Layout

```
packages/core   reconciler, forge adapters, claude runner, proof, config, loaders
packages/cli    maestro add|status|list|logs + daemon entry
packages/web    read-only dashboard + add-repo form
templates/      default WORKFLOW.md for repo onboarding
```

State of the build: **M0 (scaffolding & contracts)**. Everything on local disk
(`workspaces/`, `logs/`) is a gitignored cache; the only durable stores are the
forge and `maestro.config.yaml`.

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm lint
```
