# Maestro — Shared Contracts & File Layout (Plan 00)

> **Purpose:** the single source of truth for types, interfaces, file paths, tech
> stack, and conventions that **all** milestone plans (M1–M7) build against. No
> plan may invent a type, interface, or path not derivable from here. If a plan
> needs something missing, it records it under "Open questions" rather than
> inventing it. Spec: `docs/superpowers/specs/2026-06-03-maestro-design.md`.

## Tech stack (fixed)

- **Runtime:** Node 20+, TypeScript 5.x, ESM (`"type": "module"`).
- **Monorepo:** pnpm workspaces. Packages: `@maestro/core`, `@maestro/cli`, `@maestro/web`.
- **Tests:** Vitest. Tests colocated as `*.test.ts` next to source.
- **Schema/validation:** `zod` (config + WORKFLOW.md front matter).
- **Subprocess:** `execa` (for `git`, `glab`, `gh`, `claude`).
- **YAML:** `yaml`. **Front matter:** `gray-matter`.
- **CLI:** `commander`. **Web:** `fastify`.
- **Lint/format:** ESLint + Prettier (config in repo root).

## Monorepo file tree (canonical — plans MUST use these exact paths)

```
package.json                      # pnpm workspace root
pnpm-workspace.yaml
tsconfig.base.json
templates/WORKFLOW.md             # default WORKFLOW.md (M7)
packages/core/
  package.json
  src/
    domain/types.ts               # Issue, MergeRequest, Forge, LifecycleState, IssueSnapshot, Action
    domain/lifecycle.ts           # LIFECYCLE_STATES, label helpers
    config/schema.ts              # MaestroConfig (zod + inferred type)
    config/load.ts                # loadConfig(path), watchConfig(path, cb)
    workflow/schema.ts            # WorkflowConfig (zod + inferred type)
    workflow/load.ts              # loadWorkflow(repoDir), parseWorkflow(raw)
    forge/adapter.ts              # ForgeAdapter interface + ForgeError
    forge/memory.ts               # MemoryForge (M1)
    forge/gitlab.ts               # GitLabForge via glab (M2)
    forge/github.ts               # GitHubForge via gh (M6)
    forge/factory.ts              # createForge(forge, repo, deps)
    reconciler/derive.ts          # deriveLifecycle(issue, mr)
    reconciler/decide.ts          # decideAction(snapshot, ctx) — PURE
    reconciler/index.ts           # reconcileRepo(...) — orchestrates derive+decide+execute
    workspace/manager.ts          # WorkspaceManager (clone/reuse/cleanup, LRU cap) (M3)
    agent/contract.ts             # AgentResult, parseAgentResult(streamJson)
    agent/protocol.ts             # DEFAULT_PROTOCOL prompt fragments (M7 uses for template)
    agent/runner.ts               # ClaudeRunner.run(workspaceDir, prompt, opts) (M3)
    proof/index.ts                # ProofStrategy, runProof(type, ctx) (M4)
    proof/playwright.ts           # (M4)
    proof/testOutput.ts           # (M4)
    proof/diffSummary.ts          # (M4)
    daemon/scheduler.ts           # per-repo cadence + jitter (adaptive polling)
    daemon/loop.ts                # tick(): fetch→reconcile→dispatch w/ concurrency
    daemon/state.ts               # in-memory RunState (running slots, no persistence)
    bootstrap/onboard.ts          # onboardRepo(repo) — WORKFLOW.md self-creation (M7)
    logger.ts                     # structured logger (issue_number, forge, mr_number)
    index.ts                      # public exports
packages/cli/
  package.json
  src/
    index.ts                      # commander setup
    daemon.ts                     # daemon entrypoint (systemd ExecStart target)
    commands/add.ts               # `maestro add <url>`
    commands/list.ts              # `maestro list`
    commands/status.ts            # `maestro status`
    commands/logs.ts              # `maestro logs`
    commands/run.ts               # `maestro run <issue> --attach`
packages/web/
  package.json
  src/
    server.ts                     # fastify app factory
    routes.ts                     # GET / (dashboard), GET /api/state
```

## Domain types (`packages/core/src/domain/types.ts`)

