// Shared branch / MR-title format (AM-9). One source so the producer (reconciler,
// M1) and consumers (forge adapters, M2/M7) agree. Pure helpers — ship in M0.

import type { Issue } from './forge-model.js';

function slug(title: string, maxLen = 50): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, maxLen).replace(/-+$/g, '') || 'issue';
}

/** e.g. `maestro/issue-42-add-oauth-login` */
export function branchName(issue: Issue): string {
  return `maestro/issue-${issue.iid}-${slug(issue.title)}`;
}

/** Canonical MR title WITHOUT a `Draft:` prefix — the GitLab adapter owns the
 *  prefix as its draft toggle (see plan maestro-02); GitHub uses its native draft
 *  field. e.g. `Add OAuth login (Closes #42)`. */
export function mrTitle(issue: Issue): string {
  return `${issue.title} (Closes #${issue.iid})`;
}
