// Proof contract (AM-10). Pluggable strategies selected by WORKFLOW.md proof.type
// (§8). Implementations land in M4; M0 ships the shapes + the shared sentinel.

import type { Exec } from './exec.js';
import type { WorkflowEnvironment } from './workflow-schema.js';

export type ProofStrategyKind = 'playwright' | 'test-output' | 'diff-summary' | 'none';

export interface ProofInput {
  workspaceDir: string;
  workflowProof: { type: ProofStrategyKind; command?: string };
  environment: WorkflowEnvironment; // base_url / start_command / seed_command / health_check
  git: { target: string }; // diff base for diff-summary (AM-16); from RepoSettings.git.target
  exec: Exec;
}

export interface ProofResult {
  ok: boolean; // false is NON-FATAL: handoff still completes, failure noted (M4 policy)
  kind: ProofStrategyKind;
  summary: string; // human-readable, posted in the proof comment
  artifacts?: { name: string; body: string }[]; // attachments the adapter renders
}

export interface ProofStrategy {
  run(input: ProofInput): Promise<ProofResult>;
}

/** Sentinel the proof-comment writer emits and the crash-recovery predicate greps (AM-1 source). */
export const DONE_SENTINEL = '<!-- maestro:proof:done -->';
