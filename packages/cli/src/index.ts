// @maestro/cli public surface — a thin shell over @maestro/core. The argv parser, the
// pure formatters, the `add` marshaller, the interactive `run --attach` launcher, and the
// `run(argv)` entry. The daemon entry (dist/daemon.js) is a separate composition root.
export const PACKAGE = '@maestro/cli';

export { parse } from './parse.js';
export type { ParsedCommand } from './parse.js';
export { renderList, renderLogs, renderStatus } from './format.js';
export { runAdd } from './commands/add.js';
export type { RunAddDeps } from './commands/add.js';
export { attach, NoWorkspaceError } from './commands/run.js';
export type { AttachDeps } from './commands/run.js';
export { run } from './main.js';
