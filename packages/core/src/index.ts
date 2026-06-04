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
