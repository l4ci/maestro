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
 * (defense in depth — a slug like `..` would still be caught here). Issue dirs stay
 * bare-number (`<iid>`); MR dirs carry the `mr-` prefix (resolveMrWorkspacePath) so the
 * two namespaces can never collide and the cleanup sweep tells them apart by name.
 */
export function resolveWorkspacePath(root: string, repo: RepoRef, iid: number): string {
  if (!Number.isInteger(iid) || iid < 0) {
    throw new WorkspacePathError(`invalid issue iid: ${String(iid)}`);
  }
  return resolveEntityPath(root, repo, String(iid));
}

/**
 * The MR-keyed sibling of {@link resolveWorkspacePath} (spec §7). A command MR's
 * workspace lives at `<root>/<repo-slug>/mr-<iid>`, distinct from issue `<iid>`, so the
 * same number on an issue and a standalone MR never shares a clone.
 */
export function resolveMrWorkspacePath(root: string, repo: RepoRef, mrIid: number): string {
  if (!Number.isInteger(mrIid) || mrIid < 0) {
    throw new WorkspacePathError(`invalid MR iid: ${String(mrIid)}`);
  }
  return resolveEntityPath(root, repo, `mr-${mrIid}`);
}

/** Slugify the repo, reject an empty/absolute slug, then re-validate confinement. The
 *  single chokepoint both entity kinds share so the path-escape guard (§13) is uniform. */
function resolveEntityPath(root: string, repo: RepoRef, segment: string): string {
  const slug = slugifyProject(repo.project);
  if (slug === '') throw new WorkspacePathError(`project slug is empty: '${repo.project}'`);
  if (isAbsolute(slug)) throw new WorkspacePathError(`project slug is absolute: '${slug}'`);
  const candidate = resolve(root, slug, segment);
  return assertInsideRoot(root, candidate);
}
