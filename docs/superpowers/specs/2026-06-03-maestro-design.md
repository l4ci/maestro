# Maestro — Design Spec

- **Date:** 2026-06-03
- **Status:** Draft for review
- **Working name:** Maestro (placeholder; CLI `maestro`, GitLab labels `maestro::*`)

## 1. Goal

A single daemon that watches multiple **GitLab and/or GitHub** repos, picks up
issues assigned to a bot account, and drives each one through a full
human-in-the-loop lifecycle using **Claude** as the coding agent: branch + MR/PR,
autonomous work with atomic commits, proof generation, handoff to the ticket
creator for review, and merge per the repo's own git rules once approved.

Inspired by openai/symphony's orchestration model, but **built fresh** — Symphony
is Elixir and hardwired to Codex + Linear, which reuses almost none of this stack.

## 2. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Language/stack | Node/TS monorepo | Shared `core` across CLI + web; one language end-to-end |
| Runtime model | Stateless poll-driven daemon | Survives multi-day review waits for free; idempotent |
| Source of truth | **GitLab + one YAML config** | No database; both stores human-legible |
| Agent backend | Claude (`claude -p --output-format stream-json`) | Cold, self-contained sessions |
| Agent working memory | **MR description + issue comments + git diff** | Durable, human-visible; no fragile session resume |
| Forge support | GitLab (`glab`) + GitHub (`gh`) via one forge adapter | Reconciler stays forge-agnostic over a normalized model |
| Issue pickup trigger | Assigned to bot **+ optional label/actor guard** | Assignment is permission-gated; guard hardens public repos (§13) |
| Lifecycle states | Labels: scoped `maestro::*` (GitLab) / flat `maestro:*` (GitHub) | Neither forge has Linear-style states; both Free-tier |
| Approval signal | Native MR approval (GitLab) / PR review APPROVED (GitHub) | Audit-friendly; maps 1:1 |
| Proof | Pluggable per repo via WORKFLOW.md | Mixed repo types (web/CLI/lib) |
| Execution | Per-issue host workspaces | Simple/fast; workspace manager is the seam to swap for containers later |
| Interface | CLI + read-only web dashboard | Shared `core` lib |
| Wrapper | The maestro project is itself a git repo | Config-as-code; self-manageable |

## 3. Key properties

The system is **fully stateless except for two legible stores**:

1. **GitLab** — per-issue lifecycle (assignment, `maestro::*` labels, MR state,
   approval) and the agent's working memory (MR description = plan/todo, comments
   = progress log).
2. **`maestro.config.yaml`** — which repos are watched + settings.

Everything on local disk (`workspaces/`, `logs/`) is a **gitignored cache** and
can be deleted/re-derived anytime. If the daemon dies for days mid-review, on
restart it re-derives every issue's state from GitLab and resumes. There is **no
database**.

## 4. Topology

The wrapper is itself a git repo:

```
maestro/                    # a git repo
├── maestro.config.yaml     # global defaults + watchlist     (committed)
├── .env                    # MAESTRO_GITLAB_TOKEN, etc.       (GITIGNORED)
├── templates/
│   └── WORKFLOW.md         # default template for bootstrap
├── packages/
│   ├── core/               # reconciler, gitlab adapter, claude runner, proof, config, workflow loader
│   ├── cli/                # `maestro add|status|list|logs`  — thin over core
│   └── web/                # read-only dashboard + add-repo form — thin over core
├── workspaces/             # per-issue clones — pure cache    (GITIGNORED)
├── logs/                   #                                  (GITIGNORED)
└── README.md               # top-level explainer
```

One process polls **all** watched repos on a loop. No per-repo cron/install.
`WORKFLOW.md` lives **inside each watched repo**, version-controlled.

## 5. Config schema (`maestro.config.yaml`)

```yaml
defaults:
  poll_interval_active: 30s          # repos with active maestro work
  poll_interval_idle: 5m             # repos with nothing in flight (adaptive polling)
  poll_jitter: 5s                    # spread requests to avoid bursts/rate limits
  bot_user: maestro-bot
  concurrency: { global_max: 2 }     # concurrent ACTIVE workers — size to RAM (see §14)
  workspaces:
    root: ./workspaces
    disk_cap: 20GB                   # evict above this
    cleanup: lru                     # lru | on_terminal
forges:                              # token_env holds the NAME of an env var — never the token itself
  gitlab: { host: gitlab.com, token_env: MAESTRO_GITLAB_TOKEN }
  github: { host: github.com, token_env: MAESTRO_GITHUB_TOKEN }
repos:
  - url: gitlab.com/group/api        # forge inferred from host
  - url: github.com/org/web
    overrides: { concurrency: { max_active: 1 } }
```

- Daemon reads on boot and **hot-reloads on change** (validate before reload).
- `maestro add <url>` appends a repo entry and **commits by default**
  (`--no-commit` to opt out).
