// Forge error — carries the failing command context and stderr, but NEVER the token
// (§13, §0.8). The ForgeCli layer constructs these; the token only ever lives in
// ExecOptions.env, so it cannot reach a message built from argv/stderr. Forge-neutral:
// the `forge` label is passed in (was duplicated per forge before the M2/M7 merge).

import type { ForgeKind } from '../contracts/index.js';

export class ForgeError extends Error {
  readonly forge: ForgeKind;
  readonly code: number;
  readonly method: string;
  readonly path: string;

  constructor(forge: ForgeKind, method: string, path: string, code: number, stderr: string) {
    super(`${forge} ${method} ${path} failed (exit ${code}): ${stderr.trim()}`);
    this.name = 'ForgeError';
    this.forge = forge;
    this.code = code;
    this.method = method;
    this.path = path;
  }
}
