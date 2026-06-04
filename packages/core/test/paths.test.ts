import { describe, expect, it } from 'vitest';
import { slugifyProject } from '../src/workspace/paths.js';

describe('slugifyProject — collapses a forge project path into one safe segment', () => {
  it('turns a single slash into a double underscore', () => {
    expect(slugifyProject('l4ci/maestro')).toBe('l4ci__maestro');
  });

  it('turns every slash into a double underscore', () => {
    expect(slugifyProject('group/sub/repo')).toBe('group__sub__repo');
  });

  it('strips characters outside [a-zA-Z0-9._-]', () => {
    expect(slugifyProject('a b/c!d')).toBe('ab__cd');
  });

  it('preserves dots, dashes, and underscores', () => {
    expect(slugifyProject('my.repo-name_1')).toBe('my.repo-name_1');
  });
});
