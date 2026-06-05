// The daemon's injection seam (spec §14, plan M5 "TickContext"). Every external
// effect the tick orchestrator performs is reached through one of these ports, so
// the unit suite injects fakes (recording adapter, scripted runner, spy handoff,
// in-memory slot accountant) and NO test starts a subprocess, opens a socket, or
// reads a real clock. None of these are frozen contract types — they compose the
// frozen seams (§0.3 adapter, §0.9 runner, M4 handoff) only.

import type {
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
import type { InFlightSet, SlotAccountant } from './slots.js';

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
  prepareBranch(handle: WorkspaceHandleLike, branchName: string): Promise<void>;
  /** Push the agent's local commits up to the MR branch. The agent's env has the forge
   *  token scrubbed (§13.1), so the DAEMON owns the push — without this the agent's work
   *  never reaches the PR. Push-only (no add/commit): the agent already committed. */
  pushBranch(handle: WorkspaceHandleLike, branchName: string): Promise<void>;
  /** Seed the fresh work branch with an empty commit + push so the forge will open a PR —
   *  GitHub rejects a PR whose head has no commits beyond base. Called in start-new before
   *  createDraftMR; the agent's real commits land on top. */
  seedBranch(handle: WorkspaceHandleLike, branchName: string): Promise<void>;
  evict(dir: string): Promise<void>;
  workspaceExists(repo: RepoRef, iid: number): boolean;
  listWorkspaces(repo: RepoRef): { dir: string; iid: number }[];
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

/**
 * Everything one repo's tick composes. Assembled per repo per tick by the daemon;
 * `slots` and `log` are the process-wide singletons (shared across repos), the rest
 * are the per-repo resolved values (M1 `resolveRepoSettings` + the WORKFLOW bundle).
 */
export interface TickContext {
  adapter: ForgeAdapter; // §0.3 — picked by repo.forge
  workspace: Workspace; // M3
  runner: Runner; // §0.9
  handoff: HandoffFn; // M4 — bare sequence (crash-recovery resume)
  proofAndHandoff: ProofAndHandoffFn; // M4 — generate proof + sequence (agent `done`)
  exec: Exec; // §0.8 — proof generation runs commands through this
  settings: RepoSettings; // resolved; carries git / labels / trigger / concurrency
  workflow: WorkflowFrontMatter; // proof / environment / claude live here, not RepoSettings
  promptBody: string; // WORKFLOW body → RunnerInput.promptBody
  slots: SlotAccountant; // process-wide concurrency gate (§14)
  inFlight: InFlightSet; // process-wide per-issue dedup (§14, #18)
  log: Logger;
}

/** Stable key for a repo in the slot accountant / scheduler maps. */
export function repoKey(repo: RepoRef): string {
  return `${repo.forge}:${repo.host}:${repo.project}`;
}
