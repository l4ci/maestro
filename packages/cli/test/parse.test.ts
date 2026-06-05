// Part A — argv parsing is a thin, declarative dispatch. Bad input must surface as a
// typed usage-error (mapped to a nonzero exit at the boundary), NEVER a thrown stacktrace.

import { describe, expect, it } from 'vitest';
import { parse } from '../src/parse.js';

describe('parse (A1 — verb dispatch)', () => {
  it('routes each verb to its kind with captured positionals', () => {
    expect(parse(['add', 'gitlab.com/g/r'])).toEqual({
      kind: 'add',
      url: 'gitlab.com/g/r',
      commit: true,
      public: false,
    });
    expect(parse(['status', '42'])).toEqual({ kind: 'status', issue: 42 });
    expect(parse(['list'])).toEqual({ kind: 'list' });
    expect(parse(['logs', '42'])).toEqual({ kind: 'logs', issue: 42 });
    expect(parse(['run', '42', '--attach'])).toEqual({ kind: 'run', issue: 42, attach: true });
    expect(parse(['daemon'])).toEqual({ kind: 'daemon' });
    expect(parse(['dashboard'])).toEqual({ kind: 'dashboard' });
    expect(parse(['doctor'])).toEqual({ kind: 'doctor' });
  });

  it('unknown or empty verb yields help, never a throw', () => {
    expect(parse(['frobnicate'])).toEqual({ kind: 'help' });
    expect(parse([])).toEqual({ kind: 'help' });
  });
});

describe('parse (A2 — flags)', () => {
  it('add defaults commit:true and honors --no-commit', () => {
    expect(parse(['add', 'gitlab.com/g/r'])).toMatchObject({ commit: true });
    expect(parse(['add', 'gitlab.com/g/r', '--no-commit'])).toMatchObject({ commit: false });
    expect(parse(['add', 'gitlab.com/g/r'])).toMatchObject({ public: false });
    expect(parse(['add', 'gitlab.com/g/r', '--public'])).toMatchObject({ public: true });
  });

  it('run requires --attach (OD-3); bare run is a usage-error', () => {
    expect(parse(['run', '42', '--attach'])).toEqual({ kind: 'run', issue: 42, attach: true });
    expect(parse(['run', '42'])).toMatchObject({ kind: 'usage-error' });
  });
});

describe('parse (A3 — missing positionals)', () => {
  it('add with no url is a usage-error naming the missing arg', () => {
    const r = parse(['add']);
    expect(r.kind).toBe('usage-error');
    if (r.kind === 'usage-error') expect(r.message).toMatch(/url/i);
  });

  it('status/logs/run with no issue is a usage-error', () => {
    expect(parse(['status']).kind).toBe('usage-error');
    expect(parse(['logs']).kind).toBe('usage-error');
    expect(parse(['run', '--attach']).kind).toBe('usage-error');
  });

  it('non-numeric issue is a usage-error, not NaN', () => {
    expect(parse(['status', 'abc']).kind).toBe('usage-error');
  });
});
