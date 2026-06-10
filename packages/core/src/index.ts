// @maestro/core public surface. M0 = contracts; M1 adds the pure reconciler +
// the config/WORKFLOW loaders + settings resolution. M2+ add adapters, runner,
// proof, workspace manager behind this entry.
export * from './contracts/index.js';
export * from './reconciler/reconcile.js';
export * from './reconciler/after-run.js';
export * from './config/load-config.js';
export * from './config/resolve-settings.js';
export * from './workflow/load-workflow.js';
export * from './compose/forge-wiring.js';
export * from './workflow/roles.js';
export * from './workflow/workflow-source.js';
export * from './exec/node-exec.js';
export { ForgeCli, buildPath } from './forge/cli.js';
export type { ForgeCliConfig, HttpMethod, ApiOptions } from './forge/cli.js';
export { ForgeError } from './forge/errors.js';
export {
  type ForgePrimitives,
  assembleSnapshot,
  findMaestroMr,
  computeChangesRequested,
} from './forge/snapshot.js';
// gitlab-adapter / github-adapter re-export their own encodeProject / repoSegments
// and the *ClientConfig types alongside the adapter classes.
export * from './forge/gitlab/gitlab-adapter.js';
export * from './forge/github/github-adapter.js';
export * from './workspace/workspace-manager.js';
export { resolveWorkspacePath, assertInsideRoot, slugifyProject } from './workspace/paths.js';
export { WorkspacePathError, MissingTokenError } from './workspace/errors.js';
export { gitCloneAuth, type GitAuth } from './workspace/git-auth.js';
export * from './runner/claude-runner.js';
export * from './proof/strategies.js';
export * from './handoff/handoff.js';
export * from './daemon/index.js';
export * from './onboarding/add-repo.js';
export * from './onboarding/public-guard.js';
export * from './bootstrap/infer-workflow-seed.js';
export * from './bootstrap/onboard.js';
export * from './bootstrap/bootstrap-pr.js';
export * from './bootstrap/bootstrap-workflow.js';
export * from './security/scan-for-secrets.js';
export { isAuthorizedActor } from './security/authorized-actor.js';
export * from './views/assemble.js';
export * from './logs/file-log-reader.js';
export * from './preflight/check-binaries.js';
