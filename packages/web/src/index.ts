// @maestro/web — thin read-only dashboard + add-repo form over @maestro/core (M6 Part F).
// The HTTP layer is a dumb adapter: every byte of real logic (read-model assembly, the
// shared addRepo) lives in core; this package only marshals routes → core calls.
export { createServer } from './server.js';
export type { ServerDeps } from './server.js';
export { buildServerDeps } from './deps.js';
export type { BuildServerDepsArgs } from './deps.js';
export { startWebServer } from './main.js';
export { DASHBOARD_HTML } from './page.js';