- **Secrets never enter git.** Config stores the env var *name*; the value lives
  in the gitignored `.env`.

## 6. WORKFLOW.md schema (per watched repo)

```yaml
---
forge: gitlab                          # gitlab | github  (inferred from repo host if omitted)
project: group/repo                    # GitLab path  OR  GitHub org/repo
bot_user: maestro-bot
manage_board: true                     # GitLab: auto-create labels + board lists. GitHub: labels only (Projects V2 deferred)
trigger:                               # guard for what the bot is allowed to pick up (§13)
  assignee: bot                        # issue must be assigned to bot_user
  require_label: null                  # optional extra gate: a maintainer-added label (perms-gated)
  allowed_actors: []                   # optional allowlist; recommended ON for PUBLIC repos
proof:
  type: playwright                     # playwright | test-output | diff-summary | none
  command: "npx playwright test --reporter=line"
git:
  default_branch: main
  target: main
  merge_strategy: squash               # squash | merge | rebase
  delete_source_branch: true
environment:                           # how to reach/boot a runnable instance (for proof; esp. local)
  base_url: http://localhost:3000      # an already-running local instance, if any
  start_command: "npm run dev"         # else how to boot one
  seed_command: "npm run db:seed"      # dummy/sample data
  health_check: "curl -sf localhost:3000/health"
claude:
  command: "claude"                    # same binary as interactive; daemon runs it headless (-p)
  max_turns: 40
  permission_mode: acceptEdits
concurrency: { max_active: 2 }
---
# Prompt body — the agent operating protocol (see §9) + repo-specific conventions:
# test commands, lint rules, architecture notes, definition of done.
```

## 7. Lifecycle state machine

Intermediate states live in mutually-exclusive scoped labels `maestro::*`
(auto-created per repo). Each tick, per issue: derive state → compute **at most
one** action. Only "actively working" consumes a concurrency slot.

| State | GitLab signal | Action this tick |
|---|---|---|
| **New** | assigned to bot, no `maestro::*` label | create branch + **draft** MR (`Closes #N`), label `maestro::in-progress`, comment "started", begin work |
| **In progress** | `maestro::in-progress` | run/resume agent (slot). Atomic commits, progress comments. On `done` → Handoff |
| **Handoff** (transient) | end of work | generate proof → comment proof on issue+MR → **then** assign MR to ticket creator → un-draft MR → label `maestro::in-review` |
| **In review** | `maestro::in-review` | poll MR. **Approved** → merge per WORKFLOW.md git rules → issue auto-closes via `Closes #N`. **Changes requested** (unapprove / review thread) → back to `maestro::in-progress`, feedback fed to agent |
| **Blocked** | `maestro::blocked` | agent hit something it can't autonomously resolve; comment why, wait for human |
| **Done** | issue closed | clean up workspace, drop cache |

**Ordering guarantee:** proof is generated and posted *before* the reviewer is
assigned. Assignment is the final handoff step, so the human is pinged only once
everything is ready.

**Forge mapping:** states are identical across forges; only the labels and
approval primitive differ. GitLab uses mutually-exclusive scoped labels
(`maestro::state`); GitHub uses flat labels (`maestro:state`) with mutual
exclusion enforced by the adapter. Approval = GitLab MR approval / GitHub PR
review with state `APPROVED`. MR≡PR throughout.

## 8. Components (each independently testable)

- **Forge adapter** — a behaviour with two implementations: **GitLab** (`glab` +
  REST/GraphQL) and **GitHub** (`gh` + REST/GraphQL). The only forge-aware code.
  Normalizes to a shared issue/MR model so the reconciler is forge-agnostic.
  Covers: issues assigned to bot, MR/PR create/draft/assign/merge, approval state,
  comments, labels, and (GitLab) board/list setup. Forge selected per repo by host
  or explicit `forge:`.
- **Workflow loader** — parses each repo's `WORKFLOW.md` (front matter + prompt
  body), hot-reloads on change, validates.
- **Config loader** — parses/validates `maestro.config.yaml`, hot-reloads.
- **Reconciler** — pure state machine: `(issue, MR, labels) → action`. The brain.
  No I/O; takes a snapshot, emits intents. Fully unit-testable.
- **Workspace manager** — clone/reuse a per-issue dir under `workspaces/`, branch
  handling, cleanup on terminal. The single seam for future container isolation.
- **Claude runner** — invokes `claude -p --output-format stream-json`; parses the
  final result into the agent contract (§10). Cold session each time. Same binary
  as the interactive CLI, run headless; locally it uses the existing logged-in
  auth (your subscription) and still loads CLAUDE.md, settings, MCP, skills, and
  permission modes. Interactive mode can't be daemon-driven (TTY + blocking
  permission prompts + no parseable result).
