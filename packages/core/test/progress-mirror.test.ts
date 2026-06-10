// #86 — the pure progress-mirror region transforms. The daemon write path that
// applies them lives in daemon-tick-lifecycle.test.ts (A12); these tests pin the
// transform itself: render shape, the 50-newest cap, marker-bounded upsert with
// everything outside the markers byte-preserved, and idempotency.

import { describe, expect, it } from 'vitest';
import {
  PROGRESS_COMMIT_CAP,
  PROGRESS_END,
  PROGRESS_START,
  renderProgressRegion,
  upsertProgressRegion,
} from '../src/daemon/progress-mirror.js';

describe('renderProgressRegion', () => {
  it('renders chronological subjects as bullets between the markers', () => {
    expect(renderProgressRegion(['first commit', 'second commit'])).toBe(
      [
        PROGRESS_START,
        '### Commits so far',
        '- first commit',
        '- second commit',
        PROGRESS_END,
      ].join('\n'),
    );
  });

  it('empty subjects render the em-dash placeholder, not an empty list', () => {
    expect(renderProgressRegion([])).toBe(
      [PROGRESS_START, '### Commits so far', '—', PROGRESS_END].join('\n'),
    );
  });

  it('exactly 50 subjects → all shown, no truncation line', () => {
    const subjects = Array.from({ length: PROGRESS_COMMIT_CAP }, (_, i) => `c${i + 1}`);
    const region = renderProgressRegion(subjects);
    expect(region).not.toContain('earlier commit');
    expect(region).toContain('- c1');
    expect(region).toContain(`- c${PROGRESS_COMMIT_CAP}`);
  });

  it('over the cap → the NEWEST 50 survive plus a counted "earlier commits" line', () => {
    const subjects = Array.from({ length: 53 }, (_, i) => `c${i + 1}`); // c1 oldest … c53 newest
    const region = renderProgressRegion(subjects);
    expect(region).toContain('_…and 3 earlier commits_');
    expect(region).not.toContain('- c3\n'); // c1–c3 dropped (oldest)
    expect(region).toContain('- c4'); // newest 50 start here
    expect(region).toContain('- c53');
    // the count line sits ABOVE the bullets (it stands in for the dropped older ones)
    expect(region.indexOf('earlier commits')).toBeLessThan(region.indexOf('- c4'));
  });

  it('one dropped commit → singular wording', () => {
    const subjects = Array.from({ length: PROGRESS_COMMIT_CAP + 1 }, (_, i) => `c${i + 1}`);
    expect(renderProgressRegion(subjects)).toContain('_…and 1 earlier commit_');
  });
});

describe('upsertProgressRegion', () => {
  const subjects = ['Add the adapter seam', 'Wire the tick'];
  const region = renderProgressRegion(subjects);

  it('appends the region blank-line separated when no markers exist', () => {
    const description = '## Plan\n\n- [x] step one\n\nCloses #42';
    expect(upsertProgressRegion(description, subjects)).toBe(`${description}\n\n${region}`);
  });

  it('an empty description becomes just the region', () => {
    expect(upsertProgressRegion('', subjects)).toBe(region);
    expect(upsertProgressRegion('  \n', subjects)).toBe(region);
  });

  it('replaces a stale region in place, preserving every byte outside the markers', () => {
    const prefix = '## Plan\n\n- [ ] agent todo — DO NOT TOUCH\n\n';
    const suffix = '\n\ntrailing notes\n\nCloses #42';
    const stale = `${PROGRESS_START}\n### Commits so far\n- old subject\n${PROGRESS_END}`;
    const out = upsertProgressRegion(prefix + stale + suffix, subjects);
    expect(out).toBe(prefix + region + suffix);
  });

  it('is idempotent: applying twice equals applying once', () => {
    const description = 'agent todo above\n\nCloses #42';
    const once = upsertProgressRegion(description, subjects);
    expect(upsertProgressRegion(once, subjects)).toBe(once);
  });

  it('re-upserting with NEW subjects rewrites only the region — no duplicates, no drift', () => {
    const description = 'agent todo above';
    const once = upsertProgressRegion(description, ['old']);
    const twice = upsertProgressRegion(once, subjects);
    expect(twice).toBe(`${description}\n\n${region}`);
    expect(twice.match(/maestro:progress:start/g)).toHaveLength(1);
  });

  it('a corrupt region (start marker without end) appends rather than guessing a boundary', () => {
    const description = `agent text\n${PROGRESS_START}\nhand-mangled, no end marker`;
    const out = upsertProgressRegion(description, subjects);
    expect(out.startsWith(description)).toBe(true); // nothing swallowed
    expect(out.endsWith(region)).toBe(true);
  });
});
