# Maestro — M0: Scaffolding & Contracts

- **Source of truth:** `docs/superpowers/specs/2026-06-03-maestro-design.md` (locked)
- **Status of this doc:** **FROZEN CONTRACTS.** Every other milestone plan (M1–M8)
  references the types, signatures, and resolutions here verbatim. A plan that
  needs something not defined here MUST add it to §0.8 (Contract change log) via
  an explicit edit — it may **never** invent a divergent shape inline. This rule
  is the guard against the cross-plan rot that deleted the previous M1–M7 set.
- **Decisions in force (from the build kickoff):** full spec M0–M8 · vertical-slice
  sequencing · name `maestro` (`maestro::*`/`maestro:*`, env `MAESTRO_*`) ·
  toolchain pnpm + TS strict ESM + vitest + zod + biome + tsup.

---

## 0. Why this milestone exists

Two things must exist before any feature work: a buildable monorepo, and a single
authoritative set of shared types/contracts the reconciler and adapters agree on.
The previous attempt had a contracts file but it under-specified two seams
(closed-issue cleanup; the subprocess exec seam), so independently-written plans
diverged and contradicted. M0 fixes that by making the contract complete enough
that the reconciler's behaviour is fully determined before a forge is implemented.

**Exit gate (must all hold before M1 starts):**

1. `pnpm install && pnpm -r build && pnpm -r typecheck` clean.
2. `pnpm -r test` runs (zero tests is fine; the runner must be wired).
3. `pnpm lint` (biome) clean.
4. The config + WORKFLOW zod schemas round-trip the sample files in §0.6 (a test
   parses `maestro.config.yaml` and `templates/WORKFLOW.md` and re-serializes
   without loss of meaning).
5. CI runs typecheck + test + lint on push.
6. Every type/interface in §0.2–§0.7 exists in `packages/core/src/contracts/`
   and is exported; nothing imports a forge implementation.

---

## 0.1 Repo scaffolding (tasks)

```
maestro/
├── package.json                 # root; private; workspaces; scripts
├── pnpm-workspace.yaml          # packages/*
├── tsconfig.base.json           # strict, ESM, NodeNext, target ES2022
├── biome.json                   # lint + format
├── vitest.config.ts             # workspace-aware
├── .gitignore                   # workspaces/, logs/, .env, dist/, node_modules/
├── .env.example                 # MAESTRO_GITLAB_TOKEN=, MAESTRO_GITHUB_TOKEN=
├── maestro.config.yaml          # sample watchlist (see §0.6)
├── templates/WORKFLOW.md        # default onboarding template (see §0.6)
├── packages/
│   ├── core/                    # contracts + all logic; zero process.argv, zero HTTP server
│   │   ├── src/contracts/       # THIS DOC, as code. No I/O.
│   │   ├── src/...              # filled by M1–M5
│   │   └── tsconfig.json
│   ├── cli/                     # thin; depends on core; builds dist/daemon.js + dist/cli.js (tsup)
│   └── web/                     # thin read-only dashboard; depends on core
└── docs/, README.md
```

- [ ] root `package.json` (`"type": "module"`, `packageManager: pnpm@<pinned>`),
      scripts: `build`, `typecheck`, `test`, `lint`, `dev`.
- [ ] `pnpm-workspace.yaml`, `tsconfig.base.json` (strict: true, noUncheckedIndexedAccess,
      exactOptionalPropertyTypes), per-package `tsconfig.json` with project refs.
- [ ] `packages/{core,cli,web}` skeletons; `core` has no dependency on `cli`/`web`.
- [ ] `vitest.config.ts`, `biome.json`, `.gitignore`, `.env.example`.
- [ ] sample `maestro.config.yaml`, `templates/WORKFLOW.md` (§0.6).
- [ ] CI stub: `.github/workflows/ci.yml` (or `.gitlab-ci.yml`) → `pnpm install --frozen-lockfile && pnpm -r typecheck && pnpm -r test && pnpm lint`.
- [ ] `packages/core/src/contracts/index.ts` exporting everything in §0.2–§0.7.