- **Proof generator** — pluggable strategies selected by WORKFLOW.md
  (`playwright` | `test-output` | `diff-summary` | `none`). Returns artifacts the
  adapter attaches.
- **CLI / Web** — thin shells over `core`. CLI also offers `maestro run <issue>
  --attach`: launch an *interactive* `claude` in that issue's workspace so a human
  can observe/drive a single issue (local-dev only; not the daemon path).

## 9. Default agent operating protocol

Baked into the WORKFLOW.md template prompt body. Every (cold) session runs this
loop, reconstructing context purely from GitLab + git:

1. **Orient** — read the issue, the MR description (your plan, if present), recent
   commits + diff, and repo conventions in WORKFLOW.md.
2. **First session only** — gather context. If the task is ambiguous: post a
   comment with specific questions, set `maestro::blocked`, stop. Otherwise: write
   a plan + checkbox todo list into the **MR description**.
3. **Work the next unchecked item** — one atomic commit per meaningful step.
4. **After each step** — tick the box in the MR description; post a short progress
   comment if notable.
5. **Done** — all boxes checked + definition-of-done met → emit `done`.
6. **Blocked anytime** — need a human decision → comment the question, label
   `maestro::blocked`, stop.

The MR description is the agent's durable scratchpad; issue/MR comments are the
append-only log. A fresh agent needs no handoff — it reads these three sources and
continues. Repo authors extend the body with repo-specific rules; the
read-first / plan-in-MR / atomic-commits / ask-when-unsure spine is the shared
default.

## 10. Runner ↔ agent contract

Each `claude -p` invocation ends by emitting a small status in its final result,
parsed from the `stream-json` output:

```json
{ "status": "done" | "needs_input" | "in_progress", "summary": "..." }
```

That is the only thing the daemon consumes from the agent. Everything else it
reads from GitLab on the next tick.

## 11. GitLab setup automation (on `maestro add`)

Verified Free-tier compatible:

1. `POST /projects/:id/labels` — create scoped labels (`maestro::in-progress`,
   `maestro::in-review`, `maestro::blocked`, …).
2. `GET /projects/:id/boards` → if none, `POST .../boards` to create the board.
3. `POST /projects/:id/boards/:board_id/lists` with `label_id` per label, ordered
   to mirror the lifecycle.

Caveats: on **Free**, a project has exactly **one** board; our lists append to it.
Assignee/milestone lists and multiple boards need Premium — we use neither.
`manage_board: false` in WORKFLOW.md opts a repo out of board management.

**GitHub:** labels are created via `gh`/REST the same way, but board automation
uses Projects V2 (GraphQL, different model) and is **deferred** — GitHub repos get
labels only. The lifecycle is unaffected; only the visual board is.

## 12. Self-managed wrapper

