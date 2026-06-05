// `maestro dashboard` — launch the web dashboard without the deep
// `node packages/web/dist/main.js` invocation (the same fold-in as `maestro daemon`, #28).
// The CLI must NOT import @maestro/web (both are thin sibling shells over core); it spawns
// the web package's built entry as a child node process through the TTY-inherited
// Exec.attach seam (AM-8), so logs land in the terminal and Ctrl-C stops the server.
// Env passes through untouched: MAESTRO_WEB_HOST/PORT and MAESTRO_DASHBOARD_TOKEN keep
// working exactly as documented for the direct invocation.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Exec } from '@maestro/core';

export interface DashboardDeps {
  exec: Exec;
  /** The web package's built entry; defaults to the monorepo sibling build. */
  webMain?: string;
  /** Existence probe seam (tests); defaults to fs.existsSync. */
  exists?: (path: string) => boolean;
}

export class WebBuildMissingError extends Error {
  constructor(path: string) {
    super(`Dashboard build not found at ${path} — run 'pnpm build' first.`);
    this.name = 'WebBuildMissingError';
  }
}

/** Resolve the sibling web build relative to THIS module (dist/commands/dashboard.js →
 *  packages/web/dist/main.js), so the command works from any cwd. */
export function defaultWebMain(): string {
  return fileURLToPath(new URL('../../../web/dist/main.js', import.meta.url));
}

/** Verify the build exists, then hand the terminal to the dashboard server. Returns the
 *  child exit code (the server runs until interrupted). */
export async function dashboard(deps: DashboardDeps): Promise<number> {
  const webMain = deps.webMain ?? defaultWebMain();
  const exists = deps.exists ?? existsSync;
  if (!exists(webMain)) throw new WebBuildMissingError(webMain);
  return deps.exec.attach(process.execPath, [webMain]);
}
