# Maestro

Maestro is a robot teammate for your code repositories. You assign it a ticket,
and it does the work: it opens a branch, writes the code with Claude, proves the
change works, and then hands the result back to you for review. Once you approve,
it merges. If it gets stuck or has a question, it asks and waits.

It works on top of **GitLab** and **GitHub**. You keep using issues and merge
requests the way you already do. Maestro just becomes another contributor on the
team — one that happens to be an AI.

> **Where the build is:** the full v1 lifecycle (M0–M8) is implemented and
> tested. The pieces that talk to a *live* forge and run a *real* Claude session
> end-to-end are gated behind environment flags and wait on a scratch repo +
> token to exercise. Everything below describes the intended, built behaviour.

---

## The one-paragraph version

You run a single long-lived program (the **daemon**) on a machine you control.
It reads a config file listing which repos to watch. Every so often it looks at
each repo and asks: *is there a ticket here assigned to my bot account?* If yes,
it picks it up and walks it through a fixed set of steps — write code, prove it,
ask for review, merge. The clever part is that Maestro keeps **almost no memory
of its own**. Everything it needs to know lives in the ticket, the merge request,
and the git history. So if the daemon crashes or you reboot the machine, it just
re-reads the repo and carries on exactly where it left off.

---

## Why it's built this way

Two ideas drive the whole design.

**1. The forge is the memory.** Maestro doesn't run a database. The "state" of
any ticket — whether it's new, in progress, waiting for review, or done — is
written directly into the forge as labels, merge-request status, and comments.
Anything stored on the local disk (cloned repos, log files) is treated as a
throwaway cache that can be deleted and rebuilt at any time.

```mermaid
flowchart LR
    subgraph durable["Durable — survives anything"]
        F["GitLab / GitHub<br/>tickets · labels · MRs · comments"]
        C["maestro.config.yaml<br/>which repos to watch"]
    end
    subgraph cache["Disposable cache — delete anytime"]
        W["workspaces/<br/>cloned repos"]
        L["logs/"]
    end
    D["Maestro daemon"]
    D -->|reads & writes| F
    D -->|reads| C
    D -.->|rebuildable| W
    D -.->|rebuildable| L
```

Because of this, a multi-day wait for a human reviewer costs nothing. The daemon
can die, sit idle for a week, then wake up and rebuild every ticket's status from
the forge.

**2. The AI starts fresh every time.** Maestro never tries to "resume" a Claude
session. Each time it needs the agent, it starts a brand-new, cold session. The
agent re-learns what it's doing by reading three things: the ticket, the merge
request description (which doubles as its to-do list), and the recent git diff.
This sounds wasteful but it's actually robust — there's no fragile session to
lose, and a human can read the exact same three sources to understand what
happened.

---

## The lifecycle: how a ticket becomes a merge

Every ticket moves through the same set of stages. The stage is stored as a label
on the ticket (`maestro::in-progress`, `maestro::in-review`, and so on), so you
can see it at a glance on your board.

```mermaid
stateDiagram-v2
    [*] --> New: assigned to bot
    New --> InProgress: open branch + draft MR,<br/>post "started"
    InProgress --> InProgress: write code,<br/>atomic commits
    InProgress --> Handoff: agent says "done"
    InProgress --> Blocked: agent has a question
    Handoff --> InReview: proof posted,<br/>then reviewer assigned
    InReview --> InProgress: changes requested
    InReview --> Done: you approve, then merge
    Blocked --> InProgress: human answers
    Done --> [*]: workspace cleaned up

    note right of Handoff
        Proof is always posted
        BEFORE you're pinged,
        so you're notified only
        once everything is ready.
    end note
```

In words:

- **New** — A ticket assigned to the bot, with no Maestro label yet. The daemon
  creates a branch and a *draft* merge request, labels it in-progress, posts a
  "started" comment, and begins work.
- **In progress** — The agent works the ticket one small commit at a time, ticking
  off items in its to-do list (which lives in the MR description) and posting the
  occasional progress note.
- **Handoff** — A brief, behind-the-scenes step. The agent says it's done, so
  Maestro generates *proof* (see below), posts it, **then** assigns the merge
  request to whoever opened the ticket and marks it ready for review. The order
  matters: you're pinged last, when there's actually something to look at.