The maestro repo can be watched by maestro itself. File an issue on it ("add repo
X", "bump concurrency") → agent edits `maestro.config.yaml`, opens an MR, you
approve, it merges, daemon hot-reloads. Managing maestro *is* using maestro — same
lifecycle, no special admin path. Seed step: one manual watchlist entry pointing
at itself. Safe because the merge is human-approved and config is validated before
reload.

## 13. Safety, concurrency, errors

- **Host workspaces tradeoff (flagged):** autonomous Claude + Playwright run
  directly on the daemon host, unsandboxed. Mitigations: per-repo
  `permission_mode`, workspace path validation (never escape `workspaces/`),
  dedicated GitLab/GitHub bot account with scoped tokens. Containers are a future
  swap at the workspace-manager seam (and a near-prerequisite for public repos —
  see §13.1). 
- **Concurrency:** global cap + per-repo `max_active`; only active work consumes
  slots.
- **Retry:** a failed tick (network/glab) is retried next tick — reconciler is
  idempotent because state lives in GitLab. Repeated agent failure →
  `maestro::blocked` + comment.
- **Stall detection:** no agent events past a timeout → kill + retry.

### 13.1 Trigger guard & untrusted input (esp. public repos)

Two distinct concerns; the second is the serious one.

- **Who can trigger work.** Assigning an issue to the bot requires triage/write
  permission on both forges, so random public users can't start work by
  assignment alone. The residual risk is a careless insider or a repo with broad
  triage rights. Guard via WORKFLOW.md `trigger`: `require_label` (a perms-gated
  label that must also be present) and `allowed_actors` (only count the trigger if
  the assigning/labeling user is on the allowlist). Recommended ON for public
  repos.
- **What the issue says — prompt injection.** ⚠️ On public repos the issue/comment
  text is **attacker-controlled** and the agent acts on it with the bot's
  credentials. Trigger guards do **not** address this: a legitimately-triggered
  issue can still carry a malicious payload. This makes the §13 host-workspace
  tradeoff materially riskier for public repos. v1 mitigations: constrained
  `permission_mode`, no secrets present in the workspace, and **public-repo
  support is explicit opt-in**. Proper isolation (per-issue containers, the
  deferred §17 item) is the real fix and should precede any serious public-repo
  use.

## 14. Capacity & operations

**One daemon, period.** You never spawn a daemon per repo. A single process polls
every repo this install watches. What scales — and what you cap — is the number of
concurrent **active workers** (`concurrency.global_max`), *not* the repo count.

**Watching ≠ working.** A repo with no assigned issue, or an issue in review-wait,
costs only a periodic poll (a few API calls). Compute is spent only while an issue
is `maestro::in-progress` and holds a slot. 100 watched repos with `global_max: 2`
→ 2 workers run, the rest queue. Nothing breaks; throughput is just bounded.

**Per-active-worker cost & failure modes:**

| Resource | Per worker | Failure mode |
|---|---|---|
| RAM | `claude` ~few hundred MB + **Chromium ~300–700 MB** (if proof `playwright`) + build spikes | **OOM — the breaker.** global_max too high → kills → retry thrash |
| Disk | one full clone in `workspaces/` | **Disk full — the other breaker.** Bound by `workspaces.disk_cap` + LRU |
| CPU | spikes during install/compile/test | Slow, not broken |
| GitLab API | ~3 calls/repo/tick | Rate limits — bound by adaptive polling + jitter + backoff |
| Tokens/$ | per-turn cost | A cost cap (via concurrency), not a VPS cap |

**Sizing:** `global_max ≈ (RAM_MB − ~512 overhead) / per_worker_peak_MB`. On a
4 GB box → **1–2**. Use systemd `MemoryMax` as a backstop, but the real protection
is sizing `global_max` to RAM.

**Adaptive polling:** active repos every `poll_interval_active` (30s), idle repos
every `poll_interval_idle` (5m), with `poll_jitter` to avoid bursts. Keeps
API load flat as watched-repo count grows.

**Scale out = more machines, not more daemons.** Run maestro locally on several
machines, each a separate single-daemon install watching a few repos. No
cross-daemon coordination — each is independent; GitLab is the shared truth.
Running locally also makes proof easy: most repos already have a local running
instance, declared in WORKFLOW.md `environment` (§6).

> ⚠️ **Double-claim hazard:** a repo must be watched by **exactly one** install
> using a given `bot_user`. Two installs watching the same repo with the same bot
> could both claim the same assigned issue. Enforce one-repo-one-install by
> convention (or use distinct bot users per install).

**Daemon setup** — one stateless process under systemd (restart-safe, loses
nothing):

```ini
# /etc/systemd/system/maestro.service
[Service]
ExecStart=/usr/bin/node /opt/maestro/packages/cli/dist/cli.js daemon
Restart=always
EnvironmentFile=/opt/maestro/.env
MemoryMax=3500M
[Install]
WantedBy=multi-user.target
```

## 15. Testing

- **Reconciler:** pure unit tests over snapshot → action (no GitLab).
- **GitLab adapter:** integration tests against a throwaway test project or
  recorded fixtures.
- **E2E smoke:** the WORKFLOW.md bootstrap flow against a scratch repo is the
  canonical end-to-end test.

## 16. WORKFLOW.md bootstrap (onboarding reuses the standard lifecycle)

`maestro add <url>` → clone → set up labels/board → if no WORKFLOW.md:

1. Bot opens an issue in the repo ("Let's define my workflow"), assigned to itself.
2. Normal lifecycle runs: branch + draft MR adding `WORKFLOW.md`, seeded from the
   template + inferred facts (detected test command, framework, default branch).
3. You refine details in the issue thread; each round the agent updates the MR.
4. You approve → WORKFLOW.md merges and is persistent → repo fully onboarded.

No special-case code path — onboarding dogfoods the whole flow.

## 17. Deferred / TODO (out of scope for v1)

- **DB / sample-data — local case supported, isolated case deferred.** When maestro
  runs locally, the WORKFLOW.md `environment` block (§6) reaches an
  already-running instance or boots + seeds one for proof. Fully isolated standup
  (spin up DB + app from scratch in an ephemeral sandbox, e.g. for a remote/CI
  worker) is deferred.
- **Container isolation.** Swap host workspaces for per-issue Docker at the
  workspace-manager seam.
- **Premium board features.** Multiple boards / assignee-milestone lists.
- **GitHub Projects (V2) board automation.** GitHub repos get labels only in v1;
  board/column automation deferred.
- **Cross-install coordination.** v1 scales out as independent single-daemon
  installs (§14), one repo per install by convention. Automatic sharding,
  rebalancing, or shared-claim arbitration across installs is deferred.

## 18. Open questions

- None blocking. Confirm naming (`maestro`) and label namespace before build.
```