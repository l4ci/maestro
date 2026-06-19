// The daemon's injection seam (spec §14, plan M5 "TickContext"). Every external
// effect the tick orchestrator performs is reached through one of these ports, so
// the unit suite injects fakes (recording adapter, scripted runner, spy handoff,
// in-memory slot accountant) and NO test starts a subprocess, opens a socket, or
// reads a real clock. None of these are frozen contract types — they compose the
// frozen seams (§0.3 adapter, §0.9 runner, M4 handoff) only.

import type {
  AgentSelection,
  Exec,
  ForgeAdapter,
  HandoffFn,
  ProofResult,
  RepoRef,
  RepoSettings,
  Runner,
  WorkflowFrontMatter,
} from '../contracts/index.js';
import type { ProofAndHandoffInput } from '../handoff/handoff.js';
import type { Claims } from './claims.js';
import type { ProofStreaks } from './proof-streaks.js';
import type { RateLimitGate } from './rate-limit-gate.js';

/** A live per-issue workspace handle (structurally satisfied by M3 WorkspaceHandle). */
export interface WorkspaceHandleLike {
  dir: string;
  repo: RepoRef;
  iid: number;
  /** Set when the reuse reset parked committed-but-unpushed commits on a rescue ref (#55). */
  rescuedRef?: string;
}

/**
 * The subset of M3 `WorkspaceManager` the daemon drives. Read methods are sync
 * (fs-backed in M3); mutating ones are async. The real manager satisfies this
 * structurally — tests inject a fake.
 */
export interface Workspace {
  ensureWorkspace(repo: RepoRef, iid: number, fromRef: string): Promise<WorkspaceHandleLike>;
  /** Materialize a command-MR workspace keyed `mr-<iid>` on its source branch (spec §7).
   *  Distinct namespace from issues so the same number never shares a clone. */
  ensureMrWorkspace(repo: RepoRef, mrIid: number, fromRef: string): Promise<WorkspaceHandleLike>;
  prepareBranch(handle: WorkspaceHandleLike, branchName: string): Promise<void>;
  /** Push the agent's local commits up to the MR branch. The agent's env has the forge
   *  token scrubbed (§13.1), so the DAEMON owns the push — without this the agent's work
   *  never reaches the PR. Push-only (no add/commit): the agent already committed. */
  pushBranch(handle: WorkspaceHandleLike, branchName: string): Promise<void>;
  /** Seed the fresh work branch with an empty commit + push so the forge will open a PR —
   *  GitHub rejects a PR whose head has no commits beyond base. Called in start-new before
   *  createDraftMR; the agent's real commits land on top. */
  seedBranch(handle: WorkspaceHandleLike, branchName: string): Promise<void>;
  /** Returns false when the workspace was KEPT (committed-but-unpushed work, #56). */
  evict(dir: string): Promise<boolean>;
  workspaceExists(repo: RepoRef, iid: number): boolean;
  listWorkspaces(repo: RepoRef): { dir: string; iid: number }[];
  /** Command-MR workspace dirs (`mr-<iid>`) — the MR branch of the cleanup sweep (spec §7). */
  listMrWorkspaces(repo: RepoRef): { dir: string; iid: number }[];
  /** Commits on HEAD not yet on any origin ref — the command-MR pass pushes iff > 0 and
   *  words its reply with the count (spec §5). */
  countUnpushedCommits(handle: WorkspaceHandleLike): Promise<number>;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** M4 proof-then-handoff unit (the agent-`done` path), injected so tests can spy on
 *  invocation without real proof/forge I/O. The bare `HandoffFn` (crash-recovery
 *  resume) is the frozen contract type, imported above. */
export type ProofAndHandoffFn = (input: ProofAndHandoffInput) => Promise<ProofResult[]>;

/** Proof + comment WITHOUT the handoff (#29 P3) — the review gate owns the handoff. */
export type ProofOnlyFn = (input: ProofAndHandoffInput) => Promise<ProofResult[]>;

/**
 * Everything one repo's tick composes. Assembled per repo per tick by the daemon;
 * `claims` and `log` are the process-wide singletons (shared across repos), the rest
 * are the per-repo resolved values (M1 `resolveRepoSettings` + the WORKFLOW bundle).
 */
export interface TickContext {
  adapter: ForgeAdapter; // §0.3 — picked by repo.forge
  workspace: Workspace; // M3
  runner: Runner; // §0.9
  handoff: HandoffFn; // M4 — bare sequence (crash-recovery resume)
  proofAndHandoff: ProofAndHandoffFn; // M4 — generate proof + sequence (agent `done`)
  proofOnly: ProofOnlyFn; // #29 P3 — proof comment only; review gate runs the handoff
  exec: Exec; // §0.8 — proof generation runs commands through this
  settings: RepoSettings; // resolved; carries git / labels / trigger / concurrency
  workflow: WorkflowFrontMatter; // proof / environment / claude live here, not RepoSettings
  agent: AgentSelection; // daemon-global agent selection (#codex); resolves RunnerInput command
  promptBody: string; // WORKFLOW body → RunnerInput.promptBody
  claims: Claims; // process-wide work admission: uniqueness + slot capacity (§14, #18, #91)
  rateGate: RateLimitGate; // process-wide Claude usage-limit backoff (#47)
  proofStreaks: ProofStreaks; // process-wide per-issue proof-failure streaks (#109)
  log: Logger;
}

/** Stable key for a repo in the slot accountant / scheduler maps. */
export function repoKey(repo: RepoRef): string {
  return `${repo.forge}:${repo.host}:${repo.project}`;
}