```ts
export type Forge = 'gitlab' | 'github';

export type LifecycleState =
  | 'new'          // assigned to bot, no maestro lifecycle label
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done';        // issue closed

// Normalized, forge-agnostic issue.
export interface Issue {
  id: string;            // forge-internal id (opaque)
  number: number;        // human-facing #N
  title: string;
  body: string;
  state: 'open' | 'closed';
  assignees: string[];   // usernames
  authorUsername: string;
  labels: string[];      // raw labels (may include maestro lifecycle labels)
  createdAt: string;     // ISO 8601
  webUrl: string;
}

// Normalized MR (GitLab) / PR (GitHub).
export interface MergeRequest {
  id: string;
  number: number;
  sourceBranch: string;
  targetBranch: string;
  isDraft: boolean;
  state: 'open' | 'merged' | 'closed';
  approved: boolean;            // GitLab approval OR GitHub review state APPROVED
  changesRequested: boolean;    // a reviewer requested changes / unapproved
  reviewers: string[];
  linkedIssueNumbers: number[]; // from "Closes #N"
  webUrl: string;
}

export interface IssueSnapshot {
  issue: Issue;
  mr: MergeRequest | null;
  lifecycle: LifecycleState;    // derived via deriveLifecycle()
}

// One action per issue per tick. `noop` means nothing to do this tick.
export type Action =
  | { kind: 'claim'; issueNumber: number }       // new → create branch+draft MR, label in_progress
  | { kind: 'work'; issueNumber: number }        // run/resume agent (consumes a slot)
  | { kind: 'handoff'; issueNumber: number }     // proof → comment → assign reviewer → ready → in_review
  | { kind: 'review_check'; issueNumber: number }// poll approval; approved→merge, changes→in_progress
  | { kind: 'merge'; issueNumber: number }
  | { kind: 'cleanup'; issueNumber: number }     // terminal → drop workspace
  | { kind: 'block'; issueNumber: number; reason: string }
  | { kind: 'noop'; issueNumber: number };

export type MergeStrategy = 'squash' | 'merge' | 'rebase';
```

## Lifecycle labels (`packages/core/src/domain/lifecycle.ts`)

```ts
import type { Forge, LifecycleState } from './types.js';

// Lifecycle states that map to a label (excludes 'new' and 'done').
export const LABELED_STATES = ['in_progress', 'in_review', 'blocked'] as const;
export type LabeledState = (typeof LABELED_STATES)[number];

// GitLab uses scoped labels (mutually exclusive): `maestro::in_progress`.
// GitHub uses flat labels: `maestro:in_progress` (exclusivity enforced by adapter).
export function lifecycleLabel(forge: Forge, state: LabeledState): string {
  return forge === 'gitlab' ? `maestro::${state}` : `maestro:${state}`;
}

// All maestro-owned labels for a forge (used to create labels and to strip).
export function allMaestroLabels(forge: Forge): string[] {
  return LABELED_STATES.map((s) => lifecycleLabel(forge, s));
}

// Extract the lifecycle state encoded in a label set, if any.
export function labeledStateOf(forge: Forge, labels: string[]): LabeledState | null {
  for (const s of LABELED_STATES) {
    if (labels.includes(lifecycleLabel(forge, s))) return s;
  }
  return null;
}
```

## ForgeAdapter (`packages/core/src/forge/adapter.ts`)

