// Runner ↔ agent contract (spec §0.9 / §10). The daemon consumes ONLY AgentResult
// from a run; everything else it re-reads from the forge next tick. FROZEN.

import type { Comment, Issue, MergeRequest } from './forge-model.js';

export type AgentStatus = 'done' | 'needs_input' | 'in_progress';

export interface AgentResult {
  status: AgentStatus;
  summary: string;
}

export interface RunnerInput {
  workspaceDir: string;
  promptBody: string; // WORKFLOW.md body + operating protocol (§9)
  context: { issue: Issue; mr?: MergeRequest; recentComments: Comment[] };
  claude: { command: string; maxTurns: number; permissionMode: string };
}

export interface Runner {
  run(input: RunnerInput): Promise<AgentResult>; // cold session; parses final stream-json result
}
