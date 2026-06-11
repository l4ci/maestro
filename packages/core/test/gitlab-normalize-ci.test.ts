import { describe, expect, it } from 'vitest';
import { normalizeCiStatus } from '../src/forge/gitlab/normalize.js';

describe('normalizeCiStatus — GitLab head_pipeline → CiStatus (#118)', () => {
  it('maps a failed pipeline to conclusion failed, carrying at + webUrl', () => {
    expect(
      normalizeCiStatus({
        status: 'failed',
        web_url: 'https://gitlab.com/g/p/-/pipelines/9',
        updated_at: '2026-06-11T10:00:00Z',
        created_at: '2026-06-11T09:00:00Z',
      }),
    ).toEqual({
      conclusion: 'failed',
      at: '2026-06-11T10:00:00Z',
      webUrl: 'https://gitlab.com/g/p/-/pipelines/9',
    });
  });

  it('maps canceled to failed', () => {
    expect(normalizeCiStatus({ status: 'canceled' }).conclusion).toBe('failed');
  });

  it('maps running/pending/created to running', () => {
    for (const status of ['running', 'pending', 'created', 'preparing', 'scheduled']) {
      expect(normalizeCiStatus({ status }).conclusion).toBe('running');
    }
  });

  it('maps success/skipped/manual to success', () => {
    for (const status of ['success', 'skipped', 'manual']) {
      expect(normalizeCiStatus({ status }).conclusion).toBe('success');
    }
  });

  it('maps a missing pipeline to none', () => {
    expect(normalizeCiStatus(undefined).conclusion).toBe('none');
    expect(normalizeCiStatus(null).conclusion).toBe('none');
    expect(normalizeCiStatus({}).conclusion).toBe('none');
  });

  it('falls back to created_at when updated_at is absent', () => {
    expect(normalizeCiStatus({ status: 'failed', created_at: '2026-06-11T09:00:00Z' }).at).toBe(
      '2026-06-11T09:00:00Z',
    );
  });
});
