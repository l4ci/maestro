// @maestro/core/runtime — the RUNTIME surface (CONTEXT.md §Public vs. runtime surface,
// #95): daemon internals, imported ONLY by the daemon composition root (cli/daemon.ts).
// Everything here is the machinery behind the poll loop — tick, scheduler, claims,
// rate gate, heartbeat WRITER, hot-reload cells, workflow source, runner, proof,
// handoff, bootstrap, and the workspace internals WorkspaceManager composes. Public
// consumers (cli main/commands, web) physically cannot reach these via '@maestro/core'.

export * from './daemon/index.js';
export * from './workflow/workflow-source.js';
export * from './runner/claude-runner.js';
export * from './proof/strategies.js';
export * from './handoff/handoff.js';
export * from './bootstrap/infer-workflow-seed.js';
export * from './bootstrap/onboard.js';
export * from './bootstrap/bootstrap-pr.js';
export * from './bootstrap/bootstrap-workflow.js';

// Hot-reload stores (validate-then-swap) — daemon plumbing, though they live in
// config/ and workflow/ next to the public parsing helpers.
export { ConfigStore } from './config/load-config.js';
export { WorkflowStore } from './workflow/load-workflow.js';

// Workspace internals: path scheme, errors, git auth. The WorkspaceManager class
// itself is public (cli main.ts constructs it); its plumbing is not.
export { assertInsideRoot, resolveWorkspacePath, slugifyProject } from './workspace/paths.js';
export { MissingTokenError, WorkspacePathError } from './workspace/errors.js';
export { type GitAuth, gitCloneAuth } from './workspace/git-auth.js';
