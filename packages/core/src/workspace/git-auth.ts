// Shared git clone/fetch auth (§0.8, OD-1). The credential helper emits oauth2 + the
// token read from $MAESTRO_GIT_TOKEN at git runtime, so the token value never appears
// in argv or the remote URL — only the literal var reference. Both the workspace
// manager (per-issue clones) and the workflow source (WORKFLOW.md fetch) inject it.

import type { RepoRef } from '../contracts/index.js';
import { MissingTokenError } from './errors.js';

const CRED_HELPER = '!f() { echo username=oauth2; echo "password=$MAESTRO_GIT_TOKEN"; }; f';

export interface GitAuth {
  /** `-c` args that reset any inherited helper, then install ours. Prepend to a git argv. */
  args: string[];
  /** Env carrying the resolved token; rides to the child only via ExecOptions.env. */
  env: Record<string, string>;
}

/** Resolve the per-repo forge token (by env-var NAME) into ready-to-use git auth.
 *  Throws MissingTokenError (naming the var, never the value) when it is unset. */
export function gitCloneAuth(
  repo: RepoRef,
  tokenEnv: string | ((repo: RepoRef) => string),
  getEnv: (key: string) => string | undefined,
): GitAuth {
  const name = typeof tokenEnv === 'function' ? tokenEnv(repo) : tokenEnv;
  const token = getEnv(name);
  if (!token) throw new MissingTokenError(name);
  return {
    args: ['-c', 'credential.helper=', '-c', `credential.helper=${CRED_HELPER}`],
    env: { MAESTRO_GIT_TOKEN: token },
  };
}
