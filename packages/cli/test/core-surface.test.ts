// Surface-split seam (#95): '@maestro/core' is the public surface, '@maestro/core/runtime'
// the daemon-internal one. tsc already enforces the seam at compile time (a runtime-only
// name is simply absent from public.d.ts); this test pins it at module-resolution level
// too, against the BUILT dist the exports map actually serves — so a re-export sneaking
// back into public.ts fails CI, not just review.

import * as pub from '@maestro/core';
import * as runtime from '@maestro/core/runtime';
import { describe, expect, it } from 'vitest';

// Daemon internals: constructing/driving the poll loop. None may leak into public.
const RUNTIME_ONLY = [
  'Claims',
  'ClaudeRunner',
  'ConfigStore',
  'HeartbeatWriter',
  'RateLimitGate',
  'RepoSettingsCell',
  'Scheduler',
  'WatchedConfig',
  'WorkflowCells',
  'WorkflowSource',
  'WorkflowStore',
  'buildBootstrapWorkflow',
  'deriveCell',
  'generateProofs',
  'handoff',
  'proofAndComment',
  'proofAndHandoff',
  'selectAdapter',
  'tickDue',
  'tickRepo',
] as const;

// What cli/web compositions actually import from the public entry (plus the seam's
// flagship names). A superset lives in core/src/public.ts; this pins the floor.
const PUBLIC_REQUIRED = [
  'FileLogReader',
  'NodeExec',
  'WorkspaceManager',
  'addRepo',
  'allBinaries',
  'assembleDashboard',
  'assembleIssue',
  'botUserForHost',
  'checkBinaries',
  'composeForges',
  'deriveWatchSet',
  'isAuthorizedActor',
  'loadConfig',
  'makeForgeAdapter',
  'readHeartbeat',
  'reconcile',
  'repoRefFromUrl',
  'requiredBinaries',
  'requirePublicOptIn',
  'scanForSecrets',
] as const;

describe('@maestro/core surface split (#95)', () => {
  it('the public surface exposes no daemon-internal names', () => {
    const leaked = RUNTIME_ONLY.filter((name) => name in pub);
    expect(leaked).toEqual([]);
  });

  it('the retired forge adapter classes are not on the public surface (#90)', () => {
    for (const name of ['ForgeCli', 'GitlabAdapter', 'GithubAdapter', 'assembleSnapshot']) {
      expect(name in pub, `${name} must not be public`).toBe(false);
    }
  });

  it('the runtime surface carries the daemon internals', () => {
    const missing = RUNTIME_ONLY.filter((name) => !(name in runtime));
    expect(missing).toEqual([]);
  });

  it('the public surface carries everything the cli/web entries import', () => {
    const missing = PUBLIC_REQUIRED.filter((name) => !(name in pub));
    expect(missing).toEqual([]);
  });
});