```ts
import type { Forge, Issue, MergeRequest, LifecycleState, MergeStrategy } from '../domain/types.js';

export class ForgeError extends Error {
  constructor(message: string, readonly cause?: unknown) { super(message); }
}

export interface CreateMrArgs {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  body: string;          // includes "Closes #N"
  draft: boolean;
}

export type CommentTarget =
  | { type: 'issue'; number: number }
  | { type: 'mr'; number: number };

export interface ForgeAdapter {
  readonly forge: Forge;
  readonly project: string;       // gitlab path or github org/repo
  readonly botUser: string;

  // --- reads ---
  listAssignedOpenIssues(): Promise<Issue[]>;            // assigned to botUser, state open
  getIssue(issueNumber: number): Promise<Issue | null>;
  listOpenMrsByBot(): Promise<MergeRequest[]>;
  getMrForIssue(issueNumber: number): Promise<MergeRequest | null>;

  // --- writes ---
  createBranch(name: string, fromRef: string): Promise<void>;
  createDraftMr(args: CreateMrArgs): Promise<MergeRequest>;
  setMrReady(mrNumber: number): Promise<void>;           // un-draft
  updateMrDescription(mrNumber: number, body: string): Promise<void>;
  assignReviewer(mrNumber: number, username: string): Promise<void>;
  mergeMr(mrNumber: number, strategy: MergeStrategy, deleteSource: boolean): Promise<void>;
  comment(target: CommentTarget, body: string): Promise<void>;

  // Set exactly one lifecycle label (or none for 'new'/'done'), removing the rest.
  setLifecycleLabel(issueNumber: number, state: LifecycleState): Promise<void>;

  // --- setup (idempotent) ---
  ensureLabels(): Promise<void>;   // create maestro labels if absent
  ensureBoard(): Promise<void>;    // GitLab: board + lists. GitHub: no-op (Projects V2 deferred).
}
```

## Reconciler (pure) — `reconciler/derive.ts` & `reconciler/decide.ts`

```ts
// derive.ts
import type { Issue, MergeRequest, LifecycleState, Forge } from '../domain/types.js';

export function deriveLifecycle(forge: Forge, issue: Issue, mr: MergeRequest | null): LifecycleState;
// Rules:
//  issue.state === 'closed'                              -> 'done'
//  labeledStateOf == 'blocked'                           -> 'blocked'
//  labeledStateOf == 'in_review'                         -> 'in_review'
//  labeledStateOf == 'in_progress'                       -> 'in_progress'
//  assigned to bot && no maestro label                   -> 'new'
//  else                                                  -> 'new' (treated as unclaimed)
```

```ts
// decide.ts
import type { IssueSnapshot, Action } from '../domain/types.js';

export interface DecideContext {
  triggerOk: boolean;     // trigger guard (assignee/require_label/allowed_actors) satisfied
  agentDone: boolean;     // last agent run returned status 'done'
  agentNeedsInput: boolean;
}

// PURE. Maps a snapshot + context to exactly one Action. No I/O.
export function decideAction(snapshot: IssueSnapshot, ctx: DecideContext): Action;
// Mapping (state -> action):
//  new && triggerOk            -> claim
//  new && !triggerOk           -> noop
//  in_progress && agentNeedsInput -> block
//  in_progress && agentDone    -> handoff
//  in_progress                 -> work
//  in_review (mr.approved)     -> merge
//  in_review (mr.changesRequested) -> work        // (reconciler also flips label to in_progress)
//  in_review                   -> review_check
//  blocked                     -> noop
//  done                        -> cleanup
```

## Config schema (`packages/core/src/config/schema.ts`)

```ts
export interface ForgeAuth { host: string; tokenEnv: string; }   // tokenEnv = NAME of env var
export interface ConcurrencyCfg { globalMax?: number; maxActive?: number; }
export interface WorkspacesCfg { root: string; diskCap: string; cleanup: 'lru' | 'on_terminal'; }

export interface RepoEntry { url: string; overrides?: Partial<DefaultsCfg>; }

export interface DefaultsCfg {
  pollIntervalActive: string;   // e.g. "30s"
  pollIntervalIdle: string;     // e.g. "5m"
  pollJitter: string;           // e.g. "5s"
  botUser: string;
  concurrency: ConcurrencyCfg;
  workspaces: WorkspacesCfg;
}

export interface MaestroConfig {
  defaults: DefaultsCfg;
  forges: Partial<Record<Forge, ForgeAuth>>;
  repos: RepoEntry[];
}
// load.ts exports: loadConfig(path): MaestroConfig  and  watchConfig(path, cb): () => void
// Durations parsed by a shared parseDuration(s: string): number (ms) helper in config/schema.ts.
```

## WORKFLOW.md schema (`packages/core/src/workflow/schema.ts`)

