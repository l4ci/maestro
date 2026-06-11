import { describe, expect, it } from 'vitest';
import { normalizeCiStatus } from '../src/forge/github/normalize.js';

describe('normalizeCiStatus — GitHub check-runs + combined status → CiStatus (#120)', () => {
  it('a failed check-run wins → failed, carrying at + webUrl from that run', () => {
    expect(
      normalizeCiStatus(
        [
          {
            status: 'completed',
            conclusion: 'success',
            completed_at: '2026-06-11T09:00:00Z',
            html_url: 'https://github.com/o/r/runs/1',
          },
          {
            status: 'completed',
            conclusion: 'failure',
            completed_at: '2026-06-11T10:00:00Z',
            html_url: 'https://github.com/o/r/runs/2',
          },
        ],
        { state: 'failure', total_count: 1 },
      ),
    ).toEqual({
      conclusion: 'failed',
      at: '2026-06-11T10:00:00Z',
      webUrl: 'https://github.com/o/r/runs/2',
    });
  });

  it('maps timed_out and cancelled check-runs to failed', () => {
    for (const conclusion of ['timed_out', 'cancelled']) {
      expect(normalizeCiStatus([{ status: 'completed', conclusion }], null).conclusion).toBe(
        'failed',
      );
    }
  });

  it('an in-flight check-run (queued/in_progress) → running', () => {
    for (const status of ['queued', 'in_progress']) {
      expect(normalizeCiStatus([{ status }], null).conclusion).toBe('running');
    }
  });

  it('a failure/error combined status (no check-runs) → failed', () => {
    expect(normalizeCiStatus([], { state: 'failure', total_count: 2 }).conclusion).toBe('failed');
    expect(normalizeCiStatus([], { state: 'error', total_count: 1 }).conclusion).toBe('failed');
  });

  it('a pending combined status with real statuses → running', () => {
    expect(normalizeCiStatus([], { state: 'pending', total_count: 1 }).conclusion).toBe('running');
  });

  it('all-green check-runs → success', () => {
    for (const conclusion of ['success', 'neutral', 'skipped']) {
      expect(
        normalizeCiStatus([{ status: 'completed', conclusion }], {
          state: 'success',
          total_count: 1,
        }).conclusion,
      ).toBe('success');
    }
  });

  it('action_required folds into success, not failed (spec §12 manual twin)', () => {
    expect(
      normalizeCiStatus([{ status: 'completed', conclusion: 'action_required' }], null).conclusion,
    ).toBe('success');
  });

  it('no check-runs and no statuses → none (repos without CI)', () => {
    expect(normalizeCiStatus([], null).conclusion).toBe('none');
    expect(normalizeCiStatus([], { state: 'pending', total_count: 0 }).conclusion).toBe('none');
  });
});
