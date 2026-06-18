// @maestro/core PUBLIC surface (CONTEXT.md §Public vs. runtime surface, #95). The only
// entry cli/web (and any external consumer) may import: contracts, the pure reconciler
// edges, view assembly, onboarding, the forge wiring, the config/WORKFLOW parsing
// helpers, log + heartbeat READING, and preflight. Daemon internals live behind
// '@maestro/core/runtime' (runtime.ts) — Node's exports map enforces the seam.
//
// Deliberate judgment calls:
// - WorkspaceManager stays public: cli main.ts constructs it for the `maestro add`
//   bootstrap-PR wiring and the `maestro run` workspace-attach lookup. The workspace
//   path/auth internals it composes do NOT follow it here (runtime surface).
// - ForgeError stays public: adapters throw it across assemble*/addRepo calls, so a
//   public consumer needs the class to catch it. The adapter classes themselves
//   (ForgeCli, GitlabAdapter, GithubAdapter, snapshot plumbing) are no longer exported
//   anywhere — composeForges/makeForgeAdapter are the way in.
// - deriveWatchSet/repoRefFromUrl (daemon/reload.ts) and readHeartbeat
//   (daemon/heartbeat.ts) are pure read helpers that happen to live beside daemon code;
//   the daemon-only classes in those files (WatchedConfig, RepoSettingsCell,
//   HeartbeatWriter) are runtime-surface only.

export * from './contracts/index.js';
export * from './reconciler/reconcile.js';
// The pure after-run edge (#94) — the runner-result half of the lifecycle, beside reconcile.
export * from './reconciler/after-run.js';
// The pure proof-failure edge (#109) — failure streak → retry-or-park, beside after-run.
export * from './reconciler/proof-failure.js';
// The lifecycle-move table (#78) — the pure write-side counterpart of the lifecycle edges.
export * from './reconciler/transitions.js';

// Config + WORKFLOW parsing helpers (the hot-reload stores ConfigStore/WorkflowStore
// are daemon plumbing — runtime surface).
export {
  type ConfigParseResult,
  botUserForHost,
  inferForge,
  parseConfig,
} from './config/load-config.js';
export * from './config/resolve-settings.js';
export {
  type LoadedWorkflow,
  type WorkflowParseResult,
  parseWorkflow,
  splitFrontMatter,
} from './workflow/load-workflow.js';
export * from './workflow/roles.js';

// Forge wiring — the public way to obtain adapters (#90).
export * from './compose/forge-wiring.js';
export { ForgeError } from './forge/errors.js';

export * from './exec/node-exec.js';
export * from './views/assemble.js';
export * from './onboarding/add-repo.js';
export * from './onboarding/work-on-issue.js';
export * from './onboarding/public-guard.js';
export * from './security/scan-for-secrets.js';
export { isAuthorizedActor } from './security/authorized-actor.js';
export * from './logs/file-log-reader.js';
export * from './preflight/check-binaries.js';

// Workspace lifecycle (see judgment call above).
export * from './workspace/workspace-manager.js';

// Watch-set derivation + heartbeat reading (read-side helpers of daemon files).
export { deriveWatchSet, repoRefFromUrl } from './daemon/reload.js';
export { type Heartbeat, readHeartbeat } from './daemon/heartbeat.js';
