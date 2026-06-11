// RepoSettings resolution (spec §5; contracts §0.4). Merges config defaults ⊕
// per-repo overrides ⊕ WORKFLOW front matter into the frozen RepoSettings shape.
//
// Precedence:
//  - bot_user: WORKFLOW wins, config default is fallback (AM-5).
//  - concurrency.maxActive: operator config override > WORKFLOW > implicit default.
//    Rationale: concurrency is a host-capacity/safety knob (§14); WORKFLOW lives in
//    a semi-trusted watched repo (§13.1), so the operator's central config must be
//    able to cap a repo's self-declared value. (Deviates from the M1 plan's stated
//    "WORKFLOW > repo override"; corrected for the safety direction.)

import type {
  MaestroConfig,
  RepoRef,
  RepoSettings,
  WorkflowFrontMatter,
} from '../contracts/index.js';
import { labelNames } from '../contracts/labels.js';

type RepoOverride = NonNullable<MaestroConfig['repos'][number]['overrides']>;

export interface ResolveArgs {
  repo: RepoRef;
  workflow: WorkflowFrontMatter;
  defaults: MaestroConfig['defaults'];
  override?: RepoOverride;
}

export function resolveRepoSettings({
  repo,
  workflow,
  defaults,
  override,
}: ResolveArgs): RepoSettings {
  return {
    repo,
    botUser: workflow.bot_user || defaults.bot_user,
    trigger: {
      requireLabel: workflow.trigger.require_label,
      allowedActors: workflow.trigger.allowed_actors,
    },
    git: {
      defaultBranch: workflow.git.default_branch,
      target: workflow.git.target,
      mergeStrategy: workflow.git.merge_strategy,
      deleteSourceBranch: workflow.git.delete_source_branch,
    },
    manageBoard: workflow.manage_board,
    labels: labelNames(repo.forge),
    concurrency: {
      globalMax: defaults.concurrency.global_max,
      maxActive: override?.concurrency?.max_active ?? workflow.concurrency.max_active,
    },
    ci: {
      gate: workflow.ci.gate,
      waitTimeoutSeconds: workflow.ci.wait_timeout_seconds,
      maxFixRounds: workflow.ci.max_fix_rounds,
    },
  };
}