```ts
export type ProofType = 'playwright' | 'test-output' | 'diff-summary' | 'none';
export type PermissionMode = 'acceptEdits' | 'plan' | 'default' | 'bypassPermissions';

export interface TriggerCfg {
  assignee: 'bot';
  requireLabel: string | null;
  allowedActors: string[];      // empty => any actor with perms
}

export interface WorkflowConfig {
  forge: Forge;                 // inferred from host if omitted in file
  project: string;
  botUser: string;
  manageBoard: boolean;
  trigger: TriggerCfg;
  proof: { type: ProofType; command?: string };
  git: { defaultBranch: string; target: string; mergeStrategy: MergeStrategy; deleteSourceBranch: boolean };
  environment?: { baseUrl?: string; startCommand?: string; seedCommand?: string; healthCheck?: string };
  claude: { command: string; maxTurns: number; permissionMode: PermissionMode };
  concurrency: ConcurrencyCfg;
  promptBody: string;           // the markdown body after front matter
}
// load.ts: parseWorkflow(raw: string): WorkflowConfig ; loadWorkflow(repoDir: string): WorkflowConfig | null
```

## Agent contract (`packages/core/src/agent/contract.ts`)

```ts
export type AgentStatus = 'done' | 'needs_input' | 'in_progress';

export interface AgentResult {
  status: AgentStatus;
  summary: string;
}

// Parse the final result object out of `claude -p --output-format stream-json` output.
// The agent is instructed (via protocol) to end with a fenced JSON block:
//   {"status":"done|needs_input|in_progress","summary":"..."}
export function parseAgentResult(streamJsonStdout: string): AgentResult;
```

## ClaudeRunner (`packages/core/src/agent/runner.ts`)

```ts
export interface RunnerOpts {
  command: string;            // workflow.claude.command, e.g. "claude"
  maxTurns: number;
  permissionMode: PermissionMode;
}
export interface ClaudeRunner {
  // Runs `<command> -p --output-format stream-json --permission-mode <mode> ...` in cwd,
  // feeding `prompt` on stdin. Resolves with the parsed AgentResult.
  run(cwd: string, prompt: string, opts: RunnerOpts): Promise<AgentResult>;
}
```

## ProofStrategy (`packages/core/src/proof/index.ts`)

```ts
export interface ProofArtifact { path: string; kind: 'video' | 'image' | 'text'; caption: string; }
export interface ProofContext {
  workspaceDir: string;
  workflow: WorkflowConfig;
}
export interface ProofStrategy { run(ctx: ProofContext): Promise<ProofArtifact[]>; }
export function runProof(ctx: ProofContext): Promise<ProofArtifact[]>;  // dispatches on ctx.workflow.proof.type
```

## WorkspaceManager (`packages/core/src/workspace/manager.ts`)

```ts
export interface WorkspaceManager {
  // Clone repo (or reuse existing) for an issue; checkout/create the issue branch. Returns dir.
  ensure(repoUrl: string, issueNumber: number, branch: string): Promise<string>;
  remove(repoUrl: string, issueNumber: number): Promise<void>;      // terminal cleanup
  enforceDiskCap(capBytes: number): Promise<void>;                  // LRU eviction of terminal/oldest
  pathFor(repoUrl: string, issueNumber: number): string;            // sanitized, MUST stay under root
}
```

## Branch & MR conventions (fixed)

- Branch name: `maestro/issue-<number>` off `workflow.git.defaultBranch`.
- MR/PR title: `<issue.title>` ; body MUST contain `Closes #<number>`.
- MR description is the agent's living plan/checklist (rewritten by the agent).
- Issue/MR comments are append-only progress log.

## Conventions for all plans

- **TDD:** failing test → run (see it fail) → minimal impl → run (pass) → commit. Bite-sized steps.
- **Commits:** Conventional Commits (`feat:`, `test:`, `fix:`, `chore:`). Stage explicit paths (no `git add .`). No `Co-Authored-By` trailer.
- **No persistence:** state lives in the forge + `maestro.config.yaml`. The only in-memory daemon state is `daemon/state.ts` (running slots), rebuilt from the forge on restart.
- **Pure reconciler:** `derive.ts` and `decide.ts` perform no I/O and import no adapter — unit-tested with plain objects.
- **Each plan ends with an "Open questions" section** listing anything the contracts did not cover (do NOT invent it in the plan).

