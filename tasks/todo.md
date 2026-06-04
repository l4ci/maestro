# Maestro — Milestone Roadmap (index)

Source of truth: `docs/superpowers/specs/2026-06-03-maestro-design.md` (locked).
Detailed plans: `docs/superpowers/plans/maestro-00 … 08`.

**Decisions in force (kickoff):** full spec M0–M8 · vertical-slice sequencing
(GitLab end-to-end by M5) · name `maestro` (`maestro::*` / `maestro:*`, env
`MAESTRO_*`) · toolchain pnpm + TS strict ESM + vitest + zod + biome + tsup.

**Build discipline:** M0 freezes one authoritative contracts doc; every milestone
plan was written strictly against it and reported gaps instead of inventing types.
All reported gaps were reconciled additively into M0 §0.10/§0.12 **before any
code** — this is the explicit guard against the cross-plan contradiction that
deleted the previous M1–M7 set.

## Milestones (sequential; each verified before the next depends on it)

- [x] **M0 — Scaffolding & Contracts** — `maestro-00-scaffolding-and-contracts.md`
      Monorepo + toolchain + frozen contracts (forge model, reconciler, schemas,
      exec seam, runner, + §0.12 reconciled modules). *Gate: build/typecheck/test/lint
      green; schemas round-trip the sample config + WORKFLOW.* **✓ merged to main.**
- [x] **M1 — Reconciler & Loaders** — `maestro-01-reconciler-and-loaders.md`
      Pure FSM (TDD vs §7); config + WORKFLOW load/validate/hot-reload. **✓ merged
      to main (55 tests). All 6 plan open-deps were pre-resolved in M0.**
- [x] **M2 — GitLab adapter (reference)** — `maestro-02-gitlab-adapter.md`
      `glab`+REST; issues/MR/labels/approval/comments + board automation (§11).
      **✓ merged to main (88 unit tests + NodeExec/FakeExec). Live integration tier
      env-gated/skipped — deferred until a scratch GitLab project + token exist.**
- [x] **M3 — Workspace manager & Claude runner** — `maestro-03-workspace-and-runner.md`
      Clone/branch/cleanup + path guard + LRU; `claude -p` stream-json → contract,
      stall-kill. **✓ merged to main (111 tests). Zero contract changes. Live
      stream-json envelope verification deferred (no `claude` capture here).**
- [x] **M4 — Proof & Handoff** — `maestro-04-proof-and-handoff.md`
      Pluggable proof strategies; transient Handoff with the proof-before-assign
      ordering guarantee (call-order test). **✓ merged to main (139 tests). First
      in-flight contract amendment: AM-16 (ProofInput.git.target).**
- [x] **M5 — Daemon loop (first full E2E)** — `maestro-05-daemon-loop.md`
      Two-pass tick (lifecycle + cleanup sweep), concurrency accounting, adaptive
      poll + jitter, hot-reload. *Headline: one GitLab repo driven New→Done.*
      **✓ implemented (45 new tests: slots/scheduler/reload/run + 25 tick
      orchestration slices A–H). Zero frozen-contract changes — consumed AM-1
      `workComplete`, AM-3 `settings.concurrency`, `DONE_SENTINEL`, `HandoffFn`.
      Small additive M3 reads (`WorkspaceManager.workspaceExists`/`listWorkspaces`)
      for the cleanup sweep. `core/daemon` is real-time/randomness-free (injected
      Clock+Rng); `cli/daemon.ts` is the thin composition root. Live E2E smoke (I1)
      env-gated/skipped — deferred until a scratch GitLab project + token exist
      (mirrors M2/M3); the New→Done slice is proven at unit level by A–H.**
- [x] **M6 — CLI & Web** — `maestro-06-cli-and-web.md`
      `add|status|list|logs` + daemon entry + `run --attach`; read-only dashboard
      + add-repo form. Thin over core. **✓ implemented (44 new tests). Shared core
      foundation: `addRepo` (one routine for CLI + web POST), pure view-assembly
      (`assembleDashboard`/`assembleIssue` over `ReadOnlyForgeAdapter` + `deriveState`),
      `FileLogReader`. CLI = parser + thin marshallers + pure formatters + `run
      --attach` (interactive `Exec.attach`, proven NOT to use `-p`/stream-json/
      ClaudeRunner). Web = `node:http` server, GET read-only by type, POST `/repos`
      → same `addRepo`. All ODs resolved (M0/M1/M5). `dist/daemon.js` is the M5
      composition root. NOTE: the logs-cache WRITER is still absent — M5 ships a
      console logger, so `FileLogReader` returns [] until a writer lands (deferred
      M5 obligation; reader + format are ready).**