**No business logic lands in M0.** Contracts are types + zod schemas + the exec
seam interface + pure helpers (label name builders, state derivation enums). Their
implementations arrive in M1+.

---

## 0.2 Normalized forge model (`contracts/forge-model.ts`)

The reconciler only ever sees this. `glab`/`gh` differences are erased by the adapter.

```ts
export type ForgeKind = 'gitlab' | 'github';

/** Lifecycle states. Order matters for board list ordering (§11). */
export type LifecycleState =
  | 'new'          // assigned to bot, no maestro:: label
  | 'in-progress'
  | 'in-review'
  | 'blocked'
  | 'done';        // issue closed (terminal)
// 'handoff' is NOT a label — it is a transient computed step (see §0.4 / M4).

export interface ForgeUser {
  username: string;          // canonical handle, no '@'
  id: string;                // forge-native id as string
}

export interface Label {
  name: string;              // e.g. 'maestro::in-progress' (GitLab) or 'maestro:in-progress' (GitHub)
  id?: string;               // forge-native; optional (GitHub addresses labels by name)
}

export interface Issue {
  iid: number;               // per-project issue number (GitLab iid / GitHub number)
  id: string;                // global id as string
  title: string;
  body: string;              // description; attacker-controlled on public repos (§13.1)
  state: 'open' | 'closed';
  assignees: ForgeUser[];
  labels: string[];          // names only
  author: ForgeUser;
  webUrl: string;
  /** Who performed the most recent assignment/label add, when known — for trigger guard (§13.1). */
  lastActor?: ForgeUser;
}

export interface MergeRequest { // MR≡PR throughout
  iid: number;
  id: string;
  title: string;
  description: string;        // the agent's durable scratchpad: plan + checkbox todo (§9)
  state: 'opened' | 'merged' | 'closed';
  isDraft: boolean;
  sourceBranch: string;
  targetBranch: string;
  assignees: ForgeUser[];
  labels: string[];
  approvals: ApprovalState;
  webUrl: string;
  /** linkage back to the issue this MR Closes (parsed from body or API), if resolvable */
  closesIssueIid?: number;
}

export interface ApprovalState {
  approved: boolean;         // GitLab: ≥1 required approval met; GitHub: a review with state APPROVED exists and none later request changes
  approvedBy: ForgeUser[];
  changesRequested: boolean; // GitHub: latest review state CHANGES_REQUESTED; GitLab: an unresolved blocking thread OR explicit unapprove (adapter decides — see §0.4 note)
}

export interface Comment {
  id: string;
  author: ForgeUser;
  body: string;
  createdAt: string;         // ISO 8601
}

/** Everything the reconciler needs about ONE issue, gathered by the adapter in one snapshot. */
export interface IssueSnapshot {
  repo: RepoRef;
  issue: Issue;
  mr?: MergeRequest;         // the maestro MR for this issue, if one exists
  recentComments: Comment[]; // newest-first; bounded (adapter caps, e.g. last 50)
}

export interface RepoRef {
  forge: ForgeKind;
  host: string;              // gitlab.com / github.com / self-hosted
  project: string;           // 'group/repo' (GitLab path) or 'org/repo' (GitHub)
  url: string;               // canonical url as configured
}
```

---

## 0.3 Forge adapter interface (`contracts/forge-adapter.ts`)

The **only** forge-aware seam. GitLab (M2) is the reference impl; GitHub (M7) is
built against this exact surface. All methods are idempotent where the spec's
idempotency claim (§13) requires it — re-issuing a create when the object exists
must no-op-or-return-existing, not error.