---

# Addendum A — resolutions from cross-plan review (2026-06-03)

Filling gaps the M1–M7 plan-writers surfaced. These OVERRIDE the bodies above
where they conflict. Items marked **PENDING** await a user decision (see report).

## A1. Reconciler architecture (resolves M1 Q1/Q2, M3 Q2, M4 Q2)

`reconciler/index.ts` (owned by M1; `work` case filled by M3; `handoff`/
`review_check`/`merge` cases filled by M4) exports exactly:

```ts
export interface ReconcileDeps {
  adapter: ForgeAdapter;
  workflow: WorkflowConfig;
  config: MaestroConfig;
  repoUrl: string;
  workspace: WorkspaceManager;          // from workspace/manager.ts (M3)
  runner: ClaudeRunner;                  // from agent/runner.ts (M3)
  runProof: typeof import('../proof/index.js').runProof;  // (M4)
  slots: SlotManager;                    // concurrency gate, from daemon/state.ts
  clock: () => number;
}
export async function reconcileRepo(deps: ReconcileDeps): Promise<void>;
// internal: executeAction(action: Action, snapshot: IssueSnapshot, deps: ReconcileDeps): Promise<void>
```

There are **no per-executor deps bags**. Collaborator types are **imported from
their owning modules**, never re-declared structurally.

## A2. Agent status is consumed in the SAME tick (resolves M1 Q2)

The agent's `done`/`needs_input` is **not** remembered across ticks. The `work`
executor runs the agent, gets `AgentResult`, and acts immediately:
- `done` → run the **handoff** routine inline (proof → comment → assign reviewer →
  setMrReady → label `in_review`).
- `needs_input` → `block` (label + comment).
- `in_progress` → leave `in_progress`.

Therefore `DecideContext` drops `agentDone`/`agentNeedsInput`; `decideAction` maps
**only forge-derived lifecycle → action**: `in_progress → work` always. `handoff`
is an internal routine invoked by the `work` executor, **not** a decided Action
(the `Action.handoff` variant is retained as the routine's internal label but is
never returned by `decideAction`). This keeps state forge-durable and removes
cross-tick memory.

## A3. ForgeAdapter additions

Add to the `ForgeAdapter` interface:

```ts
createIssue(args: { title: string; body: string; assignee?: string }): Promise<Issue>;  // (M7 onboarding)
getMrDescription(mrNumber: number): Promise<string>;                                     // (M3 context read)
uploadArtifact(path: string): Promise<string>;  // returns markdown-embeddable ref — PENDING (see A9)
```

