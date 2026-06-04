// @maestro/core public surface. M0 = contracts; M1 adds the pure reconciler +
// the config/WORKFLOW loaders + settings resolution. M2+ add adapters, runner,
// proof, workspace manager behind this entry.
export * from './contracts/index.js';
export * from './reconciler/reconcile.js';
export * from './config/load-config.js';
export * from './config/resolve-settings.js';
export * from './workflow/load-workflow.js';
export * from './exec/node-exec.js';
export * from './forge/gitlab/gitlab-adapter.js';
export { GitlabClient, encodeProject } from './forge/gitlab/client.js';
export type { GitlabClientConfig } from './forge/gitlab/client.js';
export { ForgeError } from './forge/gitlab/errors.js';
export * from './workspace/workspace-manager.js';
export { resolveWorkspacePath, assertInsideRoot, slugifyProject } from './workspace/paths.js';
export { WorkspacePathError, MissingTokenError } from './workspace/errors.js';
export * from './runner/claude-runner.js';
export * from './proof/strategies.js';
export * from './handoff/handoff.js';
export * from './daemon/index.js';
export * from './onboarding/add-repo.js';
export * from './views/assemble.js';
export * from './logs/file-log-reader.js';
