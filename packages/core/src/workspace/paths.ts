// Path-escape guard (§13) — THE code-level mitigation for "never escape
// workspaces/". The single chokepoint through which every workspace path is built;
// no path is constructed by string concatenation anywhere else in the module.

import { isAbsolute, resolve, sep } from 'node:path';
import type { RepoRef } from '../contracts/index.js';
import { WorkspacePathError } from './errors.js';

/** Collapse a forge project path into ONE safe path segment: `group/repo` → `group__repo`. */
export function slugifyProject(project: string): string {
  return project.replace(/\//g, '__').replace(/[^a-zA-Z0-9._-]/g, '');
}

/** Throw unless `candidate` resolves to `root` itself or a path strictly inside it. */
export function assertInsideRoot(root: string, candidate: string): string {
  const r = resolve(root);
  const c = resolve(candidate);
  if (c !== r && !c.startsWith(r + sep)) {
    throw new WorkspacePathError(`path escapes workspace root: ${candidate}`);
  }
  return c;
}

/**
 * The only way a per-issue workspace path is built. Slugifies the repo into a single
 * segment, coerces iid to a non-negative integer, then re-validates confinement
 * (defense in depth — a slug like `..` would still be caught here).
 */
export function resolveWorkspacePath(root: string, repo: RepoRef, iid: number): string {
  if (!Number.isInteger(iid) || iid < 0) {
    throw new WorkspacePathError(`invalid issue iid: ${String(iid)}`);
  }
  const slug = slugifyProject(repo.project);
  if (slug === '') throw new WorkspacePathError(`project slug is empty: '${repo.project}'`);
  if (isAbsolute(slug)) throw new WorkspacePathError(`project slug is absolute: '${slug}'`);
  const candidate = resolve(root, slug, String(iid));
  return assertInsideRoot(root, candidate);
}
