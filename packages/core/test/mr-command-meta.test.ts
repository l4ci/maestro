// Pure meta-command router (#88): a stripped `/maestro` instruction is a daemon action only when
// its LEADING verb is in the fixed vocabulary. Mixed commands ("review then merge") stay agent.

import { describe, expect, it } from 'vitest';
import { metaCommandOf } from '../src/mr-command/meta.js';

describe('metaCommandOf — leading-verb daemon-action router', () => {
  it('classifies a pure merge / close, with or without trailing words', () => {
    expect(metaCommandOf('merge')).toBe('merge');
    expect(metaCommandOf('merge please')).toBe('merge');
    expect(metaCommandOf('close')).toBe('close');
    expect(metaCommandOf('close it now')).toBe('close');
  });

  it('is case-insensitive on the verb', () => {
    expect(metaCommandOf('Merge')).toBe('merge');
    expect(metaCommandOf('CLOSE this')).toBe('close');
  });

  it('tolerates leading whitespace', () => {
    expect(metaCommandOf('  merge')).toBe('merge');
  });

  it('routes a mixed command to the agent (null) — only the leading verb counts (Q2a)', () => {
    expect(metaCommandOf('review then merge')).toBeNull();
    expect(metaCommandOf('please merge')).toBeNull();
  });

  it('does not match a verb that is only a prefix of a longer word', () => {
    expect(metaCommandOf('merged the upstream')).toBeNull();
    expect(metaCommandOf('closes #42')).toBeNull();
  });

  it('returns null for an arbitrary agent instruction or empty text', () => {
    expect(metaCommandOf('make the tests pass')).toBeNull();
    expect(metaCommandOf('')).toBeNull();
  });
});