```ts
export interface ForgeAdapter {
  readonly kind: ForgeKind;

  // --- discovery ---
  /** Open issues assigned to bot_user in this repo. Drives active lifecycle. */
  listAssignedOpenIssues(repo: RepoRef): Promise<Issue[]>;
  /** Full snapshot for one issue (issue + its maestro MR + recent comments). */
  getSnapshot(repo: RepoRef, issueIid: number): Promise<IssueSnapshot>;
  /** State of ONE issue by iid regardless of open/closed — used by the cleanup sweep (§0.5). */
  getIssueState(repo: RepoRef, issueIid: number): Promise<'open' | 'closed' | 'missing'>;

  // --- mutation (all idempotent) ---
  createBranch(repo: RepoRef, name: string, fromRef: string): Promise<void>;
  createDraftMR(repo: RepoRef, args: CreateMRArgs): Promise<MergeRequest>;
  updateMRDescription(repo: RepoRef, mrIid: number, body: string): Promise<void>;
  setDraft(repo: RepoRef, mrIid: number, draft: boolean): Promise<void>;
  assignMR(repo: RepoRef, mrIid: number, username: string): Promise<void>;
  mergeMR(repo: RepoRef, mrIid: number, strategy: MergeStrategy, deleteSource: boolean): Promise<void>;

  setIssueLabels(repo: RepoRef, issueIid: number, set: string[], unset: string[]): Promise<void>;
  commentIssue(repo: RepoRef, issueIid: number, body: string): Promise<void>;
  commentMR(repo: RepoRef, mrIid: number, body: string): Promise<void>;

  // --- onboarding / setup (§11, §16) ---
  ensureLabels(repo: RepoRef, labels: Label[]): Promise<void>;     // create missing; no-op existing
  ensureBoard?(repo: RepoRef, orderedLabels: Label[]): Promise<void>; // GitLab only; undefined on GitHub
  createIssue(repo: RepoRef, args: CreateIssueArgs): Promise<Issue>;
}

export interface CreateMRArgs {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;   // includes `Closes #N`
  draft: true;           // maestro always opens draft
  assignToBot: boolean;
}
export interface CreateIssueArgs {
  title: string;
  body: string;
  assignToBot: boolean;  // for the bootstrap "define my workflow" issue (§16)
}
export type MergeStrategy = 'squash' | 'merge' | 'rebase';
```

**`changesRequested` definition (resolved, both forges):** the reconciler treats
"changes requested" as a signal to move `in-review → in-progress`. To stay
idempotent and avoid re-triggering on the same feedback, the adapter returns
`changesRequested: true` **only while the latest human review action is a
change-request that post-dates the MR's last bot commit.** Concretely the adapter
compares the timestamp of the newest change-request signal against the newest
bot-authored commit on the source branch; older feedback is considered already
addressed. (GitHub: latest review state per reviewer. GitLab: explicit unapprove
event or an unresolved discussion opened after the last bot push.) This makes the
transition edge-triggered without the reconciler storing anything.

---

## 0.4 Reconciler contract (`contracts/reconciler.ts`)

Pure function. **No I/O.** Takes a snapshot + resolved repo settings, returns **at
most one** intent. This is the brain; M1 implements it TDD against §7.

```ts
export interface RepoSettings {     // resolved = config defaults ⊕ repo overrides ⊕ WORKFLOW front matter
  repo: RepoRef;
  botUser: string;                 // precedence: WORKFLOW.bot_user wins; config defaults.bot_user is fallback (AM-5)
  trigger: TriggerGuard;            // §13.1
  git: { defaultBranch: string; target: string; mergeStrategy: MergeStrategy; deleteSourceBranch: boolean };
  manageBoard: boolean;
  labels: LabelNames;              // namespaced names for this forge (§0.7)
  concurrency: { globalMax: number; maxActive: number }; // resolved caps; M5 does the accounting (AM-3)
}

export interface TriggerGuard {
  requireLabel: string | null;
  allowedActors: string[];         // empty = no actor restriction
}

/** The single source of truth for "should we act on this issue at all". */
export interface ReconcileInput {
  snapshot: IssueSnapshot;
  settings: RepoSettings;
  /** true if a concurrency slot is available this tick for NEW active work (§14). */
  slotAvailable: boolean;
  /** does a live workspace dir exist for this issue? (cleanup decisions, §0.5) */
  workspaceExists: boolean;
  /** true iff M4's crash-recovery predicate fires: agent reached `done` (sentinel
   *  comment present + all MR todo boxes checked) but the MR is still draft / the
   *  reviewer is not yet assigned. M5 computes it (using M4's detector); the
   *  reconciler reads it to emit the standalone `handoff` intent on recovery.
   *  Amendment AM-1 (§0.10). */
  workComplete: boolean;
}

