// Part D — `maestro run <issue> --attach`. Launches an INTERACTIVE claude in the issue's
// live workspace through the TTY-inherited Exec.attach seam (AM-8) so a human drives it at
// the keyboard. This is explicitly NOT the daemon/headless path (§8): no `-p`, no
// `--output-format stream-json`, and ClaudeRunner is never constructed. A missing
// workspace is a clear typed error (the daemon must start the issue first), never a
// silent claude launch in the wrong directory.

import type { Exec } from '@maestro/core';

export interface AttachDeps {
  exec: Exec;
  /** Resolve the issue's live workspace dir, or undefined if none exists yet. */
  resolveWorkspace: (iid: number) => string | undefined;
}

export class NoWorkspaceError extends Error {
  constructor(iid: number) {
    super(
      `No live workspace for issue #${iid}. The daemon must start the issue before you can attach; wait for it to enter in-progress, then retry.`,
    );
    this.name = 'NoWorkspaceError';
  }
}

/** Resolve the workspace, then hand the terminal to an interactive claude. Returns the
 *  child exit code. Interactive flags ONLY — keep the argv minimal (no headless flags). */
export async function attach(issueIid: number, deps: AttachDeps): Promise<number> {
  const dir = deps.resolveWorkspace(issueIid);
  if (dir === undefined) throw new NoWorkspaceError(issueIid);
  return deps.exec.attach('claude', [], { cwd: dir });
}
