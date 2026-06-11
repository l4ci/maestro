// Reconciler contract (spec §0.4, amended AM-1/AM-3/AM-14). Pure function, NO I/O:
// (snapshot + resolved settings) → at most one Intent. M1 implements `reconcile`
// and `deriveState` against these signatures; M0 ships the type surface only.

import type { MergeStrategy } from './forge-adapter.js';
import type { Comment, IssueSnapshot, LifecycleState, RepoRef } from './forge-model.js';
import type { LabelNames } from './labels.js';
import type { AgentRole } from './runner.js';

export interface TriggerGuard {
  requireLabel: string | null;
  allowedActors: string[]; // empty = no actor restriction
}

/** Resolved = config defaults ⊕ repo overrides ⊕ WORKFLOW front matter. */
export interface RepoSettings {
  repo: RepoRef;
  botUser: string; // precedence: WORKFLOW.bot_user wins; config default is fallback (AM-5)
  trigger: TriggerGuard; // §13.1
  git: {
    defaultBranch: string;
    target: string;
    mergeStrategy: MergeStrategy;
    deleteSourceBranch: boolean;
  };
  manageBoard: boolean;
  labels: LabelNames; // namespaced names for this forge (§0.7)
  concurrency: { globalMax: number; maxActive: number }; // resolved caps; M5 accounts (AM-3)
  // CI handoff gate (#118/#120); opt-in per WORKFLOW, default off. `waitTimeoutSeconds`:
  // a `running` head pipeline older than this hands off anyway. `maxFixRounds`: CI-fix
  // bounces since the last human comment before parking as blocked.
  ci: { gate: boolean; waitTimeoutSeconds: number; maxFixRounds: number };
}

/** The single source of truth for "should we act on this issue at all". */
export interface ReconcileInput {
  snapshot: IssueSnapshot;
  settings: RepoSettings;
  /** true if a concurrency slot is available this tick for NEW active work (§14). */
  slotAvailable: boolean;
  /** does a live workspace dir exist for this issue? (cleanup decisions, §0.5) */
  workspaceExists: boolean;
  /** crash-recovery: agent reached `done` but MR still draft / reviewer unassigned (AM-1). */
  workComplete: boolean;
  /** Does the repo's WORKFLOW body declare `## role:` sections? Gates the #29 per-stage
   *  pipeline; false (or absent) keeps the legacy generalist FSM. */
  rolesDeclared?: boolean;
}

export interface AgentFeedback {
  reviewComments: Comment[]; // the human feedback to feed the agent
}

export type Intent =
  | { kind: 'none'; reason: string }
  | { kind: 'mark-queued' } // wants a slot, none free — make the queue visible (#53/#29)
  | { kind: 'start-new'; branch: string; mrTitle: string }
  | { kind: 'run-define' } // backlog stage: refine the request into an AC draft (#29)
  | { kind: 'run-plan'; branch: string; mrTitle: string } // todo stage: plan, then branch+MR (#29)
  | { kind: 'run-review'; rounds: number } // review:internal stage (#29 P3); rounds = prior fails
  | { kind: 'run-agent'; resume: boolean; feedback?: AgentFeedback; role?: AgentRole }
  | { kind: 'handoff' }
  | { kind: 'poll-review' }
  | { kind: 'apply-changes-requested'; feedback: AgentFeedback }
  | { kind: 'apply-ci-fix'; feedback: AgentFeedback } // red CI bounced back to the agent (#118)
  | { kind: 'apply-unblock'; feedback: AgentFeedback; role?: AgentRole }
  | { kind: 'merge'; strategy: MergeStrategy; deleteSource: boolean }
  | { kind: 'cleanup' }
  | { kind: 'blocked-wait' }
  | { kind: 'skip-untrusted'; reason: string };

/** Total, deterministic, side-effect free. Implemented in M1. */
export type Reconcile = (input: ReconcileInput) => Intent;

/** Pure state derivation, exported for CLI/web display without re-running the FSM (AM-14). */
export type DeriveState = (snapshot: IssueSnapshot, settings: RepoSettings) => LifecycleState;
