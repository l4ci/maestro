// Daemon loop body (spec §14). One pass: tick every repo that is DUE (per the adaptive
// scheduler), then reschedule each ticked repo — fast if it did active work this tick,
// slow if it was idle. Time is injected (Clock), so the cadence is deterministic in
// tests; the CLI entrypoint drives this on a real interval. No real time here.

import type { Clock } from './clock.js';
import { repoKey } from './ports.js';
import type { Scheduler } from './scheduler.js';
import { type RepoUnit, tick } from './tick.js';

/** Tick all currently-due repos, then reschedule them by their active/idle outcome. */
export async function tickDue(
  units: RepoUnit[],
  scheduler: Scheduler,
  clock: Clock,
): Promise<void> {
  const now = clock.now();
  const due = units.filter((u) => scheduler.due(repoKey(u.repo), now));
  if (due.length === 0) return;

  const results = await tick(due);

  const after = clock.now();
  for (const u of due) {
    const key = repoKey(u.repo);
    scheduler.schedule(key, results.get(key)?.active ?? false, after);
  }
}
