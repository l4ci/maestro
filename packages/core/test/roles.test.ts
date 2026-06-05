// Per-role prompt sections (#29 P1). Pure string-splitting unit — no I/O.

import { describe, expect, it } from 'vitest';
import { declaresRoles, promptForRole, roleBodies } from '../src/workflow/roles.js';

const ROLED = [
  'Shared conventions: pnpm, biome, atomic commits.',
  '',
  '## role: implement',
  'Execute the plan. Commit per step.',
  '',
  '## role: review',
  'Review the diff against the plan.',
].join('\n');

const LEGACY = '# Agent operating protocol\nwork the next item';

describe('roles (#29 P1)', () => {
  it('declaresRoles distinguishes roled bodies from legacy generalist ones', () => {
    expect(declaresRoles(ROLED)).toBe(true);
    expect(declaresRoles(LEGACY)).toBe(false);
  });

  it('splits sections and prepends the shared preamble to every role', () => {
    const bodies = roleBodies(ROLED);
    expect(bodies.get('implement')).toBe(
      'Shared conventions: pnpm, biome, atomic commits.\n\nExecute the plan. Commit per step.',
    );
    expect(bodies.get('review')).toContain('Shared conventions');
    expect(bodies.get('review')).toContain('Review the diff against the plan.');
    expect(bodies.has('define')).toBe(false); // undeclared roles are absent, not empty
  });

  it('promptForRole returns the section for declared roles', () => {
    expect(promptForRole(ROLED, 'implement')).toContain('Execute the plan');
    expect(promptForRole(ROLED, 'implement')).not.toContain('Review the diff');
  });

  it('legacy body → whole body for every role (zero behavior change)', () => {
    expect(promptForRole(LEGACY, 'implement')).toBe(LEGACY);
    expect(promptForRole(LEGACY, 'review')).toBe(LEGACY);
  });

  it('a declared-roles body missing THIS role falls back to the whole body', () => {
    expect(promptForRole(ROLED, 'define')).toBe(ROLED); // never an empty prompt
  });

  it('unknown role headings do not split — they stay inside the enclosing section', () => {
    const body = '## role: implement\nwork\n## role: dancer\nnot a role\nmore work';
    const bodies = roleBodies(body);
    expect(bodies.get('implement')).toContain('## role: dancer');
    expect(bodies.get('implement')).toContain('more work');
  });

  it('heading match is case-insensitive and whitespace-tolerant', () => {
    const body = '##  ROLE:  Implement\nwork';
    expect(declaresRoles(body)).toBe(true);
    expect(roleBodies(body).get('implement')).toBe('work');
  });
});