Add to `MergeRequest`: `description: string;` (the agent's living plan/checklist).

`getMrForIssue` locates the MR/PR **by head branch `maestro/issue-<number>`**
(both forges) — resolves M2 Q2 / M6 Q4. `reviewers` = **requested** reviewers
(resolves M6 Q7). `assignReviewer` MAY perform a username→id lookup on GitLab
(one extra call accepted — resolves M2 Q5).

## A4. Shared exec seam (resolves M2 Q8, M3, M6 Q2)

`packages/core/src/util/exec.ts` exports the single subprocess seam used by ALL
adapters and runners (injectable for tests):

```ts
export interface CommandRunner { run(cmd: string, args: string[], opts?: { cwd?: string; input?: string; env?: Record<string,string> }): Promise<{ stdout: string; stderr: string; exitCode: number }>; }
export const execaRunner: CommandRunner;   // production impl over execa
```

`createForge` and `ClaudeRunner` take a `CommandRunner` (default `execaRunner`).
No plan declares its own `ExecFn`/`CommandRunner`.

## A5. createForge signature (resolves M2 Q8, M5 Q4, M6 Q1)

```ts
// forge/factory.ts
export interface ForgeDeps { config: MaestroConfig; runner?: CommandRunner; fetchImpl?: typeof fetch; }
export function createForge(forge: Forge, repo: { url: string; project: string; botUser: string }, deps: ForgeDeps): ForgeAdapter;
```

`manageBoard` is enforced by the **caller** (daemon / `maestro add`): it calls
`ensureBoard()` only when `workflow.manageBoard` is true (resolves M2 Q6).

## A6. RunState + daemon IPC + config additions (resolves M5 Q1/Q2/Q3, M3 Q5)

```ts
// daemon/state.ts
export interface RunningEntry { repoUrl: string; issueNumber: number; lifecycle: LifecycleState; startedAt: number; }
export interface RunState { running: RunningEntry[]; queued: RunningEntry[]; totals: { active: number; watchedRepos: number }; }
export interface SlotManager { tryAcquire(repoUrl: string, issueNumber: number): boolean; release(repoUrl: string, issueNumber: number): void; snapshot(): RunState; }
```

- `DefaultsCfg` gains `web: { port: number; host: string }` (default `{ port: 7330, host: '127.0.0.1' }`).
- `maestro status` reaches the daemon via HTTP `GET http://<web.host>:<web.port>/api/state` (`MAESTRO_DAEMON_URL` overrides). Web is **read-only**, loopback by default.
- `config/schema.ts` adds `parseSize(s: string): number` (bytes; e.g. "20GB"). `enforceDiskCap` is called by `daemon/loop.ts` once per tick.

## A7. Workspace/clone/push conventions (resolves M3 Q3/Q4/Q6, M5 Q8)

- **Clone uses the forge CLI** (`glab repo clone` / `gh repo clone`) so tokens are
  handled by the CLI and never embedded in URLs or logs. `WorkspaceManager` takes
  the `CommandRunner` + the repo's `forge`.
- **Push:** plain `git push -u origin <branch>` (fast-forward). Agents must not
  amend pushed history; no `--force`.
- **Cleanup:** `cleanup: 'on_terminal'` → the `cleanup` action calls
  `workspace.remove`; `cleanup: 'lru'` → `daemon/loop.ts` calls `enforceDiskCap`
  per tick. Both modes may coexist.

## A8. Misc resolutions

- **`agent/protocol.ts` is owned solely by M3.** M7 **imports** `DEFAULT_PROTOCOL`
  for the template; it does NOT redefine it. (resolves the M3/M7 collision)
- `parseWorkflow(raw, forgeHint?: Forge)`: front-matter `forge` wins; else
  `forgeHint`; `loadWorkflow(repoDir, forgeHint)` derives the hint from the repo's
  configured host (resolves M1 Q3).
- `claim` MR title = `snapshot.issue.title` (resolves M1 Q4).
- zod schema export names are `MaestroConfigSchema` / `WorkflowConfigSchema`
  (resolves M7 Q4). `watchConfig(path, cb)` fires `cb` **only on change**, not
  initial load (resolves M7 Q5).
- `ProofArtifact.path` is **relative to `workspaceDir`** (resolves M4 Q3).
  Playwright base URL passed as env `PLAYWRIGHT_BASE_URL` (resolves M4 Q4).
- `mergeStrategy: 'rebase'` (GitLab) → call `PUT .../rebase` then merge; document
  reliance on project fast-forward setting if unavailable (resolves M2 Q4).
- **Version-pin `glab` and `gh`** and record one real JSON fixture per read method
  to lock field shapes (resolves M2 Q7, M6 Q6). Tracked as a setup task in M2.
- `maestro run <issue>` takes `--repo <url>`, defaulting to the sole watched repo
  (resolves M5 Q7). Daemon log = `logs/maestro.log`, JSON-lines; `maestro logs`
  prints last-N (resolves M5 Q6; `--follow` deferred).
- Booting/seeding a local instance for proof remains **deferred**; M4 assumes an
  already-running instance at `environment.baseUrl` (confirms M4 Q5, spec §17).

## A9. PENDING user decisions (do not finalize until resolved)

- **Proof artifact surfacing** (M4 Q1): add `uploadArtifact` so videos/screenshots
  embed inline, vs. v1 text-reference-only (artifacts stay on the branch).
- **changes-requested signal** (M2 Q3): forge-native "request changes" review vs.
  a reserved label vs. treating unapproval-after-approval as changes.
```
