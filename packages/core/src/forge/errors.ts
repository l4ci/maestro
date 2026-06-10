// Forge error — carries the failing command context and stderr, but NEVER the token
// (§13, §0.8). The ForgeCli layer constructs these; the token only ever lives in
// ExecOptions.env, so it cannot reach a message built from argv/stderr. Forge-neutral:
// the `forge` label is passed in (was duplicated per forge before the M2/M7 merge).

import type { ForgeKind } from '../contracts/index.js';

/** A normalized snapshot piece violated its §0.2 schema at assembly (issue #108): the
 *  adapter's ForgePrimitives promised a normalized model object and delivered something
 *  else. Names the forge and the failing field path so the bug surfaces at the seam
 *  that promised it away, not as a far-off crash in the reconciler or views. */
export class SnapshotValidationError extends Error {
  readonly forge: ForgeKind;
  readonly path: string;

  constructor(forge: ForgeKind, path: string, detail: string, issueCount: number) {
    const more = issueCount > 1 ? ` (+${issueCount - 1} more)` : '';
    super(`${forge} snapshot failed §0.2 validation at ${path}: ${detail}${more}`);
    this.name = 'SnapshotValidationError';
    this.forge = forge;
    this.path = path;
  }
}

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
