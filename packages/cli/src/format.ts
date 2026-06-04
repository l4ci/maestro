// Part C — PURE string formatters over core view objects. They re-derive NOTHING: the
// view already carries the core-derived LifecycleState (the single source of truth shared
// with the reconciler), so the CLI text and the daemon never drift. Edge cases (zero
// repos, no MR, no logs) render a friendly line, never a crash.

import type { DashboardView, IssueView, LifecycleState, LogLine } from '@maestro/core';

// Fixed order so list rows read consistently; ONLY the §0.2 LifecycleState names.
const STATES: LifecycleState[] = ['new', 'in-progress', 'in-review', 'blocked', 'done'];

/** `list`: one line per watched repo with per-state tallies. */
export function renderList(view: DashboardView): string {
  if (view.repos.length === 0) return 'nothing watched';
  return view.repos
    .map((r) => {
      const tallies = STATES.map((s) => `${s}:${r.counts[s]}`).join('  ');
      return `${r.repo.project}  ${tallies}`;
    })
    .join('\n');
}

/** `status <issue>`: one issue's derived lifecycle, MR url, flags, and last log line. */
export function renderStatus(view: IssueView): string {
  const lines = [`#${view.iid} ${view.title}`, `  state: ${view.state}`];
  if (view.mrUrl) {
    const flags = [view.isDraft ? 'draft' : 'ready', view.approved ? 'approved' : 'not-approved'];
    lines.push(`  mr: ${view.mrUrl} (${flags.join(', ')})`);
  }
  if (view.lastLog) lines.push(`  last: ${view.lastLog}`);
  return lines.join('\n');
}

/** `logs <issue>`: cache lines as recorded (oldest-first). Empty is not an error. */
export function renderLogs(lines: LogLine[]): string {
  if (lines.length === 0) return 'no logs yet';
  return lines.map((l) => `${l.ts} [${l.level}] ${l.msg}`).join('\n');
}