export type Intent =
  | { kind: 'none'; reason: string }
  | { kind: 'start-new'; branch: string; mrTitle: string }                  // New → create branch+draft MR, label in-progress, comment, run agent
  | { kind: 'run-agent'; resume: boolean; feedback?: AgentFeedback }        // In-progress → invoke runner (consumes slot)
  | { kind: 'handoff'; }                                                    // agent emitted done → proof+assign sequence (M4)
  | { kind: 'poll-review'; }                                                // In-review → just re-read next tick (no-op action)
  | { kind: 'apply-changes-requested'; feedback: AgentFeedback }           // In-review + changes → back to in-progress
  | { kind: 'merge'; strategy: MergeStrategy; deleteSource: boolean }       // In-review + approved → merge
  | { kind: 'cleanup'; }                                                    // terminal → evict workspace (§0.5)
  | { kind: 'blocked-wait'; }                                               // maestro::blocked → do nothing, wait for human
  | { kind: 'skip-untrusted'; reason: string };                            // trigger guard rejected (§13.1)

export interface AgentFeedback {
  reviewComments: Comment[];       // the human feedback to feed the agent
}

export function reconcile(input: ReconcileInput): Intent; // total, deterministic, side-effect free
```

**Reconciler rules baked into M1 tests (derived from §7 + the guards):**

0. **Terminal check first — exempt from the trigger guard.** If `issue.state ===
   'closed'` it is terminal: if `workspaceExists` → `cleanup`, else `none`. This
   runs *before* the trigger guard because a Done issue may have been unassigned
   on close; guarding first would suppress cleanup and leak the workspace (the
   bug that broke the prior plan set — see §0.5). Cleanup is never gated by trust:
   evicting our own cache is always safe. Amendment AM-2 (§0.10).
1. **Trigger guard (open issues only).** If the issue is open and
   `settings.trigger` is unsatisfied (not assigned to bot, or `requireLabel`
   absent, or `lastActor` not in a non-empty `allowedActors`) → `skip-untrusted`.
   No state, no labels touched.
2. **State derivation** is a pure function of `(issue.state, labels, mr, approvals,
   workComplete)`:
   - open, no `maestro::*` label → `new`. If `slotAvailable` → `start-new`; else `none` (queued).
   - `maestro::in-progress` → if `workComplete` (crash-recovery: §0.4 note + AM-1)
     → `handoff`; else if `slotAvailable` → `run-agent{resume:true}`; else `none`.
   - `maestro::in-review` → if `approvals.approved` → `merge`; else if
     `approvals.changesRequested` → `apply-changes-requested`; else `poll-review`.
   - `maestro::blocked` → `blocked-wait`.
3. **At most one intent per tick.** Never returns a list.
4. **Idempotent:** the same snapshot always yields the same intent. Re-running a
   tick that already started an MR sees the label and does not re-create.

**"agent's last result was done" note:** the reconciler is pure and cannot run
the agent. The *daemon* (M5) is what invokes the runner for a `run-agent` intent
and, on a `done` result, performs the handoff sequence (M4) within the same tick —
OR the runner records doneness by the agent itself flipping a marker the next
snapshot reveals. **Resolution (frozen):** the agent does NOT self-label. The
daemon, upon receiving `status: "done"` from the runner, immediately executes the
handoff sequence (M4) — it does not wait for a future tick. So `handoff` as a
standalone reconciler intent only arises on **crash recovery**: if a previous tick
ran the agent to `done` but died before completing handoff, the next tick must
re-detect "work is complete but MR still draft / reviewer not assigned" and
resume handoff. M4 defines that idempotent detection (a draft MR whose todo boxes
are all checked + a `done` sentinel comment). This keeps statelessness intact.

---

## 0.5 Cleanup / closed-issue resolution (THE fix for the prior contradiction)

**Problem that rotted the last plans:** `listAssignedOpenIssues` returns only open
issues, so a closed (Done) issue is never observed and its workspace is never
evicted — yet cleanup tests required observing closed issues. Self-contradiction.

**Resolution (frozen): cleanup is driven by the workspace cache, not the issue list.**
Each tick the daemon runs two independent passes per repo:

1. **Lifecycle pass** — `listAssignedOpenIssues` → reconcile each → act. Drives
   New/in-progress/in-review/blocked. Never sees closed issues. Correct.
2. **Cleanup sweep** — list the dirs under `workspaces/` belonging to this repo.
   For each, call `getIssueState(repo, iid)`. If `closed` or `missing` → emit a
   `cleanup` intent (evict the dir, drop cache). If `open`, leave it.

This makes `workspaces/` the legible signal that cleanup is pending (consistent
with the spec's "workspaces/ is pure cache, re-derivable"). Statelessness holds:
truth is `issue.state` (GitLab) + dir presence (disk). After eviction the dir is
gone, so the sweep no longer observes it — stable fixpoint. The reconciler stays
pure; the sweep is a daemon concern (M5) that *uses* `getIssueState` + the
`cleanup` intent shape. **M1 reconciler tests cover the `cleanup` branch via
`ReconcileInput.workspaceExists`; M5 wires the sweep.** No plan may reintroduce
"iterate closed issues in the lifecycle pass."

---

## 0.6 Config & WORKFLOW schemas (`contracts/config-schema.ts`, `contracts/workflow-schema.ts`)

zod schemas; the schema IS the type (`z.infer`). Validate-before-reload (§5).
Durations (`30s`, `5m`) parse via a `zDuration` helper → milliseconds.

```ts
// maestro.config.yaml  (§5)
export const ConfigSchema = z.object({
  defaults: z.object({
    poll_interval_active: zDuration.default('30s'),
    poll_interval_idle: zDuration.default('5m'),
    poll_jitter: zDuration.default('5s'),
    bot_user: z.string(),
    concurrency: z.object({ global_max: z.number().int().positive() }).default({ global_max: 2 }),
    workspaces: z.object({
      root: z.string().default('./workspaces'),
      disk_cap: zByteSize.default('20GB'),
      cleanup: z.enum(['lru', 'on_terminal']).default('lru'),
    }).default({}),
  }),
  forges: z.object({
    gitlab: z.object({ host: z.string(), token_env: z.string() }).optional(),
    github: z.object({ host: z.string(), token_env: z.string() }).optional(),
  }),
  repos: z.array(z.object({
    url: z.string(),                       // host inferred → ForgeKind
    overrides: z.object({
      concurrency: z.object({ max_active: z.number().int().positive() }).optional(),
    }).partial().optional(),
  })),
});