- **In review** — Maestro waits. If you approve, it merges using that repo's own
  git rules and the ticket auto-closes. If you request changes, it flips back to
  in-progress and feeds your feedback to the agent.
- **Blocked** — The agent hit something it can't decide on its own. It posts the
  question and waits for a human. No slot is consumed while it waits.
- **Done** — Ticket closed, local workspace cleaned up.

---

## What happens during one "tick"

The daemon runs on a loop. One pass over the repos is called a **tick**. Here's
what a single ticket looks like as it gets picked up and worked:

```mermaid
sequenceDiagram
    participant D as Daemon
    participant F as Forge (GitLab/GitHub)
    participant WS as Workspace
    participant CL as Claude
    participant P as Proof
    participant H as Human

    D->>F: Any ticket assigned to the bot?
    F-->>D: Yes — ticket #42, no label
    D->>WS: Clone repo, make a branch
    D->>F: Open draft MR, label in-progress
    loop until done or blocked
        D->>CL: Start a fresh session (read ticket, MR, diff)
        CL->>WS: Write code, commit
        CL-->>D: status: done
    end
    D->>P: Run the proof (e.g. Playwright tests)
    P-->>D: Artifacts
    D->>F: Post proof on ticket + MR
    D->>F: Assign MR to ticket author, mark ready
    Note over D,H: Maestro now waits...
    H->>F: Approve
    D->>F: Merge per repo's git rules
    F-->>D: Ticket auto-closes
    D->>WS: Clean up the clone
```

The only thing the daemon ever hears back from Claude is a tiny status:
`done`, `needs_input`, or `in_progress`. Everything else it learns by reading the
forge on the next tick.

---

## The pieces inside

Maestro is a set of small, independently testable parts. The most important one
is the **reconciler** — the "brain" that, given a snapshot of a ticket, decides
the single next action. It's pure logic with no side effects, which is why it can
be tested exhaustively and why it never changed when GitHub support was added on
top of GitLab.

```mermaid
flowchart TD
    Config["Config loader<br/>reads maestro.config.yaml"]
    WF["Workflow loader<br/>reads each repo's WORKFLOW.md"]
    Forge["Forge adapter<br/>GitLab + GitHub, one shared shape"]
    Rec["Reconciler<br/>(snapshot) to one action"]
    WSM["Workspace manager<br/>clone · branch · cleanup"]
    Run["Claude runner<br/>headless 'claude -p'"]
    Proof["Proof generator<br/>playwright · tests · diff · none"]

    Config --> Rec
    WF --> Rec
    Forge --> Rec
    Rec -->|"start work"| WSM
    WSM --> Run
    Run -->|"done"| Proof
    Proof --> Forge
    Rec -->|"merge / comment / label"| Forge
```

- **Forge adapter** — The only part that knows the difference between GitLab and
  GitHub. It translates each into one shared shape so nothing above it has to
  care which forge a repo lives on.
- **Reconciler** — Pure decision-making. Takes a ticket snapshot, returns at most
  one action per tick.
- **Workspace manager** — Clones a repo into a per-ticket folder, handles the
  branch, cleans up when the ticket is done. This is also the seam where, later,
  you could swap host folders for isolated containers.
- **Claude runner** — Runs the same `claude` binary you use interactively, but
  headless. Locally it uses your existing login and still loads your `CLAUDE.md`,
  settings, skills, and permission modes.
- **Proof generator** — Pluggable per repo. Pick `playwright`, `test-output`,
  `diff-summary`, or `none`.
- **CLI and Web** — Thin shells over the shared core (see below).

---

## Prerequisites

Maestro is an orchestrator — it drives a handful of command-line tools rather than
reimplementing them. These need to be installed and on your `PATH` before the
daemon will run:

| Tool | Why | Install |
|---|---|---|
| **Node.js ≥ 20** + **pnpm** | runs Maestro itself | [nodejs.org](https://nodejs.org) · [pnpm.io](https://pnpm.io/installation) |
| **git** | clone and branch each ticket's workspace | your package manager |
| **claude** | the coding agent, run headless | [Claude Code](https://claude.com/claude-code) |
| **glab** | talk to the GitLab API — *only if you watch GitLab repos* | [gitlab.com/gitlab-org/cli](https://gitlab.com/gitlab-org/cli) |
| **gh** | talk to the GitHub API — *only if you watch GitHub repos* | [cli.github.com](https://cli.github.com) |

You don't need to log into `glab`/`gh` — Maestro injects the token itself (from
your `.env`). It only needs the binaries present. Run **`maestro doctor`** at any
time to check what's missing; the daemon also runs this check on startup and
refuses to boot (with a clear message) if a required tool is absent.

---

## Getting started

The fast path from a fresh clone to a running daemon and dashboard.

```sh
# 1. Clone and set up (installs deps, builds, scaffolds .env, checks your tools)
git clone https://github.com/l4ci/maestro.git
cd maestro
./scripts/setup.sh

# 2. Add your secrets — paste the bot account's token(s)
$EDITOR .env                 # MAESTRO_GITLAB_TOKEN / MAESTRO_GITHUB_TOKEN

# 3. Point Maestro at your forge(s) — host + which env var holds each token
$EDITOR maestro.config.yaml  # (see "Setting it up" below for the full schema)

# 4. Confirm every required tool is on PATH
node packages/cli/dist/cli.js doctor

# 5. Connect your first repo (creates its labels/board, commits the config change)
node packages/cli/dist/cli.js add gitlab.com/your-group/your-repo

# 6. Start the daemon — it now watches every repo in the config
node packages/cli/dist/daemon.js

# 7. In another terminal, start the dashboard and open it in a browser
node packages/web/dist/main.js      # → http://127.0.0.1:4000
```

That's the whole loop. Assign an issue on your repo to the bot account, and watch
its state move across the dashboard as Maestro picks it up, works it, and hands it
back for review.

> **Tip — a shorter `maestro`:** the commands above call the CLI by its built path.
> To type just `maestro …`, either alias it
> (`alias maestro='node /path/to/maestro/packages/cli/dist/cli.js'`) or link it
> globally with `pnpm --filter @maestro/cli link --global`.

---

## Setting it up

There are two config files. One is global to your Maestro install; the other
lives inside each repo you want watched.

### 1. The global config — `maestro.config.yaml`

This lists your repos and global defaults. It's committed to git. **Secrets never
go here** — the config only names the *environment variable* that holds a token,
never the token itself.

```yaml
defaults:
  poll_interval_active: 30s   # how often to check repos with live work
  poll_interval_idle: 5m      # how often to check quiet repos
  bot_user: maestro-bot
  concurrency:
    global_max: 2             # how many tickets to actively work at once
forges:
  gitlab: { host: gitlab.com, token_env: MAESTRO_GITLAB_TOKEN }
  github: { host: github.com, token_env: MAESTRO_GITHUB_TOKEN }
repos:
  - url: gitlab.com/group/api
  - url: github.com/org/web
```

The actual token values go in a `.env` file, which is gitignored:

```sh
cp .env.example .env
# then fill in MAESTRO_GITLAB_TOKEN / MAESTRO_GITHUB_TOKEN
```

### 2. The per-repo config — `WORKFLOW.md`

Each watched repo carries its own `WORKFLOW.md`, version-controlled alongside the
code. It tells Maestro how *that* repo wants to be worked: which branch to target,
how to merge, how to prove a change works, and any house rules for the agent
(test commands, conventions, definition of done). The prompt body of this file is
the agent's operating manual. When you run `maestro add`, a sensible default is
generated for you from a template.

---

## A walkthrough of the default `WORKFLOW.md`

A `WORKFLOW.md` has two parts: a **front-matter block** (the settings, in YAML
between the `---` fences) and a **prompt body** (plain Markdown below the fences,
which becomes the agent's instructions). Here's the default, annotated.

### The front matter — settings

```yaml
---
forge: gitlab                  # gitlab | github (guessed from the repo's host if left out)
project: group/repo            # GitLab path, OR GitHub org/repo
bot_user: maestro-bot          # the account tickets get assigned to
manage_board: true             # auto-create the labels (and, on GitLab, the board lists)

trigger:                       # the gate for what the bot is allowed to pick up
  assignee: bot                #   the ticket must be assigned to bot_user
  require_label: null          #   optional: also require this maintainer-added label
  allowed_actors: []           #   optional: only trust triggers from these users (turn ON for public repos)

proof:                         # how this repo proves a change works
  type: playwright             #   playwright | test-output | diff-summary | none
  command: "npx playwright test --reporter=line"

git:                           # this repo's own merge rules
  default_branch: main
  target: main                 #   which branch the MR/PR targets
  merge_strategy: squash       #   squash | merge | rebase
  delete_source_branch: true

environment:                   # how to reach or boot a running instance (for proof)
  base_url: http://localhost:3000   #   an already-running local instance, if any
  start_command: "npm run dev"      #   else, how to start one
  seed_command: "npm run db:seed"   #   load sample/dummy data
  health_check: "curl -sf localhost:3000/health"

claude:                        # how the agent runs
  command: "claude"            #   same binary as interactive; the daemon runs it headless
  max_turns: 40                #   safety cap on how long one session can churn
  permission_mode: acceptEdits #   how much the agent may do without asking

concurrency:
  max_active: 2                # most tickets this one repo will work at once
---
```

The blocks worth understanding:

- **`trigger`** is your safety gate. By default a ticket just needs to be assigned
  to the bot. For anything public, turn on `require_label` and/or `allowed_actors`
  so a stranger can't kick off work by assignment alone.
- **`proof`** is how Maestro *demonstrates* the change is good before pinging you.
  `playwright` runs browser tests, `test-output` runs your test suite, `diff-summary`
  just summarizes the change, and `none` skips it.
- **`environment`** only matters when proof needs a running app. If you already
  keep a local instance up, point `base_url` at it; otherwise Maestro uses
  `start_command` to boot one, `seed_command` to fill it with data, and
  `health_check` to know it's ready.
- **`git`** lets each repo keep its own merge habits — Maestro never imposes one
  global rule.

### The prompt body — the agent's instructions

Below the second `---` is plain Markdown that becomes the agent's operating
manual. The template ships with a shared spine (the same six steps from the
lifecycle above) plus a spot for your repo's house rules:

```markdown
# Agent operating protocol

You are working a single issue end-to-end in a cold session. Reconstruct all
context from the issue, the MR description (your durable plan/todo), recent
commits + diff, and the repo conventions below.

1. Orient — read the issue, the MR description, recent commits + diff, and the
   conventions in this file.
2. First session only — gather context. If the task is ambiguous, post a comment
   with questions, set maestro::blocked, and stop. Otherwise, write a plan +
   checkbox todo list into the MR description.
3. Work the next unchecked item — one atomic commit per meaningful step.
4. After each step — tick the box in the MR description; post a short progress
   comment if notable.
5. Done — all boxes checked + definition-of-done met → emit done.
6. Blocked anytime — need a human decision → comment the question, label
   maestro::blocked, stop.

## Repo-specific conventions

- Test: `npm test`
- Lint: `npm run lint`
- Definition of done: tests + lint green; proof attached; MR todo all checked.
```

**You mostly edit the bottom section.** The numbered protocol is the shared
default — leave it alone unless you have a reason. The "Repo-specific conventions"
block is where you teach the agent about *this* codebase: the exact test and lint
commands, architecture notes, naming rules, and what "done" means here. Whatever a
new human teammate would need to know on day one belongs there.

> **Why the MR description matters so much:** notice that step 2 puts the plan and
> to-do list *into the MR description*, not into the agent's memory. That's
> deliberate. Because the agent starts cold every session, the MR description is
> its only durable scratchpad — and it's one you can read too. Open the MR and you
> see exactly what the agent thinks it's doing and how far along it is.

---

## Running it

The daemon is one process that watches **all** your repos. You never run one
daemon per repo.

```sh
# start the daemon (watches everything in maestro.config.yaml)
node packages/cli/dist/daemon.js
```

On startup it preflights your tools (`git`, `claude`, and the forge binaries you
need) and refuses to boot if any are missing — so a misconfigured host fails fast
with a clear message instead of silently looping.

Day-to-day you'll mostly use the CLI:

| Command | What it does |
|---|---|
| `maestro add <url>` | Start watching a repo. Sets up its labels/board and commits the config change. Add `--public` to opt into a public repo (read the safety notes first). |
| `maestro list` | Show all watched repos and what's in flight. |
| `maestro status <issue>` | Show one ticket's current stage. |
| `maestro logs <issue>` | Show the agent's logs for a ticket. |
| `maestro run <issue> --attach` | Open an **interactive** Claude in that ticket's workspace so you can watch or drive it by hand. Local-dev only, not the daemon path. |
| `maestro doctor` | Check that every required tool (`git`, `claude`, `glab`/`gh`) is on your `PATH`. Exits non-zero if anything's missing. |

### The dashboard

A small read-only **web dashboard** shows the same information in your browser —
a live status table of every watched repo and its tickets, plus an "add a repo"
form — and auto-refreshes every few seconds.

```sh
node packages/web/dist/main.js      # → http://127.0.0.1:4000
```

Override the bind address with `MAESTRO_WEB_HOST` / `MAESTRO_WEB_PORT`. The same
endpoint also serves the raw read-model as JSON to any non-browser client (handy
for scripting), so `curl localhost:4000` gives you the data the page renders.

---

## How the daemon decides what to work on

You can watch a hundred repos on a tiny machine. The thing that costs real
resources isn't *watching*, it's *working*. A repo with nothing assigned, or a
ticket sitting in review, costs only a cheap periodic check. Compute is spent only
while a ticket is actively being worked, and each active ticket holds one "slot".

```mermaid
flowchart LR
    R1["repo: api<br/>2 tickets waiting"] --> Q
    R2["repo: web<br/>1 ticket in review"] -. no slot needed .-> Idle
    R3["repo: docs<br/>nothing assigned"] -. just polled .-> Idle
    Q["Work queue"] --> S{"Free slot?<br/>(global_max: 2)"}
    S -->|yes| Work["Active worker"]
    S -->|no| Wait["Queued"]
```

If more tickets are ready than you have slots, the extras simply queue. Nothing
breaks — throughput is just capped. The right number of slots depends on your
machine's RAM, since each active worker runs Claude plus possibly a browser for
proof. On a 4 GB box, 1–2 is sensible.

To scale up, you don't add daemons — you add **machines**, each running its own
single daemon watching a few repos. They never coordinate with each other; the
forge is the shared source of truth, so there's nothing to sync.

---

## Maestro can manage itself

The Maestro project is just a git repo, which means Maestro can watch *itself*.
Want to add a repo or bump concurrency? File a ticket on the Maestro repo. The
agent edits `maestro.config.yaml`, opens a merge request, you approve, it merges,
and the daemon hot-reloads the new config. There's no separate admin panel —
managing Maestro *is* using Maestro.

---

## A note on safety

Maestro runs autonomous Claude (and possibly a browser for proof) directly on the
host machine, unsandboxed. For your own **private** repos with a dedicated bot
account, that's a reasonable tradeoff. For **public** repos it's riskier, and
support for them is deliberately opt-in (`--public`):

- **Who can start work** is gated by forge permissions — assigning a ticket to the
  bot requires write/triage access. You can tighten this further with a required
  label or an allowlist of trusted users.
- **What a ticket says** is the harder problem. On a public repo, ticket text is
  written by strangers, and the agent acts on it with the bot's credentials. The
  real fix is per-ticket container isolation, which is a planned future step. Until
  then, treat public-repo support as experimental and lean on constrained
  permission modes and keeping secrets out of the workspace.

---

## For developers

It's a pnpm + TypeScript monorepo.

```
packages/core   the brain: reconciler, forge adapters, Claude runner, proof,
                config + workflow loaders, daemon loop, tool preflight
packages/cli    maestro add | status | list | logs | run | doctor + daemon entry
packages/web    read-only dashboard (HTML page + JSON API) + add-repo form
templates/      the default WORKFLOW.md used when onboarding a repo
scripts/        setup.sh — one-shot install + build + tool check
```

The CLI and web packages are intentionally thin — almost all real logic lives in
`core` so both interfaces behave identically.

```sh
pnpm install
pnpm typecheck   # strict TypeScript
pnpm test        # vitest
pnpm lint        # biome
pnpm build       # per package
```

### Where to read more

- **Design spec (the locked source of truth):**
  [`docs/superpowers/specs/2026-06-03-maestro-design.md`](docs/superpowers/specs/2026-06-03-maestro-design.md)
- **Build roadmap and milestone history:** [`tasks/todo.md`](tasks/todo.md)
- **Architecture vocabulary and settled seams:** [`CONTEXT.md`](CONTEXT.md)