- [x] **M7 — GitHub adapter** — `maestro-07-github-adapter.md`
      `gh`; flat `maestro:*` labels w/ adapter-enforced mutual exclusion; Projects
      V2 deferred. *Proof the abstraction held: reconciler + daemon unchanged.*
      **✓ implemented (36 new unit tests). `GithubAdapter` over `gh api` (`GithubClient`
      + `normalize.ts`), all 14 §0.3 methods idempotent; `ensureBoard` left undefined
      (Slice 11 asserts absent). Three divergences only: flat-label mutual exclusion in
      `setIssueLabels`, review-derived `ApprovalState` + edge-triggered `changesRequested`
      (latest-per-reviewer), GitHub-native `draft` + GraphQL ready/draft toggle. Token in
      `GH_TOKEN` env, never argv. HEADLINE PROOF: `core/reconciler` + `core/daemon`
      byte-for-byte unchanged — GitHub drops in only at the composition root
      (`cli/daemon.ts buildAdapters`, `cli/main.ts makeAdapter`) via the pre-built
      `selectAdapter`/`forges.github` seams. Tests mirror M2's inline-builder pattern (not
      the plan's JSON `__fixtures__`, which M2 never materialized). Live New→Done E2E
      env-gated (`MAESTRO_GITHUB_IT=1`) — deferred until a scratch GitHub repo + token
      exist (mirrors M2/M3/M5); the reconcile-over-real-getSnapshot smoke is wired.**
- [x] **M8 — Bootstrap & self-manage (closeout)** — `maestro-08-bootstrap-and-self-manage.md`
      `maestro add` onboarding dogfoods the lifecycle (§16); maestro watches itself
      (§12); QA pyramid + §13/§13.1 security audit closeout. *Canonical v1 acceptance.*
      **✓ implemented (47 new tests). Part A `bootstrap/infer-workflow-seed.ts`
      (default-branch probe + pure proof/framework detection + seed rendered through
      the M1 loader, always WorkflowSchema-validated incl. a negative case). Part B
      `bootstrap/onboard.ts` — the ONE onboarding routine (add-repo refactored to call
      it): ensure labels/board → add-when-missing bot issue with the inferred seed +
      marker, idempotent (no duplicate). Part C: self-manage proven by composing M1
      `ConfigStore` + M5 `WatchedConfig` (merged edit picked up; bad merge rejected,
      daemon survives on last-good — already swallow-and-log). Part D security: prompt-
      injection body is opaque to the reconciler; `--public` opt-in gate
      (`onboarding/public-guard.ts`); `security/scan-for-secrets.ts` + a live CI gate
      over `git ls-files`; bootstrap E2E gated `MAESTRO_E2E=1` (runbook, mirrors M2/M5).
      THESIS PROVEN: `core/reconciler` + `core/daemon/tick` byte-for-byte unchanged;
      Slice 6 greps them for `bootstrap`/`onboard` and finds none; the bootstrap issue
      yields the same `start-new` intent as any issue. ONE in-flight contract amendment
      (AM-17, §0.8): `ExecOptions.env` widened to `Record<string,string|undefined>` so a
      key→undefined DELETES the inherited var — the runner scrubs the forge token from
      the agent env (§13.1 hardening; user-approved over document-only). Live forge/agent
      E2E env-gated/deferred (no scratch repo+token here). v1 DEFINITION OF DONE met:
      M0–M8 green, spec §1–§16 delivered, §17 items explicitly deferred.**

## Dependency edges

M0 → everything. M1, M2, M3 parallel after M0. M4 needs M2+M3. M5 needs M0–M4
(vertical slice completes). M6 needs M5. M7 needs M2 (mirrors it). M8 needs M0–M7.

## Review

- **What got built:** 9 plan docs (M0 contracts + M1–M8 TDD plans), authored M0
  first by hand, M1–M8 by parallel subagents against the frozen M0.
- **Gaps caught before code (reconciled into M0 §0.10):** 15 additive amendments
  (AM-1…AM-15) — incl. `workComplete` input, terminal-before-guard ordering,
  concurrency carrier, `AbortSignal`/`spawn`/`attach` on the exec seam, and 6 new
  contract modules (naming, proof, handoff, logs, bootstrap, read-only adapter +
  `deriveState` export). Plus 11 non-contract impl decisions recorded.
- **The prior rot (cleanup never observing closed issues):** resolved in M0 §0.5 —
  cleanup is a workspace-cache-driven sweep (`getIssueState`), decoupled from the
  open-issue lifecycle list. No plan reintroduces "iterate closed issues."
- **Open product flags surfaced (non-blocking, for your call when relevant):**
  CI smoke uses `diff-summary` proof to keep Chromium out of CI (M5); `maestro run`
  requires `--attach` in v1 (M6); public-repo support via `--add --public`, real
  isolation deferred to containers (§17); stall-kill retries once (M3).
- **Status:** planning complete and internally consistent. Ready to execute M0.