// WORKFLOW.md front matter  (§6)
export const WorkflowSchema = z.object({
  forge: z.enum(['gitlab', 'github']).optional(),  // inferred from host if omitted
  project: z.string(),
  bot_user: z.string(),
  manage_board: z.boolean().default(true),
  trigger: z.object({
    assignee: z.literal('bot').default('bot'),
    require_label: z.string().nullable().default(null),
    allowed_actors: z.array(z.string()).default([]),
  }).default({}),
  proof: z.object({
    type: z.enum(['playwright', 'test-output', 'diff-summary', 'none']),
    command: z.string().optional(),
  }),
  git: z.object({
    default_branch: z.string().default('main'),
    target: z.string().default('main'),
    merge_strategy: z.enum(['squash', 'merge', 'rebase']).default('squash'),
    delete_source_branch: z.boolean().default(true),
  }),
  environment: z.object({
    base_url: z.string().optional(),
    start_command: z.string().optional(),
    seed_command: z.string().optional(),
    health_check: z.string().optional(),
  }).partial().default({}),
  claude: z.object({
    command: z.string().default('claude'),
    max_turns: z.number().int().positive().default(40),
    permission_mode: z.string().default('acceptEdits'),
  }).default({}),
  concurrency: z.object({ max_active: z.number().int().positive() }).default({ max_active: 2 }),
});
// The prompt BODY (markdown after front matter) is carried separately as `promptBody: string`.
```

Sample `maestro.config.yaml` and `templates/WORKFLOW.md` shipped in M0 are the
round-trip fixtures for the exit gate.

---

## 0.7 Label namespacing helper (`contracts/labels.ts`)

```ts
export interface LabelNames {
  inProgress: string; inReview: string; blocked: string;
  all(): string[];                 // ordered for board lists (§11)
}
export function labelNames(forge: ForgeKind): LabelNames {
  const sep = forge === 'gitlab' ? '::' : ':';   // maestro::x vs maestro:x
  // ...
}
```

GitHub mutual exclusion (only one `maestro:*` at a time) is enforced in the M7
adapter's `setIssueLabels` (unset the others), not in the reconciler. GitLab gets
it free from scoped labels.

---

## 0.8 Shared exec seam (`contracts/exec.ts`) — resolved seam for glab/gh/git/claude

All subprocess work (glab, gh, git, claude, proof commands) goes through one
injectable seam so adapters/runner are unit-testable without real binaries.

```ts
export interface ExecResult { code: number; stdout: string; stderr: string; }
export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  input?: string;             // stdin — how prompt+context reach `claude` (AM-7); keeps attacker-shaped issue text off argv
  signal?: AbortSignal;       // cooperative cancel — backs the runner stall-kill (AM-4)
}
export interface Exec {
  run(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  /** streaming variant for `claude -p --output-format stream-json` (§10) */
  stream(cmd: string, args: string[], opts: ExecOptions & { onLine: (line: string) => void }): Promise<ExecResult>;
  /** spawn-and-hold for long-running processes that never exit on their own —
   *  e.g. WORKFLOW `start_command` (`npm run dev`) during playwright proof (AM-6, M4). */
  spawn(cmd: string, args: string[], opts?: ExecOptions): SpawnHandle;
  /** TTY-inherited interactive launch for `maestro run <issue> --attach` (AM-8, M6).
   *  NOT the daemon path. Resolves with the child exit code. */
  attach(cmd: string, args: string[], opts?: ExecOptions): Promise<number>;
}
export interface SpawnHandle {
  kill(signal?: NodeJS.Signals): void;
  readonly exited: Promise<ExecResult>;
}
```

- The real impl wraps `node:child_process` (M2/M3). Tests inject a fake `Exec`.
- **Token handling (§5):** secrets are read from `process.env[token_env]` at the
  edge and passed via `ExecOptions.env` to the specific subprocess — never logged,
  never written to config, never placed on `argv`.
- **Clone auth (resolved):** the workspace manager (M3) clones using a tokenized
  remote built from `process.env[token_env]`, injected via `env`/credential helper,
  not embedded in a committed remote URL. M3 specifies the exact credential-helper
  invocation per forge.

---

## 0.9 Runner ↔ agent contract (`contracts/runner.ts`) (§10)

```ts
export type AgentStatus = 'done' | 'needs_input' | 'in_progress';
export interface AgentResult { status: AgentStatus; summary: string; }

export interface RunnerInput {
  workspaceDir: string;
  promptBody: string;          // WORKFLOW.md body + operating protocol (§9)
  context: { issue: Issue; mr?: MergeRequest; recentComments: Comment[] };
  claude: { command: string; maxTurns: number; permissionMode: string };
}
export interface Runner {
  run(input: RunnerInput): Promise<AgentResult>;   // cold session; parses final stream-json result
}
```

The daemon consumes **only** `AgentResult` from a run; everything else it re-reads
from the forge next tick (§10). `needs_input` → daemon sets `maestro::blocked`.
`done` → daemon runs the M4 handoff sequence. `in_progress` (e.g. hit max_turns) →
stays `maestro::in-progress`, resumes next tick.

---

## 0.10 Contract change log

Append an entry here (with date + reason) whenever a later milestone must amend a
frozen type. This is the audit trail that keeps plans honest.

All amendments below were raised by the M1–M8 planning fan-out as Open
Dependencies and reconciled centrally **before any code** — the discipline the
prior plan set skipped. All are **additive** (new fields/modules), so no earlier
plan is invalidated. Type bodies are in §0.12.

| ID | Milestone(s) | Change | Reason |
|---|---|---|---|
| — | M0 | Initial freeze | — |
| AM-1 | M1, M4, M5 | `ReconcileInput.workComplete: boolean` | Reconciler can't run the agent; needs the crash-recovery "work done but MR still draft" signal as input (M4 computes, M5 wires). |
| AM-2 | M1 | §0.4 terminal-before-guard ordering | A closed/Done issue may be unassigned; guarding first suppressed cleanup → leaked workspace (the prior contradiction). |
| AM-3 | M1, M5 | `RepoSettings.concurrency:{globalMax,maxActive}` | Resolved caps need a typed home; M5 does the accounting. |
| AM-4 | M3 | `ExecOptions.signal?: AbortSignal` | Runner stall-kill (§13) needs a cancel primitive. |
| AM-5 | M1 | `bot_user` precedence: WORKFLOW > config default | Two sources existed; pick one deterministically. |
| AM-6 | M4 | `Exec.spawn(): SpawnHandle` | `start_command` never exits; playwright cold-boot needs spawn-and-hold + teardown. |
| AM-7 | M3 | prompt/context via `ExecOptions.input` (stdin) | Keep attacker-shaped issue text off argv/process table; avoid argv limits. |
| AM-8 | M6 | `Exec.attach(): Promise<number>` | `maestro run --attach` needs a TTY-inherited interactive launch, distinct from the headless daemon path. |
| AM-9 | M1, M2, M7 | `contracts/naming.ts` (`branchName`, `mrTitle`) | `start-new` carries branch/MR-title; producer (M1) and consumer (adapters) need one shared format. |
| AM-10 | M4, M5 | `contracts/proof.ts` (`ProofInput`/`ProofResult`/`ProofStrategyKind`/`DONE_SENTINEL`) | Proof "returns artifacts" had no shape; handoff + workComplete share the sentinel marker. |
| AM-11 | M4, M5 | `contracts/handoff.ts` (`HandoffInput`, `HandoffFn`) | M4 owns the sequence, M5 invokes it; both need one pinned callable signature. |
| AM-12 | M5, M6 | `contracts/logs.ts` (`LogLine`, `LogReader`) | M5 writes the gitignored logs cache; CLI/web (M6) read it for `status`/`logs`/dashboard. |
| AM-13 | M8 | `contracts/bootstrap.ts` (`BOOTSTRAP_MARKER`) | Re-`add` must be idempotent; need a greppable marker on the "define my workflow" issue. |
| AM-14 | M1, M6 | export `deriveState(snapshot, settings): LifecycleState` | CLI/web need the display state without re-implementing the FSM; promote M1's internal helper. |
| AM-15 | M6 | `ReadOnlyForgeAdapter = Pick<ForgeAdapter, …reads>` | Compile-time guarantee the web dashboard can't mutate forge state. |

**Non-contract decisions recorded (no type impact, but binding on impl):**

- **NodeExec ownership:** M2 ships the real `node:child_process`-backed `Exec`
  (`NodeExec`) + shared `FakeExec`/fixture helpers; M3 and M7 reuse them.
- **botUser on adapter construction:** adapters take `botUser` as constructor
  config (an edge value, like the token), *not* a per-call argument — keeps the
  §0.3 method surface frozen.
- **GitLab draft mechanism:** read `work_in_progress`/`draft`; toggle via `Draft:`
  title prefix (most Free-tier/version-portable). GitHub uses its native `draft`
  field. Both normalize to `MergeRequest.isDraft`.
- **Clone auth:** per-clone `git -c credential.helper=…` reading the token from
  `ExecOptions.env`; plain (non-tokenized) committed remote. (§0.8 / M3.)
- **GitHub list contamination:** `gh` `/issues` includes PRs; `listAssignedOpenIssues`
  filters `pull_request` entries (M7). GitLab has no equivalent.
- **`ensureBoard` invocation:** the daemon calls `adapter.ensureBoard?.(…)` — GitHub
  leaves it undefined (labels only; Projects V2 deferred §17). No forge branching.
- **Stall-kill bound:** the runner kills + retries **once** in-process, then returns
  `in_progress` (the daemon re-runs next tick anyway). (M3.)
- **`maestro run` requires `--attach` in v1:** the daemon is the only headless path.
- **Public-repo opt-in via `maestro add --public`** (zero contract change) rather
  than a `RepoRef.visibility` field, matching §13.1 "explicit opt-in". (M8.)
- **Hot-reload safety:** M1's loader keeps last-good on invalid config; M5's file
  watcher logs-and-continues on a bad reload so a bad self-managed merge (§12) can't
  soft-brick the daemon. (M5/M8.)

---

## 0.11 Cross-cutting woven into M0

- **QA:** vitest wired; the round-trip schema test is the first test in the repo.
- **Security:** `.gitignore` covers `.env`; `.env.example` documents the token env
  var names only; a lint/CI check (M8 hardens it) asserts no token-looking literal
  is committed. The exec seam centralizes where secrets flow so the §13.1 audit
  has one place to look.

---

## 0.12 Reconciled contract modules (added by the M1–M8 fan-out)

These ship in M0 (`packages/core/src/contracts/`) alongside §0.2–§0.9 so every
downstream plan compiles against them. They are additive (see §0.10).

```ts
// contracts/naming.ts  (AM-9) — one shared branch/MR-title format
export function branchName(issue: Issue): string;   // e.g. `maestro/issue-<iid>-<slug>`
export function mrTitle(issue: Issue): string;       // e.g. `Draft: <issue.title> (Closes #<iid>)`

// contracts/proof.ts  (AM-10)
export type ProofStrategyKind = 'playwright' | 'test-output' | 'diff-summary' | 'none';
export interface ProofInput {
  workspaceDir: string;
  workflowProof: { type: ProofStrategyKind; command?: string };
  environment: WorkflowEnvironment;   // = z.infer of WorkflowSchema.environment (base_url/start_command/…)
  exec: Exec;
}
export interface ProofResult {
  ok: boolean;                        // false is NON-FATAL: handoff still completes, failure noted (M4 policy)
  kind: ProofStrategyKind;
  summary: string;                    // human-readable, posted in the proof comment
  artifacts?: { name: string; body: string }[];  // attachments the adapter renders
}
export interface ProofStrategy { run(input: ProofInput): Promise<ProofResult>; }
/** Sentinel the proof-comment writer emits and the crash-recovery predicate greps (AM-1 source). */
export const DONE_SENTINEL = '<!-- maestro:proof:done -->';

// contracts/handoff.ts  (AM-11) — M4 implements, M5 invokes
export interface HandoffInput {
  repo: RepoRef;
  issueIid: number;
  mrIid: number;
  ticketCreator: string;              // issue.author.username — the reviewer to assign
  settings: RepoSettings;
  adapter: ForgeAdapter;
  proof: ProofResult;
}
/** Executes the §7 ordering guarantee: proof-comment → assignMR → setDraft(false) →
 *  label in-review. Idempotent for crash recovery. */
export type HandoffFn = (input: HandoffInput) => Promise<void>;

// contracts/logs.ts  (AM-12) — M5 writes the gitignored logs/ cache; M6 reads it
export interface LogLine { ts: string; repo: string; issueIid: number; level: 'info' | 'warn' | 'error'; msg: string; }
export interface LogReader { readIssueLog(repo: RepoRef, issueIid: number, limit?: number): Promise<LogLine[]>; }

// contracts/bootstrap.ts  (AM-13)
export const BOOTSTRAP_MARKER = '<!-- maestro:bootstrap -->';  // on the "define my workflow" issue body, for idempotent re-add

// contracts/forge-adapter.ts  (AM-15) — compile-time read-only narrowing for the web dashboard
export type ReadOnlyForgeAdapter = Pick<
  ForgeAdapter,
  'kind' | 'listAssignedOpenIssues' | 'getSnapshot' | 'getIssueState'
>;

// contracts/reconciler.ts  (AM-14) — exported so CLI/web render state without re-deriving
export function deriveState(snapshot: IssueSnapshot, settings: RepoSettings): LifecycleState;
```

`WorkflowEnvironment` is `z.infer<typeof WorkflowSchema>['environment']` — referenced,
not redefined.
